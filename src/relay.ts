import type { AppConfig } from "./config.js";
import { AuditLog } from "./audit.js";
import { BridgeServer } from "./bridge-server.js";
import {
  ensureTaskId,
  parseRelayEnvelope,
  readRelayIntent,
  wrapWorkBuddyResult,
  type RelayIntent,
} from "./protocol.js";
import {
  formatDuration,
  formatHeartbeat,
  heartbeatAgeMs,
  isHeartbeatStale,
  shouldWarnHeartbeat,
} from "./heartbeat.js";
import { RelayStore } from "./store.js";
import type { ExtensionInbound, PendingItem, WorkBuddyMessage } from "./types.js";
import { browserFingerprint, isoNow, makeId } from "./utils.js";
import { WorkBuddyClient } from "./workbuddy.js";
import {
  AVAILABLE_DETECTION,
  quotaBlockUntil,
  type QuotaDetection,
} from "./workbuddy/quota.js";
import type { ModelRouter } from "./model-router/router.js";
import type { ModelUnavailableReason, ModelSelection } from "./model-router/types.js";
import {
  decideDispatch,
  dispatchIdFor,
  type DispatchDecision,
  ReconciliationService,
  TaskLedger,
  taskFingerprint,
} from "./reconciliation/index.js";

/**
 * One routed turn: the model the router picked for this task. Kept next to
 * the task lifecycle so every exit path can release the pin.
 */
type RoutedModel = {
  id: string;
  label: string;
};

/**
 * Thrown when a turn stops on purpose: the fallback chain ran out and the
 * task was already handed back to the queue. It is not a failure of the send,
 * so it must not be requeued a second time.
 */
class NoUsableModelError extends Error {}

/**
 * The WAIT_GPT lease. One round at a time owns it; the timer is what frees a
 * delivered RESULT that nobody ever acknowledges.
 */
type ResultLease = {
  taskId: string;
  timer: ReturnType<typeof setTimeout>;
};

export class ZhixingRelay {
  private workAbort: AbortController | null = null;
  private resultLease: ResultLease | null = null;
  /** Attempts already spent on one taskId, so a retry has a number. */
  private taskAttempts = new Map<string, number>();

