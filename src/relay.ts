import type { AppConfig } from "./config.js";
import { AuditLog } from "./audit.js";
import { BridgeServer } from "./bridge-server.js";
import { ensureTaskId, shouldForwardAssistantMessage, wrapWorkBuddyResult } from "./protocol.js";
import { RelayStore } from "./store.js";
import type { ExtensionInbound, PendingItem } from "./types.js";
import { browserFingerprint, isoNow, makeId } from "./utils.js";
import { WorkBuddyClient } from "./workbuddy.js";

export class ZhixingRelay {
  private workAbort: AbortController | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly bridge: BridgeServer,
    private readonly store: RelayStore,
    private readonly audit: AuditLog,
    private readonly workbuddy: WorkBuddyClient,
  ) {}

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
  }

  async workbuddyOnline(): Promise<boolean> {
    return this.workbuddy.online();
  }

  status() {
    return {
      ...this.store.snapshot(),
      bridgeConnected: this.bridge.hasClient(),
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
      );
      return;
    }

    await this.flushOnePending();
  }

  async stopCurrentRound(reason = "manual"): Promise<void> {
    this.workAbort?.abort();
    this.workAbort = null;

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
    switch (message.type) {
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
          const snapshot = this.store.snapshot();
          if (snapshot.currentTask?.status === "sent_to_gpt") {
            await this.store.setState("WAIT_GPT");
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

    if (
      !shouldForwardAssistantMessage(
        message.text,
        this.config.relay.gptForwardMode,
      )
    ) {
      console.log("[relay] GPT reply observed, but not marked as a relay TASK");
      return;
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
        text: message.text,
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
        text: message.text,
        fingerprint: message.fingerprint,
        createdAt: isoNow(),
      });
      console.log("[relay] GPT task queued because another task is active");
      return;
    }

    await this.startWorkBuddyTask(message.text, message.fingerprint);
  }

  private async startWorkBuddyTask(text: string, sourceFingerprint: string): Promise<void> {
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

    await this.store.mutate((state) => {
      state.state = "WAIT_WORKBUDDY";
      state.currentTask = {
        taskId,
        sourceFingerprint,
        sourceText: text,
        startedAt: isoNow(),
        status: "sending",
      };
    });

    await this.audit.write("workbuddy_send_start", {
      taskId,
      textLength: text.length,
    });

    try {
      const online = await this.workbuddy.online();
      if (!online) {
        throw new Error("WorkBuddy local assistant is offline");
      }

      const outboundId = await this.workbuddy.sendText(text);

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
        signal: this.workAbort.signal,
        onProgress: async (message) => {
          await this.audit.write("workbuddy_assistant_chunk", {
            taskId,
            messageId: message.message_id,
            msgType: message.msg_type,
          });
        },
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
    } catch (error) {
      this.workAbort = null;
      const detail = error instanceof Error ? error.message : String(error);

      await this.audit.write("workbuddy_turn_failed", {
        taskId,
        error: detail,
      });

      console.error(`[relay] WorkBuddy turn failed: ${detail}`);

      await this.store.mutate((state) => {
        state.currentTask = null;
        state.state = state.paused ? "PAUSED" : "IDLE";
      });
    }
  }

  private async resumeWorkBuddyWait(
    taskId: string,
    outboundId: string,
  ): Promise<void> {
    this.workAbort = new AbortController();

    await this.audit.write("workbuddy_wait_resumed", {
      taskId,
      workbuddyMessageId: outboundId,
    });

    try {
      const result = await this.workbuddy.waitForAssistantReply(outboundId, {
        signal: this.workAbort.signal,
        onProgress: async (message) => {
          await this.audit.write("workbuddy_assistant_chunk", {
            taskId,
            messageId: message.message_id,
            msgType: message.msg_type,
          });
        },
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
    } catch (error) {
      this.workAbort = null;

      const detail = error instanceof Error ? error.message : String(error);
      await this.audit.write("workbuddy_resumed_wait_failed", {
        taskId,
        error: detail,
      });
      console.error(`[relay] Resumed WorkBuddy wait failed: ${detail}`);
    }
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

  private async queueWorkBuddyResult(
    taskId: string,
    workbuddyMessageId: string,
    text: string,
    reason: string,
  ): Promise<void> {
    await this.store.mutate((state) => {
      if (state.currentTask?.taskId === taskId) {
        state.currentTask.status = "result_pending";
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

    await this.store.mutate((state) => {
      if (state.currentTask?.taskId === taskId) {
        state.currentTask.status = "sent_to_gpt";
      }
      state.state = "WAIT_GPT";
    });

    await this.audit.write("workbuddy_result_sent_to_gpt", {
      taskId,
      workbuddyMessageId,
      requestId,
      autoSend: this.config.relay.autoSendToChatGPT,
    });

    console.log(`[relay] WorkBuddy -> GPT task=${taskId}`);
  }

  private async expectInjectedText(text: string): Promise<void> {
    const fp = browserFingerprint("user", text);
    await this.store.expectInjectedUser(fp);
  }

  private async flushOnePending(): Promise<void> {
    const snapshot = this.store.snapshot();
    if (snapshot.paused || snapshot.currentTask?.status === "waiting_workbuddy") {
      return;
    }

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
