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
import type { ModelRouter } from "./model-router/router.js";
import { browserFingerprint, isoNow, makeId } from "./utils.js";
import { WorkBuddyClient } from "./workbuddy.js";
import {
  decideDispatch,
  dispatchIdFor,
  ReconciliationService,
  TaskLedger,
  taskFingerprint,
  type ReconciliationLiveContext,
  type ReconciliationReport,
} from "./reconciliation/index.js";
import {
  advanceStage,
  isAlertStage,
  isStaleDispatch,
  type TaskExecutionStage,
  type TaskExecutionState,
} from "./delivery/stage.js";
import {
  planRecovery,
  ResultDeliveryLedger,
  ResumeGuard,
  resultDeliveryKey,
} from "./delivery/recovery.js";
import { ResultPipeline } from "./delivery/result-pipeline.js";
import {
  DispatchPipeline,
  type RoutedModel,
  type StageNote,
} from "./delivery/dispatch-pipeline.js";

export class ZhixingRelay {
  private workAbort: AbortController | null = null;
  /**
   * Every wait-cancellation controller this relay has armed.
   *
   * One controller is not enough to cancel with: a recovered wait keeps the
   * signal it was given while the pipeline arms another one for the next
   * step, so cancelling "the current" one would leave the earlier wait
   * running. Cancelling all of them is the only honest reading of "stop".
   */
  private readonly armedAborts = new Set<AbortController>();
  /**
   * Every background step this relay started and has not finished yet.
   *
   * A step is tracked here rather than left to float so that a shutdown has
   * something to wait on: "no state write is still in flight" is a fact about
   * this set, not a claim a caller has to guess at.
   */
  private readonly backgroundWork = new Set<Promise<void>>();
  /**
   * Set once the relay is shut down. Past this, no step may start and no
   * inbound message may be written, which is what keeps a late write from
   * landing in a directory that no longer exists.
   */
  private disposed = false;
  /** Owns the RESULT lifecycle: persist, deliver, acknowledge, and its lease. */
  private readonly results: ResultPipeline;
  /** Owns the dispatch execution pipeline: route, send, wait, quota fallback. */
  private readonly dispatch: DispatchPipeline;
  /** One recovered wait per dispatch, so a resume cannot listen twice. */
  private readonly resumeGuard = new ResumeGuard();
  /** Results already accepted in this process. A restart starts clean. */
  private readonly acceptedResults = new ResultDeliveryLedger();
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
  /** Ledger size, refreshed on every write so `status` never reads the file. */
  private ledgerEventCount: number | null = null;
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

    /*
     * The RESULT pipeline owns persist -> deliver -> acknowledge and the lease
     * that covers the gap between them. The relay stays the coordinator: every
     * fact it hands over (the stage writer, the round closer) is one it
     * already knows how to record.
     */
    this.results = new ResultPipeline({
      store: this.store,
      audit: this.audit,
      bridge: this.bridge,
      config: this.config,
      hooks: {
        noteStage: async (args) => {
          await this.noteStage({
            taskId: args.taskId,
            taskFingerprint: this.store.snapshot().currentTask?.taskFingerprint ?? "*",
            stage: args.stage,
            ledgerEvent: args.ledgerEvent as Parameters<
              ReconciliationService["recordExecutionEvidence"]
            >[0]["event"],
            detail: args.detail ?? null,
          });
        },
        onRoundCompleted: (taskId, reason) => this.completeCurrentRound(taskId, reason),
        onLeaseExpired: (taskId) => this.expireResultLease(taskId),
      },
    });