  /** Lifecycle facts the heartbeat and `status` both report. */
  private startedAt = Date.now();
  private lastHeartbeatAt: number | null = null;
  private lastTaskAt: number | null = null;
  private bridgeSince: number | null = null;
  /** Last WorkBuddy liveness probe, null until the first one ran. */
  private workbuddyUp: boolean | null = null;
  /**
   * The task ledger and the reconciliation that reads it. Null when the relay
   * has no configured data path: then nothing is recorded and no decision is
   * made, because evidence nobody will read must not block a live round.
   */
  private readonly reconciliation: ReconciliationService | null;
  /** Reconciliation found a chain that must not be auto-sent any more. */
  private reconciliationHold = false;
  /** Answers to `fetch_recent_assistant_messages`, keyed by request id. */
  private recentMessageWaiters = new Map<
    string,
    (messages: { id: string; fingerprint: string; text: string }[]) => void
  >();
  private heartbeatWarned = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly bridge: BridgeServer,
    private readonly store: RelayStore,
    private readonly audit: AuditLog,
    private readonly workbuddy: WorkBuddyClient,
    /**
     * Optional so a relay can still run without routing. When absent every
     * turn goes to whatever model WorkBuddy already shows.
     */
    private readonly router: ModelRouter | null = null,
  ) {
    const ledgerPath = this.config.paths?.ledger;
    this.reconciliation = ledgerPath
      ? new ReconciliationService(new TaskLedger(ledgerPath))
      : null;
  }

  async init(): Promise<void> {
    const loaded = await this.store.load();
    await this.workbuddy.init();

    // Never guess after a process crash/restart. If a round was in flight,
    // pause and require the user to inspect/stop/resume deliberately rather
    // than accidentally duplicating a WorkBuddy task.
    if (loaded.currentTask) {
      await this.store.mutate((state) => {
        state.paused = true;
        state.state = "PAUSED";
      });
      await this.audit.write("startup_recovery_required", {
        taskId: loaded.currentTask.taskId,
        previousStatus: loaded.currentTask.status,
      });
      console.log(
        `[relay] Recovery required for previous task ${loaded.currentTask.taskId}; relay starts PAUSED`,
      );
    }

    this.bridge.onMessage((message) => this.onExtensionMessage(message));

    // The ledger is checked once at start-up: a restart that left a task
    // half-way is exactly the case a reconciliation pass exists to describe.
    await this.runReconciliation("startup");
  }

  /**
   * Probes WorkBuddy and remembers the answer.
   *
   * The result is kept because `status()` and the heartbeat have to report
   * the liveness synchronously: an HTTP caller must not force the process to
   * open another CDP connection to ask a question it can already answer.
   */
  async workbuddyOnline(): Promise<boolean> {
    const online = await this.workbuddy.online();
    this.workbuddyUp = online;
    return online;
  }

  status() {
    const snapshot = this.store.snapshot();
    const now = Date.now();
    const bridgeUp = this.bridge.hasClient();

    return {
      ...snapshot,
      bridgeConnected: bridgeUp,
      /** Last known WorkBuddy liveness, false until a probe says otherwise. */
      workbuddy: this.workbuddyUp === true,
      uptimeMs: now - this.startedAt,
      uptime: formatDuration(now - this.startedAt),
      lastHeartbeatAt:
        this.lastHeartbeatAt === null ? null : new Date(this.lastHeartbeatAt).toISOString(),
      lastHeartbeatAgeMs: heartbeatAgeMs(this.lastHeartbeatAt, now),
      heartbeatMs: this.heartbeatMs(),
      heartbeatStaleMs: this.heartbeatStaleMs(),
      heartbeatStale: isHeartbeatStale({
        lastHeartbeatAt: this.lastHeartbeatAt,
        startedAt: this.startedAt,
        now,
        maxAgeMs: this.heartbeatStaleMs(),
      }),
      /** How long the ChatGPT bridge has been up, null when it never was. */
      bridgeAgeMs: bridgeUp
        ? now - (this.bridgeSince ?? this.startedAt)
        : null,
      lastTaskAt: this.lastTaskAt === null ? null : new Date(this.lastTaskAt).toISOString(),
      lastTaskAgeMs: this.lastTaskAt === null ? null : Math.max(0, now - this.lastTaskAt),
    };
  }

  /** HEARTBEAT_MS, how often the relay proves it is still running. */
  private heartbeatMs(): number {
    const configured = this.config.relay?.heartbeatMs;
    return typeof configured === "number" && configured > 0
      ? configured
      : 30_000;
  }

  /** HEARTBEAT_STALE_MS, when a missing heartbeat is treated as a fault. */
  private heartbeatStaleMs(): number {
    const configured = this.config.relay?.heartbeatStaleMs;
    return typeof configured === "number" && configured > 0
      ? configured
      : 60_000;
  }

  /**
   * Starts the heartbeat and its watchdog.
   *
   * Deliberately not part of init(): a relay that is only used for one call
   * should not keep a timer alive, and a test must not inherit a ticking
   * process.
   */
  startHeartbeat(): void {
    this.stopHeartbeat();

    const beat = () => {
      this.emitHeartbeat();
    };

    this.heartbeatTimer = setInterval(beat, this.heartbeatMs());
    this.heartbeatTimer.unref?.();

    // Ticks more often than it speaks, so the warning lands right after the
    // window closes rather than a whole interval late.
    this.watchdogTimer = setInterval(() => this.runWatchdog(), 5_000);
    this.watchdogTimer.unref?.();

    this.emitHeartbeat();
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.heartbeatTimer = null;
    this.watchdogTimer = null;
  }

  /** One heartbeat, printed and returned so it can also be asked for. */
  emitHeartbeat(): string {
    const snapshot = this.store.snapshot();
    const now = Date.now();

    this.lastHeartbeatAt = now;
    this.heartbeatWarned = false;

    const block = formatHeartbeat(now, {
      startedAt: this.startedAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      state: snapshot.state,
      paused: snapshot.paused,
      currentTask: snapshot.currentTask?.taskId ?? null,
      bridge: this.bridge.hasClient(),
      /** Null-safe: a relay that never probed still reports the link as up. */
      workbuddy: this.workbuddyUp ?? true,
      pending: snapshot.pending.length,
    });

    console.log(block);

    return block;
  }

  /**
   * The watchdog. A missed beat means the event loop is stuck or the
   * terminal froze: nothing can unstick it, so it must be loud.
   */
  private async runWatchdog(): Promise<void> {
    const now = Date.now();
    const stale = isHeartbeatStale({
      lastHeartbeatAt: this.lastHeartbeatAt,
      startedAt: this.startedAt,
      now,
      maxAgeMs: this.heartbeatStaleMs(),
    });

    if (!stale) {
      this.heartbeatWarned = false;
      return;
    }

    if (!shouldWarnHeartbeat({ stale, wasWarned: this.heartbeatWarned })) return;

    this.heartbeatWarned = true;

    await this.audit.write("heartbeat_stale", {
      lastHeartbeatAt: this.lastHeartbeatAt === null ? null : new Date(this.lastHeartbeatAt).toISOString(),
      now: new Date(now).toISOString(),
      staleAfterMs: this.heartbeatStaleMs(),
    });

    console.error(
      `[relay] HEARTBEAT STALE: no ${this.heartbeatMs()}ms heartbeat for over ${this.heartbeatStaleMs()}ms. ` +
        "The event loop is wedged or the console is frozen (Windows Quick Edit); a keystroke usually unsticks it.",
    );
  }

  /** Marks a round as having touched a task, so `status` can show idleness. */
  private noteTaskActivity(): void {
    this.lastTaskAt = Date.now();
  }

  /**
   * Remembered when the ChatGPT bridge comes back, so a reconnect age can be
   * reported instead of a lifetime uptime.
   */
  private noteBridgeTraffic(): void {
    if (this.bridge.hasClient() && this.bridgeSince === null) {
      this.bridgeSince = Date.now();
    }
  }

  /**
   * A one-line-per-fact summary of how this process was configured, printed
   * once at startup so a bad configuration is visible without a task.
   */
  startupDiagnostics(): string[] {
    const snapshot = this.store.snapshot();
    const relayCfg = this.config.relay;

    const lines = [
      `[relay] startup diagnostics`,
      `  node=${process.version} pid=${process.pid} platform=${process.platform}`,
      `  bridge=ws://${relayCfg?.host ?? "127.0.0.1"}:${relayCfg?.port ?? 8787}`,
      `  forward=${relayCfg?.gptForwardMode ?? "tagged"} autoSend=${relayCfg?.autoSendToChatGPT ? "true" : "false"} pauseOnManual=${relayCfg?.pauseOnManualUserMessage ? "true" : "false"}`,
      `  resultLeaseMs=${this.resultLeaseMs()} maxTaskRetries=${this.maxTaskRetries()}`,
      `  heartbeat=${this.heartbeatMs()}ms staleAfter=${this.heartbeatStaleMs()}ms`,
      `  loadedFrom: state=${snapshot.state} paused=${snapshot.paused ? "true" : "false"} pending=${snapshot.pending.length} currentTask=${snapshot.currentTask?.taskId ?? "null"}`,
    ];

    return lines;
  }

  /**
   * Graceful restart hand-off.
   *
   * Restarting the relay is the one operation that can cut the link between
   * ChatGPT and WorkBuddy, so it refuses while a round is in flight and it
   * reports what an operator has to do instead of quietly killing anything.
   */
  async requestRestart(reason: string): Promise<{ ok: boolean; message: string }> {
    const snapshot = this.store.snapshot();

    if (snapshot.currentTask) {
      return {
        ok: false,
        message:
          `refusing to restart while task ${snapshot.currentTask.taskId} is in flight ` +
          "(status=" + snapshot.currentTask.status + "). Stop the round first (`s`), then restart.",
      };
    }

    if (snapshot.paused) {
      return {
        ok: false,
        message: "refusing to restart while the relay is PAUSED. Resume (`r`) or stop the round (`s`) first.",
      };
    }

    this.stopHeartbeat();
    await this.bridge.close();

    await this.audit.write("relay_restart_requested", {
      reason,
      uptimeMs: Date.now() - this.startedAt,
      pending: snapshot.pending.length,
    });

    return {
      ok: true,
      message:
        "graceful restart prepared: bridge closed and audit written, the process can now be " +
        "started again with `pnpm start`. Never kill the process while the extension is connected.",
    };
  }

  async pause(reason = "manual"): Promise<void> {
    await this.store.mutate((state) => {
      state.paused = true;
      state.state = "PAUSED";
    });
    await this.audit.write("relay_paused", { reason });
    console.log(`[relay] PAUSED (${reason})`);
  }

  async resume(): Promise<void> {
    const before = this.store.snapshot();

    await this.store.mutate((state) => {
      state.paused = false;

      if (!state.currentTask) {
        state.state = "IDLE";
      } else if (state.currentTask.status === "sent_to_gpt") {
        state.state = "WAIT_GPT";
      } else if (state.currentTask.status === "result_pending") {
        state.state = "IDLE";
      } else {
        state.state = "WAIT_WORKBUDDY";
      }
    });

    await this.audit.write("relay_resumed");
    console.log("[relay] RESUMED");

    const task = before.currentTask;
    if (
      task?.status === "waiting_workbuddy" &&
      task.workbuddyOutboundMessageId &&
      !this.workAbort
    ) {
      void this.resumeWorkBuddyWait(
        task.taskId,
        task.workbuddyOutboundMessageId,
        task.modelId,
      );
      return;
    }

    await this.flushOnePending();
  }

  async stopCurrentRound(reason = "manual"): Promise<void> {
    this.workAbort?.abort();
    this.workAbort = null;
    this.clearResultLease();

    const snapshot = this.store.snapshot();

    await this.store.mutate((state) => {
      state.currentTask = null;
      state.state = state.paused ? "PAUSED" : "IDLE";
    });

    await this.audit.write("round_stopped", {
      reason,
      taskId: snapshot.currentTask?.taskId || null,
      note: "This stops Relay forwarding only. It cannot cancel a WorkBuddy task already running.",
    });

    console.log(
      "[relay] Current relay round stopped. A WorkBuddy task already running may continue on its own.",
    );
  }

  async emergencyStop(): Promise<void> {
    await this.pause("emergency");
    await this.stopCurrentRound("emergency");
    this.stopHeartbeat();
    await this.bridge.close();
    await this.audit.write("relay_emergency_stop");
  }

  async sendManualToWorkBuddy(text: string): Promise<void> {

    console.log(
        "[Relay] sendManualToWorkBuddy:",
        text
    );

    const fp = makeId("manual");

    console.log(
        "[Relay] task id:",
        fp
    );

    await this.startWorkBuddyTask(text, fp);
  }
  async stageManualToChatGPT(text: string, autoSend = false): Promise<void> {
    const requestId = makeId("manual-gpt");
    await this.expectInjectedText(text);
    await this.bridge.send({
      type: "send_to_chatgpt",
      requestId,
      text,
      autoSend,
    });
  }

  private async onExtensionMessage(message: ExtensionInbound): Promise<void> {
    // An incoming message is a chance to release a lease that a restart left
    // behind, even when the timer is not running any more.
    await this.checkResultLease();
    this.noteBridgeTraffic();

    switch (message.type) {
      case "recent_assistant_messages":
        this.resolveRecentMessageRequest(message);
        return;
      case "bridge_hello":
        await this.audit.write("bridge_connected", {
          source: message.source || "unknown",
        });
        console.log("[bridge] Chrome extension connected");
        if (!this.store.snapshot().paused) {
          await this.flushOnePending();
        }
        return;

      case "chatgpt_page_ready":
        await this.audit.write("chatgpt_page_ready", {
          title: message.title || "",
          pageUrl: message.pageUrl || "",
          tabId: message.tabId || null,
        });
        return;

      case "chatgpt_send_result":
        await this.audit.write("chatgpt_send_result", {
          requestId: message.requestId || null,
          ok: message.ok,
          sent: message.sent || false,
          staged: message.staged || false,
          error: message.error || null,
        });

        if (message.ok) {
          /*
           * The extension confirms the RESULT reached ChatGPT's composer.
           * Releasing here closes the round as soon as the delivery is real
           * instead of waiting for the lease; the record is already gone when
           * only the lease could confirm it.
           */
          const snapshot = this.store.snapshot();
          if (snapshot.currentTask?.status === "sent_to_gpt") {
            const released = await this.completeCurrentRound(
              snapshot.currentTask.taskId,
              "gpt_send_confirmed",
            );

            if (released) {
              await this.flushOnePending();
            }
          }
        }
        return;

      case "chatgpt_user_message":
        await this.onChatGPTUserMessage(message);
        return;

      case "chatgpt_assistant_message":
        await this.onChatGPTAssistantMessage(message);
        return;
    }
  }

  private async onChatGPTUserMessage(message: Extract<ExtensionInbound, { type: "chatgpt_user_message" }>): Promise<void> {
    const envelope = parseRelayEnvelope(message.text);

    /*
     * A RESULT envelope seen in the ChatGPT thread is a completion signal:
     * either Relay's own delivery coming back to the page, or a human
     * pasting the RESULT by hand. Both mean the round is over.
     */
    if (envelope?.type === "RESULT") {
      await this.store.markSeen(message.fingerprint);

      const current = this.store.snapshot().currentTask;
      const taskId = envelope.taskId ?? current?.taskId ?? null;

      await this.audit.write("result_observed_in_chatgpt", {
        taskId: taskId ?? null,
        taskIdHeader: envelope.taskId,
        injected: await this.store.consumeExpectedInjectedUser(message.fingerprint),
      });

      /*
       * A RESULT that names a different task belongs to an earlier round: it
       * must not close the round that is currently running.
       */
      if (taskId && (envelope.taskId === null || envelope.taskId === current?.taskId)) {
        const released = await this.completeCurrentRound(taskId, "manual_result");
        if (released) {
          await this.flushOnePending();
        }
      }

      /*
       * Whatever the RESULT was, it is Relay's own output arriving as a user
       * message now, so it must never be mistaken for human chatter and pause
       * the relay.
       */
      return;
    }

    if (this.store.hasSeen(message.fingerprint)) return;
    await this.store.markSeen(message.fingerprint);

    const injected = await this.store.consumeExpectedInjectedUser(message.fingerprint);

    await this.audit.write("chatgpt_user_message", {
      fingerprint: message.fingerprint,
      injectedByRelay: injected,
      length: message.text.length,
    });

    if (injected) return;

    if (this.config.relay.pauseOnManualUserMessage) {
      await this.pause("manual_user_message");
    }
  }

  private async onChatGPTAssistantMessage(
    message: Extract<ExtensionInbound, { type: "chatgpt_assistant_message" }>,
  ): Promise<void> {
    if (this.store.hasSeen(message.fingerprint)) return;
    await this.store.markSeen(message.fingerprint);

    await this.audit.write("chatgpt_assistant_message", {
      fingerprint: message.fingerprint,
      length: message.text.length,
    });

    /*
     * Only a well-formed TASK envelope is work. Whatever the GPT side said
     * around it - the analysis, the closing remark - is addressed to the human,
     * and typing it into WorkBuddy would spend a turn on prose. Everything that
     * is not a TASK also has to stay inert: no pending, no pause, nothing sent.
     */
    const intent = readRelayIntent(message.text);

    if (intent.kind !== "task") {
      await this.noteNonTaskAssistantReply(intent);
      return;
    }

    const task = intent.task.block ?? message.text;

    if (task !== message.text) {
      console.log(
        `[relay] forwarded the [ZHIXING_RELAY] block only: ` +
          `${message.text.length} chars in, ${task.length} out, ` +
          `${message.text.length - task.length} chars of prose dropped`,
      );
    }

    if (intent.task.legacy) {
      console.log("[relay] relay task has no [ZHIXING_RELAY_END]; using the legacy envelope");
    }

    let snapshot = this.store.snapshot();

    // A tagged GPT TASK received while WAIT_GPT closes the previous round
    // and becomes the next WorkBuddy turn. Without this transition the new
    // task would remain queued forever behind the completed currentTask.
    if (
      snapshot.currentTask?.status === "sent_to_gpt" &&
      snapshot.state === "WAIT_GPT"
    ) {
      const completedTaskId = snapshot.currentTask.taskId;
      await this.store.mutate((state) => {
        state.currentTask = null;
        state.state = state.paused ? "PAUSED" : "IDLE";
      });
      await this.audit.write("round_completed", { taskId: completedTaskId });
      snapshot = this.store.snapshot();
    }

    if (snapshot.paused) {
      await this.store.enqueue({
        kind: "gpt_task",
        id: makeId("pending-gpt"),
        text: task,
        fingerprint: message.fingerprint,
        createdAt: isoNow(),
      });
      console.log("[relay] GPT task queued because relay is paused");
      return;
    }

    if (snapshot.currentTask) {
      await this.store.enqueue({
        kind: "gpt_task",
        id: makeId("pending-gpt"),
        text: task,
        fingerprint: message.fingerprint,
        createdAt: isoNow(),
      });
      console.log("[relay] GPT task queued because another task is active");
      return;
    }

    await this.startWorkBuddyTask(task, message.fingerprint);
  }

  /** A machine-readable reason for a reply that carried nothing to do. */
  /**
   * Hands the answer to `fetch_recent_assistant_messages` to whoever asked.
   *
   * The messages arrive as the page's facts; deciding what they mean is not
   * this method's business.
   */
  private resolveRecentMessageRequest(message: Extract<ExtensionInbound, { type: "recent_assistant_messages" }>): void {
    const waiter = this.recentMessageWaiters.get(message.requestId);
    if (!waiter) return;
    this.recentMessageWaiters.delete(message.requestId);
    waiter(
      (message.messages ?? []).map((item) => ({
        id: item.id,
        fingerprint: item.fingerprint,
        text: item.text,
      })),
    );
  }

  private static intentReason(intent: RelayIntent): string {
    if (intent.kind === "ambiguous") return `ambiguous:${intent.count}_blocks`;
    if (intent.kind === "ignored") return intent.reason;
    return intent.kind === "result" ? "type_result" : "type_task";
  }

  /**
   * Reports - and records, for later - a ChatGPT reply that is not a TASK.
   *
   * The log line is the only observable of this path, so it says which way the
   * message was ruled out: no envelope at all, an envelope that is not a task,
   * or a message that cannot be read unambiguously.
   */
  private async noteNonTaskAssistantReply(intent: RelayIntent): Promise<void> {
    await this.audit.write("gpt_reply_not_dispatched", {
      reason: ZhixingRelay.intentReason(intent),
    });

    const reason = ZhixingRelay.intentReason(intent);

    if (intent.kind === "ambiguous") {
      console.log(
        `[relay] GPT reply ignored: ${intent.count} closed relay blocks in one ` +
          `message; refusing to guess which one is the task`,
      );
      return;
    }

    if (intent.kind === "ignored" && intent.reason === "no_block") {
      console.log("[relay] GPT reply observed, but no relay task");
      return;
    }

    console.log(
      `[relay] GPT reply observed, but not marked as a relay TASK (reason=${reason})`,
    );
  }

  private async startWorkBuddyTask(text: string, sourceFingerprint: string): Promise<void> {
    this.noteTaskActivity();
    console.log("[Relay] startWorkBuddyTask BEGIN");

  const snapshot = this.store.snapshot();

  console.log("[Relay] snapshot OK");

    if (snapshot.paused) {
      await this.store.enqueue({
        kind: "gpt_task",
        id: makeId("pending-gpt"),
        text,
        fingerprint: sourceFingerprint,
        createdAt: isoNow(),
      });
      return;
    }

    const taskId = ensureTaskId(text, makeId("task"));
    const fingerprint = taskFingerprint(text);

    /*
     * Identity first, WorkBuddy second. From here the ledger decides whether
     * this task may be sent, so a task that already ran - or that contradicts
     * an earlier envelope of the same name - stops here instead of going out
     * a second time.
     */
    const plan = await this.publishTask({
      taskId,
      fingerprint,
      messageFingerprint: sourceFingerprint,
    });
    if (!plan) return;

    /*
     * A task may name the model that has to run it. Kept as the raw header
     * value here: whether it names something real is the router's call, and an
     * unknown name must degrade to normal routing rather than throw at the
     * GPT boundary.
     */
    const requestedModelId = parseRelayEnvelope(text)?.model ?? null;

    /*
     * Routing happens BEFORE WorkBuddy receives anything. Once  the task text
     * is typed into the composer there is no clean way back, so this is the
     * last moment at which "no usable model" can still mean "don't start".
     */
    let routed: RoutedModel | null = null;

    if (this.router) {
      let selection: ModelSelection;

      try {
        selection = this.router.selectModel({
          requestedModelId,
          now: new Date(),
        });
      } catch (error) {
        // A router that cannot even answer is not a reason to drop the task.
        await this.holdTaskForModelRecovery(taskId, text, sourceFingerprint, {
          nextResetAt: null,
          reasons: [],
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      if (selection.kind === "no_available_model") {
        await this.holdTaskForModelRecovery(taskId, text, sourceFingerprint, {
          nextResetAt: selection.nextResetAt,
          reasons: selection.reasons,
        });
        return;
      }

      routed = { id: selection.model.id, label: selection.model.label };
      this.router.pin(routed.id);

      await this.audit.write("model_routed", {
        taskId,
        requestedModelId,
        modelId: selection.model.id,
        modelLabel: selection.model.label,
        source: selection.source,
        fellBack: selection.fellBack,
      });

      if (selection.fellBack) {
        console.log(
          `[relay] requested ${selection.requestedModelId} could not run; routed task ${taskId} to ${selection.model.label}`,
        );
      } else if (
        requestedModelId !== null &&
        selection.requestedModelId === null
      ) {
        console.log(
          `[relay] requested model ${requestedModelId} is not in the catalog; routing ${taskId} by priority`,
        );
      }
    }

    if (this.reconciliation) {
      await this.reconciliation.recordDispatch({
        taskId,
        taskFingerprint: fingerprint,
        dispatchId: plan.dispatchId,
        attempt: plan.attempt,
        model: routed?.id ?? null,
      });
    }

    try {
      const online = await this.workbuddy.online();
      if (!online) {
        throw new Error("WorkBuddy local assistant is offline");
      }

      const outcome = await this.runTurnWithQuotaRecovery({
        taskId,
        text,
        sourceFingerprint,
        requestedModelId,
        routed,
        dispatchId: plan.dispatchId,
        taskFingerprint: fingerprint,
        attempt: plan.attempt,
        signal: this.workAbort?.signal,
        onProgress: async (message) => {
          await this.audit.write("workbuddy_assistant_chunk", {
            taskId,
            messageId: message.message_id,
            msgType: message.msg_type,
          });
        },
      });

      await this.onWorkBuddyResult(taskId, outcome.lastMessageId, outcome.body);
    } catch (error) {
      this.workAbort = null;
      const detail = error instanceof Error ? error.message : String(error);

      /*
       * The chain already ran out: the task is in the queue with its
       * model_no_available record, so requeuing here would duplicate it.
       */
      const noUsableModel = error instanceof NoUsableModelError;

      if (noUsableModel) {
        await this.audit.write("workbuddy_turn_abandoned", {
          taskId,
          error: detail,
        });
      } else {
        await this.audit.write("workbuddy_turn_failed", {
          taskId,
          error: detail,
        });

        console.error(`[relay] WorkBuddy turn failed: ${detail}`);

        // A cancelled or failed turn is not a lost task: it goes back to the
        // queue carrying the reason, and the pin is released below.
        await this.requeueTask({
          taskId,
          text,
          sourceFingerprint,
          reason: detail,
          detail,
        });
      }

      await this.store.mutate((state) => {
        state.currentTask = null;
        state.state = state.paused ? "PAUSED" : "IDLE";
      });
    } finally {
      /*
       * Whatever happened - send failure, CDP drop, a real cancellation or a
       * completion wait error - the task is over, so its claim on the model
       * ends here. Releasing in `finally` is what keeps a failed turn from
       * pinning the router forever.
       */
      this.router?.releasePin();
    }
  }

  /**
   * One task turn, as a loop.
   *
   * WorkBuddy can answer that the model just used has run out of quota. In
   * that case this blocks the model until its reset instant, drops its pin,
   * asks the router for the next usable model and sends the SAME text again
   * under the SAME taskId - a retry of this task, never a new one. The loop is
   * bounded, so a model that keeps answering "exhausted" cannot spin.
   *
   * Shared by the fresh send path and the post-restart recovery path, because
   * both can hit a quota and neither may report it as a plain failure.
   */
  private async runTurnWithQuotaRecovery(args: {
    taskId: string;
    text: string;
    sourceFingerprint: string;
    /** Identity of this send, so the evidence events can name it. */
    dispatchId?: string | undefined;
    taskFingerprint?: string | undefined;
    attempt?: number | undefined;
    requestedModelId: string | null;
    routed: RoutedModel | null;
    signal?: AbortSignal | undefined;
    onProgress?: ((message: WorkBuddyMessage) => Promise<void>) | undefined;
    /**
     * Set when the message is already in WorkBuddy (a turn resumed after a
     * restart). The first attempt then waits for THAT message instead of
     * sending the text a second time - resending would duplicate the user's
     * request. Only a quota retry sends again.
     */
    resumeOutboundId?: string | null | undefined;
  }): Promise<{ lastMessageId: string; body: string }> {
    const { taskId, text, routed } = args;
    let current = routed;
    let attempt = 0;
    let resumedId = args.resumeOutboundId ?? null;

    while (true) {
      if (resumedId !== null) {
        /*
         * Recovered turn: the message is already queued, so only the wait
         * runs. Nothing is re-applied - the model of the in-flight turn is
         * the one already selected.
         */
        this.workAbort = new AbortController();

        const recovered = await this.workbuddy.waitForAssistantReply(resumedId, {
          signal: args.signal ?? this.workAbort.signal,
          ...(args.onProgress ? { onProgress: args.onProgress } : {}),
        });

        this.workAbort = null;
        resumedId = null;

        if (!recovered.text) {
          throw new Error("WorkBuddy returned an empty assistant response");
        }

        const previous = current;
        const quota = previous
          ? await this.detectQuotaForTask(taskId, previous)
          : AVAILABLE_DETECTION;

        if (
          quota.status === "quota_exhausted" &&
          attempt < this.quotaRetryLimit()
        ) {
          attempt += 1;

          const next = previous
            ? await this.recoverFromQuota({
                taskId,
                text,
                sourceFingerprint: args.sourceFingerprint,
                requestedModelId: args.requestedModelId,
                routed: previous,
                quota,
                attempt,
              })
            : null;

          if (!next) break;
          current = next;
          continue;
        }

        return { lastMessageId: recovered.lastMessageId, body: recovered.text };
      }

      // Normal send: apply the routed model BEFORE the text can be typed.
      await this.store.mutate((state) => {
        state.state = "WAIT_WORKBUDDY";
        state.currentTask = {
          taskId,
          sourceFingerprint: args.sourceFingerprint,
          sourceText: text,
          startedAt: state.currentTask?.startedAt ?? isoNow(),
          status: "sending",
          ...(current ? { modelId: current.id, modelLabel: current.label } : {}),
        };
      });

      await this.audit.write("workbuddy_send_start", {
        taskId,
        textLength: text.length,
        ...(current ? { modelId: current.id, modelLabel: current.label } : {}),
      });

      // Apply the routed model and only then hand over the task text.
      if (current) {
        await this.applyRoutedModel(taskId, current);
      }

      const outboundId = await this.workbuddy.sendText(text);

      /*
       * The moment this resolves the task is on its way into WorkBuddy, and a
       * retry is no longer provably safe. That is exactly why the evidence is
       * written here rather than after the wait.
       */
      await this.recordEvidence({
        event: "SEND_CONFIRMED",
        taskId,
        taskFingerprint: args.taskFingerprint ?? "",
        dispatchId: args.dispatchId ?? "",
        attempt: args.attempt ?? 0,
        workbuddyMessageId: outboundId,
      });

      await this.store.mutate((state) => {
        if (!state.currentTask || state.currentTask.taskId !== taskId) return;
        state.currentTask.workbuddyOutboundMessageId = outboundId;
        state.currentTask.status = "waiting_workbuddy";
        state.state = "WAIT_WORKBUDDY";
      });

      await this.audit.write("workbuddy_message_sent", {
        taskId,
        workbuddyMessageId: outboundId,
      });

      console.log(`[relay] GPT -> WorkBuddy task=${taskId} message=${outboundId}`);

      this.workAbort = new AbortController();

      const result = await this.workbuddy.waitForAssistantReply(outboundId, {
        signal: args.signal ?? this.workAbort.signal,
        ...(args.onProgress ? { onProgress: args.onProgress } : {}),
      });

      this.workAbort = null;

      /*
       * Output means the turn really ran. Whether or not it finishes is not
       * known yet, and that is the one thing that must never be guessed at.
       */
      await this.recordEvidence({
        event: "RUNNING_CONFIRMED",
        taskId,
        taskFingerprint: args.taskFingerprint ?? "",
        dispatchId: args.dispatchId ?? "",
        attempt: args.attempt ?? 0,
        workbuddyMessageId: outboundId,
      });

      if (!result.text) {
        throw new Error("WorkBuddy returned an empty assistant response");
      }

      /*
       * Quota gate. Only a routed model can be exhausted in a way we know
       * about, and only while retries remain: enough attempts to cross a real
       * fallback chain, never enough to re-send forever.
       */
      const previous = current;
      const quota = previous
        ? await this.detectQuotaForTask(taskId, previous)
        : AVAILABLE_DETECTION;

      if (
        quota.status === "quota_exhausted" &&
        attempt < this.quotaRetryLimit()
      ) {
        attempt += 1;

        const next = previous
          ? await this.recoverFromQuota({
              taskId,
              text,
              sourceFingerprint: args.sourceFingerprint,
              requestedModelId: args.requestedModelId,
              routed: previous,
              quota,
              attempt,
            })
          : null;

        // No usable fallback left: the task stays queued, nothing re-sent.
        if (!next) break;
        current = next;
        continue;
      }

      return { lastMessageId: result.lastMessageId, body: result.text };
    }

    // Only reachable when the fallback chain ran out; nothing was sent.
    throw new NoUsableModelError(
      `WorkBuddy turn for ${taskId} ended without a usable model`,
    );
  }

  /**
   * Applies the routed model to the real WorkBuddy UI and waits for the UI to
   * confirm, before a single character of the task is sent.
   */
  private async applyRoutedModel(taskId: string, routed: RoutedModel): Promise<void> {
    const before = await this.workbuddy.getCurrentModel().catch(() => null);

    if (before === routed.label) {
      await this.audit.write("model_already_active", {
        taskId,
        modelId: routed.id,
        modelLabel: routed.label,
      });
      return;
    }

    await this.workbuddy.selectModel(routed.label);

    await this.audit.write("model_selected", {
      taskId,
      modelId: routed.id,
      modelLabel: routed.label,
      previousModel: before,
    });

    console.log(
      `[relay] model=${routed.label} selected for task=${taskId}${before ? ` (was ${before})` : ""}`,
    );
  }

  /**
   * Reads WorkBuddy's quota state for the model that just ran.
   *
   * A failure to probe is never a quota: an unreadable page must not send a
   * perfectly good task down a retry path (and must not block a usable model).
   */
  private async detectQuotaForTask(
    taskId: string,
    routed: RoutedModel,
  ): Promise<QuotaDetection> {
    try {
      const detection = await this.workbuddy.detectQuota();

      await this.audit.write("workbuddy_quota_probe", {
        taskId,
        routedModelId: routed.id,
        status: detection.status,
        detectedModelLabel: detection.modelLabel,
        resetAt: detection.resetAt,
        source: detection.source,
        reason: detection.reason,
      });

      return detection;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.audit.write("workbuddy_quota_probe_failed", {
        taskId,
        routedModelId: routed.id,
        error: detail,
      });
      console.warn(
        `[relay] quota probe failed for task=${taskId} model=${routed.label}: ${detail}`,
      );
      return { ...AVAILABLE_DETECTION, modelLabel: routed.label };
    }
  }

  /**
   * One quota recovery step: block the exhausted model, drop its pin, and let
   * the router pick the next usable one for the same task.
   *
   * Returns the new routed model, or null when nothing is usable - in which
   * case the caller must stop without sending again and the task goes back to
   * the pending queue.
   */
  private async recoverFromQuota(args: {
    taskId: string;
    text: string;
    sourceFingerprint: string;
    requestedModelId: string | null;
    routed: RoutedModel;
    quota: QuotaDetection;
    attempt: number;
  }): Promise<RoutedModel | null> {
    const { taskId, routed, quota, attempt } = args;

    const blockedUntil = quotaBlockUntil(
      new Date(),
      quota.resetAt,
      this.quotaBlockMs(),
    ).toISOString();

    /*
     * The already-ran turn is over: this task is not "still running" on the
     * exhausted model any more, so the pin is dropped before the next
     * selection. Releasing after the block, never before, is what keeps the
     * in-flight turn on its model while the block is being written.
     */
    await this.router?.blockModel(
      routed.id,
      blockedUntil,
      `quota exhausted: ${quota.reason ?? routed.label}`,
    );
    this.router?.releasePin();

    await this.audit.write("model_quota_blocked", {
      taskId,
      modelId: routed.id,
      modelLabel: routed.label,
      blockedUntil,
      detectedModelLabel: quota.modelLabel,
      reason: quota.reason,
      retry: attempt,
    });

    console.warn(
      `[relay] ${routed.label} is quota exhausted for task=${taskId}; blocked until ${blockedUntil}`,
    );

    if (!this.router) return null;

    /*
     * This attempt is finished and the task is going back to the queue, so the
     * store must stop reserving it - otherwise "another task is active" would
     * hide the re-queued task behind its own stale currentTask.
     */
    const dropCurrent = async (): Promise<void> => {
      await this.store.mutate((state) => {
        if (state.currentTask?.taskId !== taskId) return;
        state.currentTask = null;
        state.state = state.paused ? "PAUSED" : "IDLE";
      });
    };

    let selection: ModelSelection;

    try {
      selection = this.router.selectModel({
        requestedModelId: args.requestedModelId,
        now: new Date(),
      });
    } catch (error) {
      await dropCurrent();
      await this.holdTaskForModelRecovery(taskId, args.text, args.sourceFingerprint, {
        nextResetAt: blockedUntil,
        reasons: [],
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }

    if (selection.kind === "no_available_model") {
      await dropCurrent();
      await this.holdTaskForModelRecovery(taskId, args.text, args.sourceFingerprint, {
        nextResetAt: selection.nextResetAt,
        reasons: selection.reasons,
      });
      return null;
    }

    const next: RoutedModel = {
      id: selection.model.id,
      label: selection.model.label,
    };

    this.router.pin(next.id);

    await this.audit.write("model_routed", {
      taskId,
      requestedModelId: args.requestedModelId,
      modelId: selection.model.id,
      modelLabel: selection.model.label,
      source: selection.source,
      fellBack: selection.fellBack,
      retried: true,
      retry: attempt,
      previousModelId: routed.id,
    });

    console.log(
      `[relay] retry ${attempt} for task=${taskId}: ${routed.label} exhausted -> ${selection.model.label}`,
    );

    return next;
  }

  /** Bounded, so an always-exhausted model cannot spin the turn. */
  private quotaRetryLimit(): number {
    const configured = this.config.modelRouter?.quotaRetries;
    return typeof configured === "number" && configured >= 0
      ? configured
      : 2;
  }

  /** Fallback block length when the notice carries no reset time. */
  private quotaBlockMs(): number {
    const configured = this.config.modelRouter?.quotaBlockMs;
    return typeof configured === "number" && configured > 0
      ? configured
      : 3_600_000;
  }

  /**
   * No model is usable right now. The task is kept, never sent, and never
   * silently handed to a blocked model - a future quota watcher can pick it
   * back up once something recovers.
   */
  private async holdTaskForModelRecovery(
    taskId: string,
    text: string,
    sourceFingerprint: string,
    detail: {
      nextResetAt: string | null;
      reasons: ModelUnavailableReason[];
      error?: string;
    },
  ): Promise<void> {
    await this.store.enqueue({
      kind: "gpt_task",
      id: makeId("pending-gpt"),
      text,
      fingerprint: sourceFingerprint,
      createdAt: isoNow(),
      taskId,
      reason: "no_available_model",
    });

    await this.audit.write("model_no_available", {
      taskId,
      nextResetAt: detail.nextResetAt,
      error: detail.error ?? null,
      reasons: detail.reasons.map((reason) => ({
        modelId: reason.modelId,
        label: reason.label,
        kind: reason.kind,
        blockedUntil: reason.blockedUntil,
        reason: reason.reason,
      })),
    });

    console.warn(
      `[relay] No model available for task=${taskId}; kept in queue, NOT sent to WorkBuddy. ` +
        `nextResetAt=${detail.nextResetAt ?? "unknown"}${detail.error ? ` (${detail.error})` : ""}`,
    );

    for (const reason of detail.reasons) {
      console.warn(
        `[relay]   unavailable: ${reason.label} (${reason.kind}) until ${reason.blockedUntil ?? "n/a"}${reason.reason ? ` - ${reason.reason}` : ""}`,
      );
    }
  }

  private async resumeWorkBuddyWait(
    taskId: string,
    outboundId: string,
    modelId?: string,
  ): Promise<void> {
    /*
     * The router's pin is memory-only, so it died with the previous process.
     * currentTask.modelId is what lets this recovered turn claim the same
     * model again, so another task cannot take over a higher-priority model
     * while this one is still finishing.
     */
    if (this.router && modelId) {
      try {
        this.router.pin(modelId);
      } catch {
        // The catalog changed under us; fall back to unrestricted selection.
        console.warn(
          `[relay] Cannot restore pin to "${modelId}" after restart; continuing without it`,
        );
      }
    }

    this.workAbort = new AbortController();

    await this.audit.write("workbuddy_wait_resumed", {
      taskId,
      workbuddyMessageId: outboundId,
      ...(modelId ? { modelId } : {}),
    });

    try {
      /*
       * A recovered turn can hit a quota exactly like a fresh one, so it goes
       * through the same retry loop. The router's memory-only pin died with
       * the previous process, so the routed model is rebuilt from what the
       * durable record still says the task was using.
       */
      let routed: RoutedModel | null = null;
      let text = "";
      let sourceFingerprint = "";

      if (this.router && modelId) {
        const entry = this.router
          .getSnapshot()
          .models.find((item) => item.model.id === modelId);
        if (entry) routed = { id: entry.model.id, label: entry.model.label };
      }

      const current = this.store.snapshot().currentTask;
      if (current?.sourceText) text = current.sourceText;
      if (current?.sourceFingerprint) sourceFingerprint = current.sourceFingerprint;

      const progress = async (message: WorkBuddyMessage): Promise<void> => {
        await this.audit.write("workbuddy_assistant_chunk", {
          taskId,
          messageId: message.message_id,
          msgType: message.msg_type,
        });
      };

      const outcome =
        routed && text
          ? await this.runTurnWithQuotaRecovery({
              taskId,
              text,
              sourceFingerprint,
              requestedModelId: parseRelayEnvelope(text)?.model ?? null,
              routed,
              /*
               * The message is already in WorkBuddy. Waiting for it instead of
               * sending it again is the whole point of this path: without
               * this stamp the recovered turn would type the task a second
               * time and WorkBuddy would answer it twice.
               */
              resumeOutboundId: outboundId,
              signal: this.workAbort?.signal,
              onProgress: progress,
            })
          : null;

      if (outcome) {
        /*
         * The loop already waited for this message - or, after a quota retry,
         * sent the text again and waited for that - so `outcome` IS the turn
         * result. Posting it here and waiting once more would send the same
         * answer to ChatGPT twice.
         */
        await this.onWorkBuddyResult(taskId, outcome.lastMessageId, outcome.body);
      } else {
        /*
         * Nothing durable to re-route from: the plain wait keeps working
         * exactly as it always did, and its result is the only one posted.
         */
        const result = await this.workbuddy.waitForAssistantReply(outboundId, {
          signal: this.workAbort?.signal,
          onProgress: progress,
        });

        this.workAbort = null;

        if (!result.text) {
          throw new Error("WorkBuddy returned an empty assistant response");
        }

        await this.onWorkBuddyResult(
          taskId,
          result.lastMessageId,
          result.text,
        );
      }
    } catch (error) {
      this.workAbort = null;

      const detail = error instanceof Error ? error.message : String(error);
      await this.audit.write("workbuddy_resumed_wait_failed", {
        taskId,
        error: detail,
      });
      console.error(`[relay] Resumed WorkBuddy wait failed: ${detail}`);
    } finally {
      this.router?.releasePin();
    }
  }

  /** Snapshot for future TUI / operators, without exposing router internals. */
  modelSnapshot(now?: Date) {
    return this.router?.getSnapshot(now ?? new Date()) ?? null;
  }

  private async onWorkBuddyResult(
    taskId: string,
    workbuddyMessageId: string,
    body: string,
  ): Promise<void> {
    const wrapped = wrapWorkBuddyResult({
      taskId,
      workbuddyMessageId,
      body,
    });

    await this.audit.write("workbuddy_result_ready", {
      taskId,
      workbuddyMessageId,
      length: wrapped.length,
    });

    const current = this.store.snapshot().currentTask;
    await this.recordEvidence({
      event: "RESULT_RECEIVED",
      taskId,
      taskFingerprint: current?.taskFingerprint ?? "*",
      dispatchId: current?.dispatchId ?? null,
      attempt: current?.attempt ?? null,
      workbuddyMessageId,
    });

    /*
     * The RESULT exists from this moment on, so the lease is armed now and
     * cleared by whichever path actually commits it. A send that never lands
     * must still not hold the task hostage.
     */
    this.armResultLease(taskId);

    const snapshot = this.store.snapshot();

    if (snapshot.paused || !this.bridge.hasClient()) {
      await this.queueWorkBuddyResult(
        taskId,
        workbuddyMessageId,
        wrapped,
        snapshot.paused ? "relay is paused" : "Chrome bridge is disconnected",
      );
      return;
    }

    try {
      await this.sendWorkBuddyResultToGPT(
        taskId,
        workbuddyMessageId,
        wrapped,
      );
    } catch (error) {
      await this.queueWorkBuddyResult(
        taskId,
        workbuddyMessageId,
        wrapped,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Ends a round whose RESULT is on its way to ChatGPT.
   *
   * Delivering the result does not wait for an acknowledgement: the next
   * task must not queue up behind a round that has already given its answer.
   * Returns false when the task was already gone, so callers can stay
   * idempotent.
   */
  private async completeCurrentRound(taskId: string, reason: string): Promise<boolean> {
    if (this.resultLease?.taskId === taskId) {
      this.clearResultLease();
    }

    const snapshot = this.store.snapshot();
    const task = snapshot.currentTask;

    if (!task || task.taskId !== taskId) return false;

    await this.store.mutate((state) => {
      if (state.currentTask?.taskId !== taskId) return;

      state.currentTask = null;

      if (state.state === "WAIT_GPT" || state.state === "WAIT_WORKBUDDY") {
        state.state = state.paused ? "PAUSED" : "IDLE";
      }
    });

    this.noteTaskActivity();

    await this.audit.write("round_completed", {
      taskId,
      releasedAt: isoNow(),
      reason,
    });

    await this.recordEvidence({
      event: "TASK_COMPLETED",
      taskId,
      taskFingerprint: task?.taskFingerprint ?? "*",
      dispatchId: task?.dispatchId ?? null,
      attempt: task?.attempt ?? null,
      workbuddyMessageId: task?.workbuddyOutboundMessageId ?? null,
      detail: { reason },
    });

    console.log(`[relay] round ${taskId} completed (${reason})`);

    return true;
  }

  /** RESULT_LEASE_MS, the longest a delivered-but-unacknowledged round may hold a task. */
  private resultLeaseMs(): number {
    const configured = this.config.relay?.resultLeaseMs;
    return typeof configured === "number" && configured > 0 ? configured : 120_000;
  }

  private armResultLease(taskId: string): void {
    this.clearResultLease();

    const timer = setTimeout(() => {
      void this.expireResultLease(taskId);
    }, this.resultLeaseMs());

    // A lease must never be the reason the process stays alive.
    timer.unref?.();

    this.resultLease = { taskId, timer };
  }

  private clearResultLease(): void {
    if (!this.resultLease) return;

    clearTimeout(this.resultLease.timer);
    this.resultLease = null;
  }

  /**
   * The lease ran out: the RESULT left the building and nobody confirmed it,
   * so the task record is released rather than kept forever.
   *
   * This drops bookkeeping only. The RESULT has either been delivered or sits
   * in the queue; neither is re-sent here.
   */
  private async expireResultLease(taskId: string): Promise<void> {
    const released = await this.completeCurrentRound(taskId, "result_lease_expired");

    if (!released) return;

    await this.audit.write("result_lease_expired", {
      taskId,
      leaseMs: this.resultLeaseMs(),
    });

    console.warn(
      `[relay] RESULT for ${taskId} was never acknowledged; released after ${this.resultLeaseMs()}ms`,
    );

    await this.flushOnePending();
  }

  /**
   * Releasing a stale WAIT_GPT task that a restart left behind, so it is also
   * caught when traffic arrives instead of only when the timer fires.
   */
  private async checkResultLease(): Promise<void> {
    const task = this.store.snapshot().currentTask;

    /*
     * Either the RESULT was forwarded and is still unacknowledged, or it is
     * queued and waiting for the bridge to come back. Both are held by the
     * same lease.
     */
    if (!task) return;
    if (task.status !== "sent_to_gpt" && task.status !== "result_pending") return;
    if (!task.sentToGptAt) return;
    if (this.resultLease?.taskId === task.taskId) return;
    if (Date.now() - Date.parse(task.sentToGptAt) < this.resultLeaseMs()) return;

    await this.expireResultLease(task.taskId);
  }

  /**
   * A turn that WorkBuddy refused must not simply vanish: the task goes back
   * to the queue with the reason attached, so it can be seen and retried.
   */
  private async requeueTask(args: {
    taskId: string;
    text: string;
    sourceFingerprint: string;
    reason: string;
    detail: string;
  }): Promise<void> {
    const previous = this.taskAttempts.get(args.taskId) ?? 0;
    const retryCount = previous + 1;

    this.taskAttempts.set(args.taskId, retryCount);

    if (retryCount > this.maxTaskRetries()) {
      await this.audit.write("task_retry_exhausted", {
        taskId: args.taskId,
        attempts: retryCount - 1,
        reason: args.reason,
      });
      console.error(
        `[relay] task ${args.taskId} dropped after ${retryCount - 1} retries (${args.reason})`,
      );
      return;
    }

    await this.store.enqueue({
      kind: "gpt_task",
      id: makeId("pending-retry"),
      text: args.text,
      fingerprint: args.sourceFingerprint,
      createdAt: isoNow(),
      taskId: args.taskId,
      retryCount,
      reason: args.reason,
    });

    await this.audit.write("task_requeued", {
      taskId: args.taskId,
      retryCount,
      reason: args.reason,
      error: args.detail,
    });

    const requeued = this.store.snapshot().currentTask;
    await this.recordEvidence({
      event: "TASK_REQUEUED",
      taskId: args.taskId,
      taskFingerprint: requeued?.taskFingerprint ?? "*",
      attempt: requeued?.attempt ?? null,
      dispatchId: requeued?.dispatchId ?? null,
      detail: { retryCount, reason: args.reason },
    });

    console.warn(
      `[relay] task ${args.taskId} requeued (attempt ${retryCount}) after ${args.reason}`,
    );
  }

  /**
   * Publishes a task to the ledger and decides whether it may be sent.
   *
   * Returns null when the answer is "no". Every "no" here is a case where the
   * honest state of the world is unknown or contradictory, and unknown is the
   * one condition under which sending again is the worst option available:
   * a duplicate of a task that already ran cannot be undone.
   */
  private async publishTask(args: {
    taskId: string;
    fingerprint: string;
    messageFingerprint: string;
  }): Promise<{ dispatchId: string; attempt: number } | null> {
    if (!this.reconciliation) {
      // No ledger configured: the old behaviour, and no invented decision.
      return { dispatchId: dispatchIdFor(args.taskId, 0), attempt: 0 };
    }

    const published = await this.reconciliation.recordTaskPublished({
      taskId: args.taskId,
      taskFingerprint: args.fingerprint,
      messageFingerprint: args.messageFingerprint,
      source: "gpt",
    });

    if (published.status === "blocked") {
      await this.audit.write("reconciliation_blocked", {
        taskId: args.taskId,
        reason: "identity_conflict",
      });
      console.error(
        `[relay] task ${args.taskId} blocked: the same taskId was published before ` +
          `under a different envelope; nothing was sent`,
      );
      return null;
    }

    const history = await this.reconciliation.getTaskHistory(args.taskId);
    const decision = decideDispatch(history, {
      taskId: args.taskId,
      taskFingerprint: args.fingerprint,
      gptEvidence: await this.gptEvidenceFor(args.taskId, args.fingerprint),
      maxAttempts: this.maxTaskRetries(),
    });

    if (decision.kind === "blocked") {
      await this.reconciliation.recordExecutionEvidence({
        event: "TASK_BLOCKED",
        taskId: args.taskId,
        taskFingerprint: args.fingerprint,
        detail: { reason: decision.reason, detail: decision.detail },
      });
      await this.audit.write("reconciliation_blocked", {
        taskId: args.taskId,
        reason: decision.reason,
        detail: decision.detail,
      });
      console.error(`[relay] task ${args.taskId} not sent (${decision.reason}): ${decision.detail}`);
      return null;
    }

    return { dispatchId: decision.dispatchId, attempt: decision.attempt };
  }

  /**
   * Writes one execution-evidence event.
   *
   * The write is best-effort by design: the relay must not disappear because
   * a log file could not be opened, and a turn that already happened does not
   * stop happening because its evidence could not be stored.
   */
  private async recordEvidence(input: {
    event: Parameters<ReconciliationService["recordExecutionEvidence"]>[0]["event"];
    taskId: string;
    taskFingerprint: string;
    dispatchId?: string | null;
    attempt?: number | null;
    workbuddyMessageId?: string | null;
    resultId?: string | null;
    detail?: Record<string, unknown> | null;
  }): Promise<void> {
    if (!this.reconciliation) return;

    try {
      await this.reconciliation.recordExecutionEvidence(input);
    } catch (error) {
      console.error(
        `[relay] could not record ${input.event} for ${input.taskId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Reads the ledger and acts on what it finds.
   *
   * A blocking finding freezes all further automatic scheduling, which is the
   * only safe answer to a chain that cannot be explained - flushing the next
   * task on top of an unexplained one is how two tasks end up running.
   */
  private async runReconciliation(reason: string): Promise<void> {
    if (!this.reconciliation) return;

    try {
      const { report } = await this.reconciliation.reconcile(reason);
      await this.reconciliation.recordReconciliationOutcome(report);

      if (report.blocked) {
        this.reconciliationHold = true;
        await this.audit.write("reconciliation_blocked", {
          reason,
          tasks: report.tasks.map((task) => ({ taskId: task.taskId, state: task.state })),
        });
        console.error(
          `[relay] reconciliation blocked automatic scheduling (${reason}): ` +
            `${report.findings.filter((f) => f.severity === "blocking").map((f) => f.kind).join(", ")}`,
        );
        return;
      }

      console.log(
        `[relay] reconciliation clean (${reason}): ${report.tasksSeen} task(s) checked`,
      );
    } catch (error) {
      console.error(
        `[relay] reconciliation failed (${reason}): ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * The task as it was last seen on the GPT page, or null.
   *
   * The Chrome extension only carries facts - message ids, raw text and
   * order. Which of those messages is a task, and whether it is this task, is
   * parsed here, because the relay owns the protocol and the identity.
   */
  private async gptEvidenceFor(
    taskId: string,
    fingerprint: string,
  ): Promise<{ taskId: string; taskFingerprint: string } | null> {
    const messages = await this.recentAssistantMessages(5);
    if (messages.length === 0) return null;

    for (const message of messages) {
      const intent = readRelayIntent(message.text);
      if (intent.kind !== "task") continue;
      if (intent.task.taskId !== taskId || intent.task.block === null) continue;
      if (taskFingerprint(intent.task.block) !== fingerprint) continue;
      return { taskId, taskFingerprint: fingerprint };
    }

    return null;
  }

  /**
   * Asks the pinned ChatGPT tab for its most recent assistant messages.
   *
   * Read-only by construction: nothing is typed, nothing is clicked, and the
   * extension makes no decision about what a message means.
   */
  private async recentAssistantMessages(limit: number): Promise<
    { id: string; fingerprint: string; text: string }[]
  > {
    if (!this.bridge.hasClient()) return [];

    const requestId = makeId("recent-msgs");
    const messages = await new Promise<{ id: string; fingerprint: string; text: string }[]>(
      (resolve) => {
        const timer = setTimeout(() => resolve([]), 2000);
        this.recentMessageWaiters.set(requestId, (value) => {
          clearTimeout(timer);
          resolve(value);
        });
        void this.bridge
          .send({ type: "fetch_recent_assistant_messages", requestId, limit })
          .catch(() => resolve([]));
      },
    );

    return messages;
  }

  /** RELAY_MAX_TASK_RETRIES, so a task WorkBuddy always refuses cannot cycle for ever. */
  private maxTaskRetries(): number {
    const configured = this.config.relay?.maxTaskRetries;
    return typeof configured === "number" && configured >= 0 ? configured : 3;
  }

  private async queueWorkBuddyResult(
    taskId: string,
    workbuddyMessageId: string,
    text: string,
    reason: string,
  ): Promise<void> {
    await this.store.mutate((state) => {
      if (state.currentTask?.taskId === taskId) {
        state.currentTask.status = "result_pending";
        state.currentTask.sentToGptAt = isoNow();
      }
    });

    await this.store.enqueue({
      kind: "workbuddy_result",
      id: makeId("pending-wb"),
      taskId,
      text,
      workbuddyMessageId,
      createdAt: isoNow(),
    });

    await this.audit.write("workbuddy_result_queued", {
      taskId,
      workbuddyMessageId,
      reason,
    });

    console.log(`[relay] WorkBuddy result queued: ${reason}`);
  }

  private async sendWorkBuddyResultToGPT(
    taskId: string,
    workbuddyMessageId: string,
    text: string,
  ): Promise<void> {
    const requestId = makeId("wb-result");

    await this.expectInjectedText(text);

    await this.bridge.send({
      type: "send_to_chatgpt",
      requestId,
      text,
      autoSend: this.config.relay.autoSendToChatGPT,
    });

    /*
     * Deliberately no store mutation here. Only the completion owns the
     * task record: touching the state from the send would let a RESULT that
     * arrived late - or a queued one belonging to an earlier task - park the
     * relay in WAIT_GPT again.
     */

    await this.audit.write("workbuddy_result_sent_to_gpt", {
      taskId,
      workbuddyMessageId,
      requestId,
      autoSend: this.config.relay.autoSendToChatGPT,
    });

    console.log(`[relay] WorkBuddy -> GPT task=${taskId}`);

    /*
     * The answer is with ChatGPT now. Keeping the task record would park the
     * relay in WAIT_GPT until the next task happened to arrive, so the round
     * is closed here and the queue gets a chance to move on.
     */
    const released = await this.completeCurrentRound(taskId, "result_delivered");

    if (released) {
      await this.flushOnePending();
    }
  }

  private async expectInjectedText(text: string): Promise<void> {
    const fp = browserFingerprint("user", text);
    await this.store.expectInjectedUser(fp);
  }

  private async flushOnePending(): Promise<void> {
    /*
     * Reconciliation holds the line. Flushing the next task over an
     * unexplained one is how two tasks end up running at once, so this is the
     * one gate that outranks the queue.
     */
    if (this.reconciliationHold) {
      console.error(
        "[relay] scheduling frozen: reconciliation is blocked, flush refused " +
          "(nothing was sent, nothing was queued)",
      );
      return;
    }

    const snapshot = this.store.snapshot();

    /*
     * A task record exists for exactly one reason: that round is not over.
     * Starting another one would silently overwrite it, so nothing is
     * dispatched until the relay is truly idle.
     */
    if (snapshot.currentTask) return;
    if (snapshot.state !== "IDLE") return;
    if (snapshot.paused) return;

    const item = await this.store.shiftPending();
    if (!item) return;

    if (item.kind === "gpt_task") {
      await this.startWorkBuddyTask(item.text, item.fingerprint);
      return;
    }

    if (item.kind === "workbuddy_result") {
      if (!this.bridge.hasClient()) {
        await this.store.enqueue(item);
        return;
      }

      try {
        await this.sendWorkBuddyResultToGPT(
          item.taskId,
          item.workbuddyMessageId,
          item.text,
        );
      } catch {
        await this.store.enqueue(item);
      }
    }
  }
}