    /*
     * The dispatch pipeline owns the send: routing, the click into
     * WorkBuddy, the wait and the quota fallback loop. The relay hands it the
     * same writers it uses itself, so a stage or a ledger event still has
     * exactly one implementation whichever side records it.
     */
    this.dispatch = new DispatchPipeline({
      config: this.config,
      store: this.store,
      audit: this.audit,
      workbuddy: this.workbuddy,
      router: this.router,
      reconciliation: this.reconciliation,
      publishTask: (args) => this.publishTask(args),
      noteStage: (args) => this.noteStageFromPipeline(args),
      onWorkBuddyResult: (taskId, outboundId, body) =>
        this.onWorkBuddyResult(taskId, outboundId, body),
      requeue: (args) => this.requeueTask(args),
      reconcile: async (reason) => {
        await this.runReconciliation(reason);
      },
      noteActivity: () => this.noteTaskActivity(),
      workAbort: () => this.workAbort,
      setWorkAbort: (controller) => {
        /*
         * A wait armed after the shutdown began was cancelled before it
         * existed. Aborting it here is what lets that step end instead of
         * hanging on an answer nobody is waiting for any more.
         */
        if (controller) {
          this.armedAborts.add(controller);
          if (this.disposed) controller.abort();
        }
        this.workAbort = controller;
      },
    });
  }

  /**
   * The stage writer as the dispatch pipeline sees it.
   *
   * The pipeline knows the task by id; the fingerprint lives on the task
   * record, so it is filled in here instead of being traded back and forth.
   */
  private async noteStageFromPipeline(args: StageNote): Promise<void> {
    await this.noteStage({
      taskId: args.taskId,
      taskFingerprint:
        args.taskFingerprint ?? this.store.snapshot().currentTask?.taskFingerprint ?? "*",
      ...(args.dispatchId === undefined ? {} : { dispatchId: args.dispatchId }),
      ...(args.attempt === undefined ? {} : { attempt: args.attempt }),
      stage: args.stage,
      ledgerEvent: args.ledgerEvent,
      ...(args.workbuddyMessageId === undefined
        ? {}
        : { workbuddyMessageId: args.workbuddyMessageId }),
      ...(args.resultId === undefined ? {} : { resultId: args.resultId }),
      ...(args.detail === undefined ? {} : { detail: args.detail }),
    });
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

    this.bridge.onMessage((message) => this.handleExtensionMessage(message));

    // The ledger is checked once at start-up: a restart that left a task
    // half-way is exactly the case a reconciliation pass exists to describe.
    if (this.reconciliation) {
      this.ledgerEventCount = await this.reconciliation.ledgerLength();
    }

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
    const task = snapshot.currentTask;
    const execution = task?.execution ?? null;

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
      /** True while reconciliation is holding the scheduler. */
      reconciliationHold: this.reconciliationHold,
      /**
       * Where THIS dispatch stands. Deliberately a separate axis from `state`:
       * "the relay is busy" and "WorkBuddy confirmed the task started" are
       * different facts, and only one of them survives a restart.
       */
      executionStage: execution?.stage ?? null,
      executionStageStartedAt: execution?.stageStartedAt ?? null,
      executionLastProgressAt: execution?.lastProgressAt ?? null,
      executionHistory: execution?.history ?? [],
      currentDispatchId: task?.dispatchId ?? null,
      currentAttempt: typeof task?.attempt === "number" ? task.attempt : null,
      /** Events in the ledger, or null when the relay has no ledger. */
      ledgerEventCount: this.ledgerEventCount,
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

    /*
     * The decision comes from the durable record, not from a single status
     * string. Whatever the crash landed on - mid-send, waiting for WorkBuddy,
     * holding a persisted answer - the plan names the one thing that is safe,
     * and a plan that names "listen" is never allowed to become "send again".
     */
    const plan = planRecovery(task);

    if (plan.kind === "resume_wait" && !this.workAbort) {
      /*
       * Neither branch may be awaited. Resuming is the answer to a request
       * that is already late: whoever asked (a human at a console, an HTTP
       * caller under pm2) is waiting for the relay to run again, not for
       * WorkBuddy to answer the task. The turn keeps going in the background
       * and reports its stage through `status()` from then on.
       */
      const dispatchId = task?.dispatchId ?? plan.taskId;
      const claimed = this.resumeGuard.claim(dispatchId);

      if (!claimed) {
        /*
         * A second resume arrived while the first recovered turn is still
         * listening. Answering it by starting another wait would read the same
         * message twice and forward two answers to ChatGPT.
         */
        console.warn(
          `[relay] recovered wait for ${plan.taskId} is already owned by ` +
            `${this.resumeGuard.heldBy()}; the second resume is a no-op`,
        );
        await this.audit.write("workbuddy_wait_already_resumed", {
          taskId: plan.taskId,
          dispatchId,
        });
        return;
      }

      this.scheduleWork(() =>
        this.resumeWorkBuddyWait(
          plan.taskId,
          plan.outboundId,
          plan.modelId,
          dispatchId,
        ),
      );
      return;
    }

    this.scheduleWork(() => this.flushOnePending());
  }

  /**
   * Starts a follow-up step without waiting for it.
   *
   * The rejection is caught and printed here rather than left to float, which
   * is what keeps a background dispatch from turning into an unhandled
   * rejection - the one way a fast-returning `resume` could still look like a
   * crash.
   */
  private scheduleWork(step: () => Promise<void>): void {
    void this.trackWork(step);
  }

  /**
   * Starts a step and keeps it visible until it settles.
   *
   * The rejection is caught and printed rather than left to float, which is
   * what keeps a background dispatch - or an inbound turn nobody awaited -
   * from turning into an unhandled rejection: the one way a fast-returning
   * call could still look like a crash.
   */
  private trackWork(step: () => Promise<void>): Promise<void> {
    if (this.disposed) {
      /*
       * Shutting down. Starting a step now would write to a record nobody
       * owns any more, so it is dropped instead - the round it belonged to is
       * already over and the caller that wanted it has gone away.
       */
      console.warn(
        "[relay] background step dropped: the relay is shutting down and no longer owns work",
      );
      return Promise.resolve();
    }

    const run = Promise.resolve()
      .then(step)
      .catch((error: unknown) => {
        console.error(
          `[relay] background step failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });

    this.backgroundWork.add(run);
    // The rejection is handled above, so this cannot itself float.
    void run.then(() => {
      this.backgroundWork.delete(run);
    });

    return run;
  }

  /** How many background steps are still running. */
  backgroundWorkPending(): number {
    return this.backgroundWork.size;
  }

  /**
   * Waits until every background step the relay started has finished.
   *
   * A step may start another one, so this keeps going while the set is not
   * empty. It sleeps for nothing and guesses nothing: when it returns, the
   * number of steps still running is zero.
   */
  async drainBackgroundWork(): Promise<void> {
    // A step starting another one must not spin forever; the bound only ends
    // the drain, it never hides work, because `backgroundWorkPending()` would
    // still report the work nobody ever waited for.
    for (let rounds = 0; rounds < 1_000 && this.backgroundWork.size > 0; rounds += 1) {
      await Promise.all([...this.backgroundWork]);
    }
  }

  /**
   * Cancels every wait this relay armed.
   *
   * All of them, not just the latest: a recovered wait holds the signal it was
   * handed while the pipeline arms another for the next step, so cancelling
   * only the newest would leave the older wait hanging on an answer that has
   * no round left to answer to.
   */
  cancelArmedWaits(): void {
    for (const controller of this.armedAborts) controller.abort();
    this.armedAborts.clear();
    this.workAbort?.abort();
    this.workAbort = null;
  }

  /**
   * Shuts the relay down: nothing new starts, and the work already running
   * finishes before this resolves.
   *
   * A running process keeps using `stopCurrentRound()` and `emergencyStop()`,
   * both of which leave the relay able to serve the next round. This is the
   * "the process is going away" path: a caller that needs the relay's files
   * untouched afterwards - a test removing its directory, for instance - can
   * only be sure once this resolves.
   *
   * Cancellation comes first, because the drain can only finish for work that
   * is not being held: the wait is aborted and the timers are stopped, so what
   * is left is work that already has everything it needs. A step still blocked
   * on a promise outside the relay - an answer nobody will ever send - is that
   * owner's to release, not this method's to wait for.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;

    this.disposed = true;
    this.cancelArmedWaits();
    this.stopHeartbeat();
    // The lease is a timer, so releasing it here is part of the same claim as
    // the drain below: no write is left armed behind this method.
    this.results.clearLease();

    await this.drainBackgroundWork();

    /*
     * Again, because a step that finished inside the drain may have armed a
     * lease before it ended. Nothing may stay armed once the relay is gone:
     * a lease is a timer, and a timer is a write waiting to happen.
     */
    this.results.clearLease();
  }

  async stopCurrentRound(reason = "manual"): Promise<void> {
    this.cancelArmedWaits();
    this.results.clearLease();

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

    await this.dispatch.startTask(text, fp);
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

  /**
   * Handles one message from the extension.
   *
   * The handling is tracked like any other step the relay starts, because the
   * bridge does not await it: a turn in flight is relay-owned work, and a
   * shutdown that cannot see it cannot wait for it.
   */
  async handleExtensionMessage(message: ExtensionInbound): Promise<void> {
    if (this.disposed) {
      /*
       * The relay shut down before this message arrived. Answering it would
       * mean writing a stage for a round that no longer exists, so the ack is
       * dropped: a late confirmation is not a task.
       */
      console.warn(
        `[relay] dropping ${message.type} from the extension: the relay is shutting down, ` +
          `so this message belongs to a round that no longer exists`,
      );
      return;
    }

    await this.trackWork(() => this.onExtensionMessage(message));
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
           * The extension confirms the RESULT reached ChatGPT's composer,
           * which is the delivery acknowledgement. Releasing here closes the
           * round as soon as the delivery is real instead of waiting for the
           * lease; the record is already gone when only the lease could
           * confirm it.
           */
          const task = this.store.snapshot().currentTask;
          if (task?.status === "sent_to_gpt") {
            await this.noteStage({
              taskId: task.taskId,
              taskFingerprint: task.taskFingerprint ?? "*",
              dispatchId: task.dispatchId ?? null,
              attempt: task.attempt ?? null,
              stage: "RESULT_ACKED",
              ledgerEvent: "RESULT_ACKED",
              workbuddyMessageId: task.workbuddyOutboundMessageId ?? null,
              resultId: message.requestId ?? null,
              detail: { sent: message.sent ?? false, staged: message.staged ?? false },
            });

            const released = await this.completeCurrentRound(
              task.taskId,
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

    /*
     * PAUSED AND BUSY ARE NOT ANSWERS TO "WHERE DID THIS COME FROM".
     *
     * They used to be handled here, before the pipeline ever ran, by putting
     * the task straight on the queue. That skipped the acceptance entirely:
     * no TASK_ACCEPTED was ever written, so the entry carried no source
     * attestation into the queue - and a flush minutes later had nothing left
     * to prove it with, because by then the GPT page had let go of the
     * message. The task was unsendable for ever. That is
     * `relay-production-smoke-v0473i-003`.
     *
     * So the scheduling gate moved into the pipeline, AFTER acceptance, and
     * every observed GPT task is attested at the moment it is observed.
     */
    const outcome = await this.dispatch.startTask(task, message.fingerprint, {
      observedOnGptPage: true,
    });

    /*
     * A task refused at the door - an identity conflict, or a source that
     * cannot be established - is not one the relay may hold. It was never
     * dequeued, so there is no owner to restore: saying so loudly is the
     * whole of it.
     */
    if (outcome.kind === "pre_send_rejected") {
      console.error(
        `[relay] observed GPT task was not accepted (${outcome.reason}); ` +
          `nothing was queued and nothing was sent`,
      );
    }
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

  private async resumeWorkBuddyWait(
    taskId: string,
    outboundId: string,
    modelId?: string | null,
    /** The durable dispatch identity, so the guard can name its owner. */
    guardId?: string | null,
  ): Promise<void> {
    const owned = guardId ? this.resumeGuard.holds(guardId) : true;

    if (!owned) {
      // The round this was meant to serve has been taken over; not an error.
      return;
    }

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

    this.armedAborts.add((this.workAbort = new AbortController()));

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

      /*
       * The recovered wait and the original turn can both reach this answer,
       * and a relay restart starts with an empty memory. One message means one
       * RESULT: if the same dispatch already accepted this answer, listening
       * again must not post it a second time.
       */
      const key = resultDeliveryKey({
        taskId,
        workbuddyMessageId: outboundId,
        dispatchId: guardId ?? current?.dispatchId ?? null,
      });

      if (this.acceptedResults.has(key)) {
        console.warn(
          `[relay] recovered turn for ${taskId} re-found the answer of ${outboundId}, ` +
            `which this dispatch already delivered; NOT sent to ChatGPT again`,
        );
        await this.audit.write("workbuddy_result_not_resent", {
          taskId,
          workbuddyMessageId: outboundId,
          dispatchId: guardId ?? null,
          reason: "already delivered by this dispatch",
        });
        return;
      }

      const outcome =
        routed && text
          ? await this.dispatch.runTurn({
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
      this.resumeGuard.release(guardId ?? undefined);
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
    const current = this.store.snapshot().currentTask;
    const taskFingerprint = current?.taskFingerprint ?? "*";
    const dispatchId = current?.dispatchId ?? null;
    const attempt = current?.attempt ?? null;

    /*
     * The answer has to belong to the dispatch the relay is actually running,
     * and it has to name the task the relay expects. A RESULT carrying another
     * TASK_ID is evidence from another round, and the honest answer to that is
     * to stop rather than to deliver a foreign answer to ChatGPT.
     */
    const received = parseRelayEnvelope(body);
    const receivedTaskId = received?.taskId ?? null;

    if (receivedTaskId !== null && receivedTaskId !== taskId) {
      await this.noteStage({
        taskId,
        taskFingerprint,
        dispatchId,
        attempt,
        stage: "RECONCILIATION_REQUIRED",
        ledgerEvent: "DISPATCH_STALLED",
        workbuddyMessageId,
        detail: {
          outcome: "result_task_id_mismatch",
          resultTaskId: receivedTaskId,
          expectedTaskId: taskId,
        },
      });

      await this.audit.write("workbuddy_result_task_mismatch", {
        taskId,
        resultTaskId: receivedTaskId,
      });

      console.error(
        `[relay] WorkBuddy answered task ${receivedTaskId} while ${taskId} was in flight; ` +
          `the answer is not delivered and the round is in reconciliation`,
      );
      return;
    }

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

    // The receipt is bound to the dispatch that produced it, never to "the
    // last assistant message on the page".
    await this.noteStage({
      taskId,
      taskFingerprint,
      dispatchId,
      attempt,
      stage: "RESULT_RECEIVED",
      ledgerEvent: "RESULT_RECEIVED",
      workbuddyMessageId,
      resultId: workbuddyMessageId,
      detail: { length: wrapped.length },
    });

    /*
     * Claiming the RESULT before anything is written is what makes the next
     * delivery attempt impossible to double: the answer that reaches ChatGPT
     * first is the only one, and a later recovery of the same message is
     * recorded as "already delivered" rather than sent twice.
     */
    this.acceptedResults.claim(
      resultDeliveryKey({ taskId, workbuddyMessageId, dispatchId }),
    );

    /*
     * The RESULT exists from this moment on, so the lease is armed now and
     * cleared by whichever path actually commits it. A send that never lands
     * must still not hold the task hostage.
     */
    this.results.armLease(taskId);

    /*
     * Persist before delivering. The queued RESULT is the only thing that
     * survives a crash between "WorkBuddy answered" and "ChatGPT saw it", and
     * that is exactly the window in which the alternative - asking WorkBuddy
     * to run the task again - would burn a whole turn of a real assistant.
     */
    const pending = await this.results.persist({
      taskId,
      workbuddyMessageId,
      text: wrapped,
      detail: { taskFingerprint, dispatchId, attempt },
    });

    const snapshot = this.store.snapshot();

    if (snapshot.paused || !this.bridge.hasClient()) {
      await this.audit.write("workbuddy_result_queued", {
        taskId,
        workbuddyMessageId,
        reason: snapshot.paused ? "relay is paused" : "Chrome bridge is disconnected",
      });
      console.log(
        `[relay] WorkBuddy result queued: ${
          snapshot.paused ? "relay is paused" : "Chrome bridge is disconnected"
        }`,
      );
      return;
    }

    try {
      await this.results.deliver({
        taskId,
        workbuddyMessageId,
        text: wrapped,
        pendingId: pending.id,
      });
    } catch (error) {
      /*
       * The persisted RESULT stays in the queue. The next flush re-delivers
       * it to ChatGPT and never runs the WorkBuddy task again.
       */
      await this.audit.write("workbuddy_result_delivery_failed", {
        taskId,
        workbuddyMessageId,
        error: error instanceof Error ? error.message : String(error),
      });
      console.error(`[relay] WorkBuddy result delivery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Writes the RESULT to the durable queue.
   *
   * This is the "persisted" half of the result pipeline and the only one. The
   * live state cannot hold an answer: it is overwritten by the next round, so
   * a result that only ever lived there would be gone the moment the relay
   * was restarted.
   */
  /**
   * Closes a round whose answer ChatGPT acknowledged.
   *
   * The lease and the stage write the RESULT pipeline owns, so this only ends
   * the round itself.
   */
  private async finishRound(taskId: string, reason: string): Promise<boolean> {
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

    /*
     * COMPLETED is the last stage, and reaching it is what makes the whole
     * chain readable: RESULT_RECEIVED, RESULT_PERSISTED, RESULT_DELIVERED and
     * RESULT_ACKED were all accepted before, in that order.
     */
    await this.noteStage({
      taskId,
      taskFingerprint: task?.taskFingerprint ?? "*",
      dispatchId: task?.dispatchId ?? null,
      attempt: task?.attempt ?? null,
      // The record is already cleared, so the stage to move from is handed in.
      execution: task?.execution ?? null,
      stage: "COMPLETED",
      ledgerEvent: "TASK_COMPLETED",
      workbuddyMessageId: task?.workbuddyOutboundMessageId ?? null,
      detail: { reason },
    });

    console.log(`[relay] round ${taskId} completed (${reason})`);

    return true;
  }

  /**
   * Ends a round whose RESULT ChatGPT acknowledged.
   *
   * Only the extension's `chatgpt_send_result` gets to call this, and the
   * acknowledgement itself belongs to the RESULT pipeline: the relay's part
   * ends with the round, not with the delivery.
   */
  private async completeCurrentRound(taskId: string, reason: string): Promise<boolean> {
    /*
     * The acknowledgement itself belongs to the RESULT pipeline; this is the
     * relay's half of it - the round is over, so the task record and the
     * schedule go back to the idle state. Calling `results.acknowledge` here
     * would re-enter the pipeline it just called and recurse for ever.
     */
    if (this.results.leasedTaskId() === taskId) {
      this.results.clearLease();
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

    /*
     * COMPLETED is the last stage, and reaching it is what makes the whole
     * chain readable: RESULT_RECEIVED, RESULT_PERSISTED, RESULT_DELIVERED and
     * RESULT_ACKED were all accepted before, in that order.
     */
    await this.noteStage({
      taskId,
      taskFingerprint: task?.taskFingerprint ?? "*",
      dispatchId: task?.dispatchId ?? null,
      attempt: task?.attempt ?? null,
      // The record is already cleared, so the stage to move from is handed in.
      execution: task?.execution ?? null,
      stage: "COMPLETED",
      ledgerEvent: "TASK_COMPLETED",
      workbuddyMessageId: task?.workbuddyOutboundMessageId ?? null,
      detail: { reason },
    });

    console.log(`[relay] round ${taskId} completed (${reason})`);

    return true;
  }

  /**
   * The lease ran out: the RESULT left the building and nobody confirmed it,
   * so the task record is released rather than kept forever.
   *
   * This drops bookkeeping only. The RESULT has either been delivered or sits
   * in the queue; neither is re-sent here.
   */
  private async expireResultLease(taskId: string): Promise<void> {
    const released = await this.finishRound(taskId, "result_lease_expired");

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
    if (this.results.leasedTaskId() === task.taskId) return;
    if (Date.now() - Date.parse(task.sentToGptAt) < this.resultLeaseMs()) return;

    await this.expireResultLease(task.taskId);
  }

  /**
   * RESULT_LEASE_MS: how long a delivered-but-unacknowledged round may hold its
   * task. The lease itself belongs to the RESULT pipeline; this is only the
   * number the relay reads to explain itself.
   */
  resultLeaseMs(): number {
    return this.results.leaseMs();
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

    /*
     * The queue is recorded too, not only the failure: TASK_REQUEUED is why
     * the round ended where it did, TASK_ENQUEUED is where the task is now.
     * Without the second line a task that failed a turn reads in the ledger
     * as "published but never queued" while it is plainly waiting.
     */
    if (this.reconciliation) {
      await this.reconciliation.recordTaskEnqueued({
        taskId: args.taskId,
        taskFingerprint: requeued?.taskFingerprint ?? "*",
        dispatchId: requeued?.dispatchId ?? null,
        attempt: requeued?.attempt ?? null,
        source: "relay",
        detail: { retryCount, reason: args.reason, via: "requeue" },
      });
      this.noteLedgerWrite();
    }

    await this.recordEvidence({
      event: "TASK_REQUEUED",
      taskId: args.taskId,
      taskFingerprint: requeued?.taskFingerprint ?? "*",
      attempt: requeued?.attempt ?? null,
      dispatchId: requeued?.dispatchId ?? null,
      detail: { retryCount, reason: args.reason, via: "requeue" },
    });

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
    /** True only when the task was handed in straight from the GPT page. */
    observedOnGptPage: boolean;
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
      sourceFingerprint: args.messageFingerprint,
      /*
       * A task handed in by the page it was just read from needs no second
       * reading. A task taken off the queue does: nothing else says where it
       * came from, so the page is asked - and, when the page has let go of the
       * message, the chain written when it was first accepted is asked
       * instead. Both are the same question, asked at two different moments.
       */
      gptEvidence: args.observedOnGptPage
        ? { taskId: args.taskId, taskFingerprint: args.fingerprint }
        : await this.gptEvidenceFor(args.taskId, args.fingerprint),
      observedOnGptPage: args.observedOnGptPage,
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
   * One step of the execution stage machine, with its ledger evidence.
   *
   * This is the only place a stage is written, so the three rules that matter
   * cannot drift apart:
   *
   *   stale         an acknowledgement from a dispatch the relay is no longer
   *                 running is dropped, never applied to the live task
   *   monotonic      a stage only moves forward, so a late copy of an older
   *                 acknowledgement cannot rewind a round
   *   observable     every accepted move writes its ledger event
   *
   * The stage is persisted with the task, which is what lets a restarted relay
   * tell "the result was persisted" from "the task has to run again".
   */
  private async noteStage(args: {
    taskId: string;
    taskFingerprint: string;
    dispatchId?: string | null;
    attempt?: number | null;
    /** Overrides the persisted stage, for a task whose record was just cleared. */
    execution?: TaskExecutionState | null;
    stage: TaskExecutionStage;
    /** The ledger event that the move above is worth recording. */
    ledgerEvent: Parameters<ReconciliationService["recordExecutionEvidence"]>[0]["event"];
    workbuddyMessageId?: string | null;
    resultId?: string | null;
    detail?: Record<string, unknown> | null;
  }): Promise<TaskExecutionState | null> {
    if (this.disposed) {
      /*
       * Same rule as the inbound guard above, one layer down: a stage move
       * needs a live round to move, and after a shutdown there is none.
       */
      console.warn(
        `[relay] dropping ${args.stage}: the relay is shutting down, so nothing owns this task`,
      );
      return null;
    }

    const now = isoNow();
    const live = this.store.snapshot().currentTask;
    const current = args.execution === undefined ? live?.execution ?? null : args.execution;

    if (isStaleDispatch(live, { taskId: args.taskId, dispatchId: args.dispatchId ?? undefined })) {
      console.warn(
        `[relay] ignoring ${args.stage} for ${args.taskId}: the running dispatch is ` +
          `${live?.dispatchId ?? "none"}, so this is an echo from an older round`,
      );
      return current;
    }

    const advanced = advanceStage(current, args.stage, now);

    if (!advanced) return current;

    await this.store.mutate((state) => {
      if (state.currentTask?.taskId !== args.taskId) return;
      state.currentTask.execution = advanced;
    });

    /*
     * Already there: the move is a no-op, so writing it again would only add a
     * second line for a fact the ledger already holds. An alert stage may be
     * re-entered, because freezing an older alert is still new information.
     */
    if (current && current.stage === args.stage && !isAlertStage(args.stage)) {
      return advanced;
    }

    await this.recordEvidence({
      event: args.ledgerEvent,
      taskId: args.taskId,
      taskFingerprint: args.taskFingerprint,
      dispatchId: args.dispatchId ?? null,
      attempt: args.attempt ?? null,
      workbuddyMessageId: args.workbuddyMessageId ?? null,
      resultId: args.resultId ?? null,
      detail: args.detail ?? null,
    });

    return advanced;
  }

  /** Keeps the `status` ledger counter cheap without reading the file. */
  private noteLedgerWrite(count = 1): void {
    this.ledgerEventCount = (this.ledgerEventCount ?? 0) + count;
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
      this.noteLedgerWrite();
    } catch (error) {
      console.error(
        `[relay] could not record ${input.event} for ${input.taskId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Lifts a reconciliation hold by recording the decision first.
   *
   * A hold is frozen evidence, so the way out of it is a NEW event saying why
   * the chain is now explainable. Nothing here ever edits, truncates or
   * replaces a line: the ledger keeps every fact it was given, which is what
   * makes the freeze auditable instead of merely annoying.
   */
  async resolveReconciliation(reason: string): Promise<{ ok: boolean; message: string }> {
    if (!this.reconciliation) {
      return {
        ok: false,
        message: "the relay has no ledger, so nothing is holding scheduling",
      };
    }

    if (!this.reconciliationHold) {
      return { ok: false, message: "reconciliation is not holding; nothing to resolve" };
    }

    await this.reconciliation.recordReconciliationResolved({ reason, source: "control" });
    this.noteLedgerWrite();

    /*
     * The record is written before the runtime is touched, never after: a task
     * that reconciliation froze is put back on the queue here, so the next send
     * goes through the very same decision the queue makes for every other task
     * instead of through a second, special retry rule.
     */
    await this.requeueFrozenTask(reason);

    // Re-read the ledger: the hold may have been a symptom, not the disease.
    await this.runReconciliation(`resolved: ${reason}`);

    if (this.reconciliationHold) {
      return {
        ok: true,
        message:
          "resolution recorded, but the chain is still unexplained and scheduling stays frozen",
      };
    }

    /*
     * Released, and deliberately not dispatching from here.
     *
     * A resolution is a decision about one task, not a decision to send it:
     * the task it put back on the queue has to be re-decided by the queue.
     * Dispatching eagerly would hand that task straight to the dispatch
     * decision, which refuses anything already proven sent - and the queue
     * would then drop it, losing the very task v0.4.7 holds as evidence
     * instead of retrying it.
     *
     * (While the hold was a latch this line could not be reached at all:
     * every resolution left the hold set and took the branch above.)
     */
    return {
      ok: true,
      message:
        "resolution recorded; scheduling is released and the queue will re-decide the task",
    };
  }

  /**
   * Puts a task that reconciliation froze back on the queue.
   *
   * It is the human, not the relay, that may decide a cancellation was a
   * mistake - so the relay must not do this on its own, which is exactly why
   * the frozen record is left in place and only this call moves it. The record
   * itself is not deleted: the ledger already holds every stage it passed, so
   * the task stays readable after the live record is gone.
   */
  private async requeueFrozenTask(reason: string): Promise<void> {
    const task = this.store.snapshot().currentTask;

    if (!task || !isAlertStage(task.execution?.stage ?? "DISPATCHING")) return;

    await this.store.enqueue({
      kind: "gpt_task",
      id: makeId("pending-task"),
      text: task.sourceText ?? task.taskId,
      fingerprint: task.sourceFingerprint ?? task.taskFingerprint ?? task.taskId,
      createdAt: isoNow(),
      taskId: task.taskId,
      attempt: task.attempt ?? 0,
      retryCount: (task.attempt ?? 0) + 1,
      reason: `reconciled: ${reason}`,
    });

    await this.store.mutate((state) => {
      if (state.currentTask?.taskId !== task.taskId) return;
      state.currentTask = null;
      if (state.state !== "PAUSED") state.state = "IDLE";
    });

    await this.audit.write("task_requeued", {
      taskId: task.taskId,
      reason: `reconciled: ${reason}`,
      attempt: task.attempt ?? 0,
      source: "reconciliation",
    });

    console.log(
      `[relay] task ${task.taskId} was put back on the queue after reconciling it ` +
        `("${reason}"); nothing was sent until the queue re-decides`,
    );
  }

  /**
   * Reads the ledger and acts on what it finds.
   *
   * A blocking finding freezes all further automatic scheduling, which is the
   * only safe answer to a chain that cannot be explained - flushing the next
   * task on top of an unexplained one is how two tasks end up running.
   */
  /**
   * What the live relay is holding, for the ledger to compare against.
   *
   * A reconciliation that cannot see the live state calls every unfinished
   * task a orphan, including the one it is running right now.
   */
  private liveReconciliationContext(): ReconciliationLiveContext {
    const snapshot = this.store.snapshot();

    return {
      pending: snapshot.pending.map((item) => item.taskId).filter((id): id is string => typeof id === "string"),
      current: snapshot.currentTask?.taskId ?? null,
    };
  }

  /**
   * Closes one task the relay has forgotten, by an explicit operator decision.
   *
   * This is the deliberate alternative to asking a reconciliation for a
   * resend: the chain shows that WorkBuddy ran the task, the live state no
   * longer has it, and no result ever reached the relay - so the only safe
   * answer is to record that a human closed the book on it.
   *
   * It enqueues nothing, requeues nothing, writes no completion the relay
   * never observed, and leaves every other task exactly as it was. The old
   * ledger rows are read, never rewritten.
   */
  async closeReconciledTaskWithoutResend(input: {
    taskId: string;
    reason: string;
  }): Promise<{
    ok: boolean;
    message: string;
    blocked: boolean;
    findings: string[];
  }> {
    const taskId = input.taskId.trim();

    if (taskId.length === 0) {
      return {
        ok: false,
        message: "a historical close needs the task it closes",
        blocked: this.reconciliationHold,
        findings: [],
      };
    }

    if (!this.reconciliation) {
      return {
        ok: false,
        message: "the relay has no ledger, so there is nothing to close",
        blocked: this.reconciliationHold,
        findings: [],
      };
    }

    /*
     * The same close, now also usable on a live task: a task the relay itself
     * froze because the send could not be confirmed.
     *
     * The smoke task `relay-production-smoke-v0473c-001` is exactly that
     * shape - WorkBuddy really ran it, the ledger says the send was never
     * confirmed, and the relay is sitting on a `currentTask` it cannot prove
     * either way. A closure row alone does not release it, because the hold
     * has a second source, the live task. So the close is allowed to clear
     * *this one* task record, and nothing else moves.
     *
     * Refused for exactly one case: the task named *is* the live record, and
     * that record is not frozen for reconciliation. A task that is running, or
     * already proven sent, is not ours to close - that is a different
     * decision, and recording a closure for it would be a second, invented
     * fact about WorkBuddy.
     *
     * A close naming some *other* chain stays a historical close: the live
     * record belongs to a different task and is never touched by it.
     */
    const live = this.store.snapshot().currentTask;

    if (live !== null && live.taskId === taskId) {
      const stage = live.execution?.stage ?? "none";

      if (stage !== "RECONCILIATION_REQUIRED") {
        return {
          ok: false,
          message:
            `the live task ${taskId} stands at ${stage}, and only a task frozen for ` +
            `reconciliation can be closed without a resend`,
          blocked: this.reconciliationHold,
          findings: [],
        };
      }
    }

    const closed = await this.reconciliation.recordTaskClosedWithoutResend({
      taskId,
      reason: input.reason,
      source: "control",
    });

    if (!closed.ok) {
      return {
        ok: false,
        message: closed.message,
        blocked: this.reconciliationHold,
        findings: [],
      };
    }

    this.noteLedgerWrite();

    /*
     * The closure is written first, then the matching live record goes, so a
     * crash between the two still leaves the ledger holding the decision. The
     * live record is dropped and nothing else is touched: no requeue, no
     * enqueue, no dispatch, and no stage the relay never observed.
     */
    const liveReleased = await this.releaseLiveReconciliationTask(taskId);

    // The chain is then re-read with the live state, so the answer describes
    // the world, not the state before the decision.
    const report = await this.runReconciliation(`closed without resend: ${input.reason}`);

    if (report === null) {
      return {
        ok: true,
        message: "the task was closed, but the ledger could not be re-read afterwards",
        blocked: this.reconciliationHold,
        findings: [],
      };
    }

    const blocking = report.findings
      .filter((finding) => finding.severity === "blocking")
      .map((finding) => `${finding.kind}:${finding.taskId}`);

    /*
     * The answer has to be the same fact `/control/status` reports.
     * `report.blocked` alone is only half of it: scheduling can also be held
     * by the live task the relay itself froze, which the ledger knows nothing
     * about. So what is returned is the runtime hold, read after the
     * re-reconciliation - the number an operator is about to look up.
     *
     * No blocking finding is invented for the live case: it is named in the
     * message instead, because it is not a statement about a chain.
     */
    const held = this.reconciliationHold;
    const liveHold = this.liveNeedsReconciliation();
    const parts: string[] = [];

    if (liveReleased) {
      parts.push("the live record for this task was released");
    }

    if (blocking.length > 0) {
      parts.push(`other chains still block scheduling (${blocking.join(", ")})`);
    }
    if (liveHold) {
      parts.push(
        "scheduling is still held by the live reconciliation state " +
          "(the current task needs a human decision)",
      );
    }

    return {
      ok: true,
      message:
        parts.length > 0
          ? `task ${taskId} was closed; ${parts.join("; ")}`
          : `task ${taskId} was closed and scheduling is released`,
      blocked: held,
      findings: blocking,
    };
  }

  /**
   * True when the relay itself is holding a task that needs a human.
   *
   * A task stopped without proof either way keeps scheduling frozen: whether
   * WorkBuddy finished it is exactly what nobody can answer from the ledger,
   * and "we no longer know" is not a green light for the next send.
   */
  private liveNeedsReconciliation(): boolean {
    const stage = this.store.snapshot().currentTask?.execution?.stage;
    return stage === "RECONCILIATION_REQUIRED";
  }

  /**
   * Drops the live record of one task the operator just closed.
   *
   * Only a record that is still frozen for reconciliation gets dropped, and
   * only the one named by the operator - a running task keeps its record, and
   * so does a task that belongs to somebody else.
   *
   * Nothing is requeued, enqueued or dispatched here, and no stage is written:
   * the relay did not observe WorkBuddy finish anything, so the record is
   * simply gone and the ledger row is the only thing it says about the task.
   */
  private async releaseLiveReconciliationTask(taskId: string): Promise<boolean> {
    let released = false;

    await this.store.mutate((state) => {
      const task = state.currentTask;
      if (task === null) return;
      if (task.taskId !== taskId) return;
      if (task.execution?.stage !== "RECONCILIATION_REQUIRED") return;

      state.currentTask = null;
      // A pause is an operator decision of its own and outlives a close:
      // releasing the hold must not silently start scheduling again.
      if (state.state !== "PAUSED" && state.state !== "STOPPED") state.state = "IDLE";
      released = true;
    });

    return released;
  }

  /** Reads the ledger and reports on every task it knows about. */
  private async runReconciliation(
    reason: string,
  ): Promise<ReconciliationReport | null> {
    if (!this.reconciliation) return null;

    try {
      const { report } = await this.reconciliation.reconcile(reason, this.liveReconciliationContext());
      await this.reconciliation.recordReconciliationOutcome(report);
      this.noteLedgerWrite();

      /*
       * Two things freeze scheduling, and they are not the same thing. The
       * ledger may hold a chain that cannot be explained; and the relay may
       * be holding a task *it* stopped mid-flight, where no chain can say
       * whether WorkBuddy finished it - reconciliation passing cleanly over
       * that task is not a clearance, because the relay already said it does
       * not know. A hold survives until a human resolves it either way.
       */
      const liveHold = this.liveNeedsReconciliation();

      /*
       * One assignment, and it is unconditional.
       *
       * The hold is a statement about the world as this pass just read it,
       * not a record that something once went wrong - so a pass that comes
       * back clean has to be able to release it. Assigning `true` only in the
       * blocked branch turned it into a latch nothing could ever clear, which
       * is how a production relay went on reporting
       * `reconciliationHold: true` after the operator had closed the very
       * task that froze it, with an empty queue and nothing in flight.
       */
      const shouldHold = report.blocked || liveHold;
      this.reconciliationHold = shouldHold;

      if (shouldHold) {
        const reasons = report.findings
          .filter((finding) => finding.severity === "blocking")
          .map((finding) => `${finding.kind}:${finding.taskId}`);
        // The live state can hold scheduling on its own, and it is not a
        // ledger finding - it is named here so the log says why.
        if (liveHold) reasons.push("live:RECONCILIATION_REQUIRED");

        await this.audit.write("reconciliation_blocked", {
          reason,
          tasks: report.tasks.map((task) => ({ taskId: task.taskId, state: task.state })),
        });
        console.error(
          `[relay] reconciliation blocked automatic scheduling (${reason}): ${reasons.join(", ")}`,
        );
        return report;
      }

      console.log(
        `[relay] reconciliation clean (${reason}): ${report.tasksSeen} task(s) checked; ` +
          `scheduling is released`,
      );
      return report;
    } catch (error) {
      console.error(
        `[relay] reconciliation failed (${reason}): ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
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
      /*
       * The item left the queue above, so from here until the round owns it,
       * this call stack is the only thing holding the task. A refusal that
       * happens before WorkBuddy has seen anything must give it straight
       * back - the same entry, not a copy of it - because "nothing was sent"
       * only means "safe to keep", never "safe to drop".
       *
       * A queued outcome is different on purpose: the pipeline already wrote
       * its own entry, so adding the original back would put the task on the
       * queue twice.
       */
      /*
       * `fromQueue`: the entry is already off the queue and this call stack is
       * the only thing holding it, so a scheduling refusal must hand it back
       * rather than let the pipeline queue a second copy under a new id.
       */
      const outcome = await this.dispatch.startTask(item.text, item.fingerprint, {
        fromQueue: true,
      });

      if (outcome.kind === "pre_send_rejected") {
        await this.retainPendingTask(item, outcome.reason);
      }

      return;
    }

    if (item.kind === "workbuddy_result") {
      if (!this.bridge.hasClient()) {
        await this.store.enqueue(item);
        return;
      }

      try {
        // The queue entry is the durable copy of a result that WorkBuddy
        // already ran, so a failed delivery re-sends the answer, never the task.
        await this.results.deliver({
          taskId: item.taskId,
          workbuddyMessageId: item.workbuddyMessageId,
          text: item.text,
          pendingId: item.id,
        });
      } catch {
        await this.store.enqueue(item);
      }
    }
  }

  /**
   * Gives a queue entry back to the queue, unchanged.
   *
   * This is the other half of `shiftPending`, and the half that used to be
   * missing: taking a task off the queue to decide about it is only safe while
   * every refusal puts it back. Nothing here retries, re-schedules or counts
   * an attempt - a task refused for want of proof has not been attempted, and
   * counting it would burn the retry budget on a question nobody answered.
   *
   * So the entry keeps its id, its text, its fingerprints, its taskId and its
   * retryCount, and the ledger is told where it is: a task in the queue is
   * readable as "queued, not sent", which is the one thing a startup
   * reconciliation must not mistake for a lost task.
   */
  private async retainPendingTask(item: PendingItem, reason: string): Promise<void> {
    await this.store.restorePending(item);

    const text = item.kind === "gpt_task" ? item.text : "";
    const taskId = ensureTaskId(text, makeId("task"));

    if (this.reconciliation && item.kind === "gpt_task") {
      await this.reconciliation.recordTaskEnqueued({
        taskId,
        taskFingerprint: taskFingerprint(text),
        dispatchId: item.dispatchId ?? null,
        attempt: item.attempt ?? null,
        source: "relay",
        detail: { reason, via: "pre_send_rejection" },
      });
      this.noteLedgerWrite();
    }

    await this.audit.write("task_retained", {
      taskId,
      reason,
      pendingId: item.id,
    });

    console.error(
      `[relay] task ${taskId} retained on the queue (${reason}): nothing was sent, ` +
        `nothing owns it but the queue, and no retry was counted`,
    );

    /*
     * Deliberately no `flushOnePending()` here. Re-flushing would make the
     * rejection schedule its own retry, and a task whose proof never arrives
     * would spin - one blocked event per tick, for ever. The next dispatch
     * needs a real trigger: a resume, a reconnect, or the next round ending.
     */
  }
}
