import type { AppConfig } from "../config.js";
import type { AuditLog } from "../audit.js";
import type { RelayStore } from "../store.js";
import type { WorkBuddyMessage } from "../types.js";
import type { WorkBuddyClient } from "../workbuddy.js";
import type { ModelRouter } from "../model-router/router.js";
import type { ModelSelection, ModelUnavailableReason } from "../model-router/types.js";
import type { ReconciliationService } from "../reconciliation/index.js";
import { ensureTaskId, parseRelayEnvelope } from "../protocol.js";
import { dispatchIdFor, taskFingerprint } from "../reconciliation/index.js";
import { AVAILABLE_DETECTION, quotaBlockUntil, type QuotaDetection } from "../workbuddy/quota.js";
import { classifyTurnFailure } from "../workbuddy/turn-ack.js";
import { isoNow, makeId } from "../utils.js";
import { createExecutionState, type TaskExecutionStage } from "./stage.js";
import { durableStageOf, sendIsProven } from "./recovery.js";

type EvidenceEvent = Parameters<ReconciliationService["recordExecutionEvidence"]>[0]["event"];

/**
 * One routed turn: the model the router picked for this task. Kept next to
 * the task lifecycle so every exit path can release the pin.
 */
export type RoutedModel = {
  id: string;
  label: string;
};

/**
 * Thrown when a turn stops on purpose: the fallback chain ran out and the
 * task was already handed back to the queue. It is not a failure of the send,
 * so it must not be requeued a second time.
 */
export class NoUsableModelError extends Error {}

/**
 * Thrown when the composer does not hold the payload before the click.
 *
 * Nothing reached WorkBuddy, so the task is still provably unsent and going
 * back to the queue is safe. That is the only case where a retry may follow.
 */
export class InputNotConfirmedError extends Error {}

/**
 * Thrown when WorkBuddy will not say whether the task was taken.
 *
 * The send click may already have happened, so a blind retry could duplicate a
 * task that is running. The round is frozen with its evidence instead: the
 * task record stays, nothing schedules, and only a reconciliation - or the
 * operator who knows what actually happened - may move it on.
 */
export class UnconfirmedDispatchError extends Error {}

/**
 * A durable move of one dispatch through its execution stage.
 *
 * Everything below is a coordination fact, not a policy: the pipeline asks the
 * relay for exactly the same writers the relay already owns, so no second
 * implementation of a stage or a ledger records anything.
 */
export type StageNote = {
  taskId: string;
  taskFingerprint?: string | null;
  dispatchId?: string | null;
  attempt?: number | null;
  stage: TaskExecutionStage;
  ledgerEvent: EvidenceEvent;
  workbuddyMessageId?: string | null;
  resultId?: string | null;
  detail?: Record<string, unknown> | null;
};

/**
 * What the dispatch pipeline needs from the relay.
 *
 * Every field is something the relay already owns - the store, the audit, the
 * stage writer - passed in rather than imported, so the pipeline can never
 * grow a side channel of its own.
 */
export interface DispatchPipelineDeps {
  config: AppConfig;
  store: RelayStore;
  audit: AuditLog;
  workbuddy: WorkBuddyClient;
  /** Optional so a relay can still run without routing. */
  router: ModelRouter | null;
  /** Null when the relay has no configured data path. */
  reconciliation: ReconciliationService | null;
  /** Publishes the task identity and decides whether it may be sent. */
  publishTask: (args: {
    taskId: string;
    fingerprint: string;
    messageFingerprint: string;
  }) => Promise<{ dispatchId: string; attempt: number } | null>;
  noteStage: (args: StageNote) => Promise<void>;
  /** The one place a WorkBuddy answer becomes a RESULT to ChatGPT. */
  onWorkBuddyResult: (taskId: string, outboundId: string, body: string) => Promise<void>;
  /** The only requeue path; a proven send never reaches it. */
  requeue: (args: {
    taskId: string;
    text: string;
    sourceFingerprint: string;
    reason: string;
    detail: string;
  }) => Promise<void>;
  /** Reads the ledger and acts on it; the single resend decision source. */
  reconcile: (reason: string) => Promise<void>;
  /** Marks the track as busy for the heartbeat and `status`. */
  noteActivity: () => void;
  /** The abort controller of the in-flight round, or null when there is none. */
  workAbort: () => AbortController | null;
  setWorkAbort: (controller: AbortController | null) => void;
}

/**
 * The dispatch execution pipeline.
 *
 * Owns everything between "GPT sent me a task" and "the answer is handed back
 * to the relay": identity publication, model routing, the send into
 * WorkBuddy, the wait, and the quota fallback loop that re-sends the SAME
 * task under the SAME taskId with a different model.
 *
 * It decides nothing on its own about what to do with a round that reached
 * WorkBuddy and then failed - that is left to the relay's catch path, which
 * owns the freeze-versus-requeue rule. This module only makes sure the
 * dispatch never re-sends a text that is already on the page.
 */
export class DispatchPipeline {
  constructor(private readonly deps: DispatchPipelineDeps) {}

  /**
   * Publishes the task and drives one round to its answer.
   *
   * The whole round - routing, sending, waiting - is a single sequence here so
   * that no path between "no model" and "WorkBuddy answered" can slip a
   * requeue in.
   */
  async startTask(text: string, sourceFingerprint: string): Promise<void> {
    const { store, audit, router } = this.deps;

    this.deps.noteActivity();
    console.log("[Relay] startWorkBuddyTask BEGIN");

    const snapshot = store.snapshot();

    console.log("[Relay] snapshot OK");

    const taskId = ensureTaskId(text, makeId("task"));
    const fingerprint = taskFingerprint(text);

    if (snapshot.paused) {
      await this.recordEnqueued({
        taskId,
        taskFingerprint: fingerprint,
        reason: "relay_paused",
      });
      await store.enqueue({
        kind: "gpt_task",
        id: makeId("pending-gpt"),
        text,
        fingerprint: sourceFingerprint,
        createdAt: isoNow(),
      });
      return;
    }

    /*
     * Identity first, WorkBuddy second. From here the ledger decides whether
     * this task may be sent, so a task that already ran - or that contradicts
     * an earlier envelope of the same name - stops here instead of going out
     * a second time.
     */
    const plan = await this.deps.publishTask({
      taskId,
      fingerprint,
      messageFingerprint: sourceFingerprint,
    });
    if (!plan) return;

    /*
     * Accepted for a turn. Written before anything else can decide against
     * sending, so the ledger always shows whether the relay meant to run this
     * task - a later "enqueued" then says why it did not run now, and a
     * "DISPATCH_STARTED" says it did.
     */
    if (this.deps.reconciliation) {
      await this.deps.reconciliation.recordTaskAccepted({
        taskId,
        taskFingerprint: fingerprint,
        messageFingerprint: sourceFingerprint,
      });
    }

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

    if (router) {
      let selection: ModelSelection;

      try {
        selection = router.selectModel({
          requestedModelId,
          now: new Date(),
        });
      } catch (error) {
        // A router that cannot even answer is not a reason to drop the task.
        await this.holdForModelRecovery(taskId, text, sourceFingerprint, {
          taskFingerprint: fingerprint,
          nextResetAt: null,
          reasons: [],
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      if (selection.kind === "no_available_model") {
        await this.holdForModelRecovery(taskId, text, sourceFingerprint, {
          taskFingerprint: fingerprint,
          nextResetAt: selection.nextResetAt,
          reasons: selection.reasons,
        });
        return;
      }

      routed = { id: selection.model.id, label: selection.model.label };
      router.pin(routed.id);

      await audit.write("model_routed", {
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

    if (this.deps.reconciliation) {
      await this.deps.reconciliation.recordDispatch({
        taskId,
        taskFingerprint: fingerprint,
        dispatchId: plan.dispatchId,
        attempt: plan.attempt,
        model: routed?.id ?? null,
      });
    }

    try {
      const online = await this.deps.workbuddy.online();
      if (!online) {
        throw new Error("WorkBuddy local assistant is offline");
      }

      const outcome = await this.runTurn({
        taskId,
        text,
        sourceFingerprint,
        requestedModelId,
        routed,
        dispatchId: plan.dispatchId,
        taskFingerprint: fingerprint,
        attempt: plan.attempt,
        signal: this.deps.workAbort()?.signal,
        onProgress: async (message) => {
          await audit.write("workbuddy_assistant_chunk", {
            taskId,
            messageId: message.message_id,
            msgType: message.msg_type,
          });
        },
      });

      await this.deps.onWorkBuddyResult(taskId, outcome.lastMessageId, outcome.body);
    } catch (error) {
      this.deps.setWorkAbort(null);
      const detail = error instanceof Error ? error.message : String(error);

      /*
       * A failure AFTER the payload was proven to be on the page is not a
       * failure of the send, it is a failure of the wait - and a wait that ran
       * out is exactly the case where sending again is the worst answer
       * available: WorkBuddy may have been working on the message the whole
       * time, and the extension is busy answering a second copy.
       *
       * So the round freezes on its own evidence: the dispatch identity, the
       * stage it reached and the message id stay exactly as they were, the
       * task record is left in place so the evidence survives the next
       * restart, and only a human decision (resolveReconciliation) moves it.
       */
      if (sendIsProven(durableStageOf(this.deps.store.snapshot().currentTask))) {
        await this.deps.noteStage({
          taskId,
          taskFingerprint: fingerprint,
          dispatchId: plan.dispatchId,
          attempt: plan.attempt,
          stage: "RECONCILIATION_REQUIRED",
          ledgerEvent: "DISPATCH_STALLED",
          detail: {
            outcome: classifyTurnFailure(error),
            reason: detail,
            stage: this.deps.store.snapshot().currentTask?.execution?.stage ?? "DISPATCHING",
          },
        });

        await audit.write("workbuddy_wait_failed", {
          taskId,
          dispatchId: plan.dispatchId,
          attempt: plan.attempt,
          error: detail,
          action: "frozen_for_human_decision",
        });

        console.error(
          `[relay] task ${taskId} froze after a proven send (${detail}); ` +
            `no re-send, the round waits for a human decision`,
        );

        await this.deps.reconcile(`frozen dispatch of ${taskId}`);
        return;
      }

      /*
       * The chain already ran out: the task is in the queue with its
       * model_no_available record, so requeuing here would duplicate it.
       */
      const noUsableModel = error instanceof NoUsableModelError;

      if (noUsableModel) {
        await audit.write("workbuddy_turn_abandoned", {
          taskId,
          error: detail,
        });
      } else if (error instanceof UnconfirmedDispatchError) {
        /*
         * The task record stays exactly as it is, carrying
         * RECONCILIATION_REQUIRED. A click may already have gone out, so the
         * honest next step is a reconciliation and a human decision - not a
         * requeue that could send the task a second time. The record being
         * left in place is also what keeps the persisted stage alive across a
         * restart, so the evidence is not lost with the process.
         */
        await audit.write("dispatch_unconfirmed", {
          taskId,
          dispatchId: plan.dispatchId,
          error: detail,
        });

        console.error(
          `[relay] task ${taskId} left in reconciliation, NOT requeued: ${detail}`,
        );

        /*
         * The record carries RECONCILIATION_REQUIRED, so the chain is read at
         * once: if it cannot be explained, scheduling freezes here instead of
         * queuing the next task behind an answer nobody knows was sent.
         */
        await this.deps.reconcile(`unconfirmed dispatch of ${taskId}`);
      } else {
        await audit.write("workbuddy_turn_failed", {
          taskId,
          error: detail,
        });

        console.error(`[relay] WorkBuddy turn failed: ${detail}`);

        // A cancelled or failed turn is not a lost task: it goes back to the
        // queue carrying the reason, and the pin is released below.
        await this.deps.requeue({
          taskId,
          text,
          sourceFingerprint,
          reason: detail,
          detail,
        });
      }

      if (!(error instanceof UnconfirmedDispatchError)) {
        await store.mutate((state) => {
          state.currentTask = null;
          state.state = state.paused ? "PAUSED" : "IDLE";
        });
      }
    } finally {
      /*
       * Whatever happened - send failure, CDP drop, a real cancellation or a
       * completion wait error - the task is over, so its claim on the model
       * ends here. Releasing in `finally` is what keeps a failed turn from
       * pinning the router forever.
       */
      router?.releasePin();
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
  async runTurn(args: {
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
    const { deps } = this;
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
        deps.setWorkAbort(new AbortController());

        const signal = args.signal ?? deps.workAbort()?.signal;

        const recovered = await deps.workbuddy.waitForAssistantReply(resumedId, {
          ...(signal ? { signal } : {}),
          ...(args.onProgress ? { onProgress: args.onProgress } : {}),
        });

        deps.setWorkAbort(null);
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
      const sendId = args.dispatchId ?? dispatchIdFor(taskId, 0);
      const sendAttempt = args.attempt ?? 0;
      const sendFingerprint = args.taskFingerprint ?? "";

      await deps.store.mutate((state) => {
        state.state = "WAIT_WORKBUDDY";
        state.currentTask = {
          taskId,
          sourceFingerprint: args.sourceFingerprint,
          sourceText: text,
          startedAt: state.currentTask?.startedAt ?? isoNow(),
          status: "sending",
          taskFingerprint: sendFingerprint,
          dispatchId: sendId,
          attempt: sendAttempt,
          execution: createExecutionState({ stage: "DISPATCHING", at: isoNow() }),
          ...(current ? { modelId: current.id, modelLabel: current.label } : {}),
        };
      });

      await deps.audit.write("workbuddy_send_start", {
        taskId,
        dispatchId: sendId,
        attempt: sendAttempt,
        textLength: text.length,
        ...(current ? { modelId: current.id, modelLabel: current.label } : {}),
      });

      // Apply the routed model and only then hand over the task text.
      if (current) {
        await this.applyRoutedModel(taskId, current);
      }

      const ack = await deps.workbuddy.sendText(text, {
        taskId,
        pollIntervalMs: deps.config.workbuddy.pollIntervalMs,
        sendConfirmTimeoutMs: deps.config.relay.sendConfirmTimeoutMs,
      });

      /*
       * INPUT first, and only then anything else. The composer has to be read
       * back and matched before a click can happen, so a mismatch here is the
       * one send failure the task can walk away from - nothing was clicked.
       */
      await deps.noteStage({
        taskId,
        taskFingerprint: sendFingerprint,
        dispatchId: sendId,
        attempt: sendAttempt,
        stage: ack.input.ok ? "INPUT_CONFIRMED" : "BLOCKED",
        ledgerEvent: ack.input.ok ? "INPUT_CONFIRMED" : "INPUT_CONFIRM_FAILED",
        detail: { ...ack.input, composer: ack.input.reason, clickAttempted: ack.clickOk },
      });

      if (!ack.input.ok) {
        throw new InputNotConfirmedError(
          `WorkBuddy composer did not hold the payload for ${taskId} (${ack.input.reason}); nothing was clicked`,
        );
      }

      /*
       * A successful click is the weakest fact there is. Without a new turn
       * carrying this task the world after the click is genuinely unknown, and
       * unknown is a reconciliation case - never an implicit success and never
       * a reason to send again.
       */
      if (!ack.send.ok) {
        await deps.noteStage({
          taskId,
          taskFingerprint: sendFingerprint,
          dispatchId: sendId,
          attempt: sendAttempt,
          stage: "RECONCILIATION_REQUIRED",
          ledgerEvent: "SEND_CONFIRM_FAILED",
          workbuddyMessageId: ack.send.observedMessageId,
          detail: { ...ack.send },
        });
        throw new UnconfirmedDispatchError(
          `the send of ${taskId} could not be confirmed (${ack.send.reason}); reconciliation required`,
        );
      }

      const outboundId = ack.send.observedMessageId ?? ack.outboundId;

      await deps.noteStage({
        taskId,
        taskFingerprint: sendFingerprint,
        dispatchId: sendId,
        attempt: sendAttempt,
        stage: "SEND_CONFIRMED",
        ledgerEvent: "SEND_CONFIRMED",
        workbuddyMessageId: outboundId,
        detail: { ...ack.send, clickOk: ack.clickOk },
      });

      await deps.store.mutate((state) => {
        if (!state.currentTask || state.currentTask.taskId !== taskId) return;
        state.currentTask.workbuddyOutboundMessageId = outboundId;
        state.currentTask.status = "waiting_workbuddy";
        state.state = "WAIT_WORKBUDDY";
      });

      await deps.audit.write("workbuddy_message_sent", {
        taskId,
        dispatchId: sendId,
        attempt: sendAttempt,
        workbuddyMessageId: outboundId,
      });

      console.log(`[relay] GPT -> WorkBuddy task=${taskId} message=${outboundId}`);

      deps.setWorkAbort(new AbortController());

      /*
       * RUNNING is a separate confirmation for a separate question. WorkBuddy
       * showing the message is not the same fact as WorkBuddy working on it,
       * and only one of those two ever deserves the name "confirmed started".
       */
      const runningSignal = args.signal ?? deps.workAbort()?.signal;

      const running = await deps.workbuddy.waitForRunning({
        pollIntervalMs: deps.config.workbuddy.pollIntervalMs,
        timeoutMs: deps.config.relay.runningConfirmTimeoutMs,
        ...(runningSignal ? { signal: runningSignal } : {}),
      });

      if (running.outcome === "cancelled") {
        await deps.noteStage({
          taskId,
          taskFingerprint: sendFingerprint,
          dispatchId: sendId,
          attempt: sendAttempt,
          stage: "RECONCILIATION_REQUIRED",
          ledgerEvent: "DISPATCH_STALLED",
          workbuddyMessageId: outboundId,
          detail: { outcome: "cancelled", reason: running.reason, evidence: running.evidence },
        });
        throw new UnconfirmedDispatchError(
          `WorkBuddy cancelled task ${taskId} after the send was confirmed`,
        );
      }

      if (running.outcome === "timeout") {
        await deps.noteStage({
          taskId,
          taskFingerprint: sendFingerprint,
          dispatchId: sendId,
          attempt: sendAttempt,
          stage: "RECONCILIATION_REQUIRED",
          ledgerEvent: "RUNNING_CONFIRM_TIMEOUT",
          workbuddyMessageId: outboundId,
          detail: { outcome: "timeout", reason: running.reason, evidence: running.evidence },
        });
        throw new UnconfirmedDispatchError(
          `WorkBuddy neither ran nor answered ${taskId} inside the confirmation window`,
        );
      }

      /*
       * "running" and "result_ready" are both the task really executing: one
       * was watched working, the other finished inside the window. A finished
       * answer must never be dropped for want of a running confirmation.
       */
      await deps.noteStage(
        running.outcome === "running"
          ? {
              taskId,
              taskFingerprint: sendFingerprint,
              dispatchId: sendId,
              attempt: sendAttempt,
              stage: "RUNNING_CONFIRMED",
              ledgerEvent: "RUNNING_CONFIRMED",
              workbuddyMessageId: outboundId,
              detail: { reason: running.reason, evidence: running.evidence },
            }
          : {
              taskId,
              taskFingerprint: sendFingerprint,
              dispatchId: sendId,
              attempt: sendAttempt,
              stage: "RESULT_RECEIVED",
              ledgerEvent: "RESULT_RECEIVED",
              workbuddyMessageId: outboundId,
              detail: { outcome: "result_ready", reason: running.reason, evidence: running.evidence },
            },
      );

      let answer: { text: string; lastMessageId: string } | null = null;

      try {
        const waitedSignal = args.signal ?? deps.workAbort()?.signal;

        const waited = await deps.workbuddy.waitForAssistantReply(outboundId, {
          ...(waitedSignal ? { signal: waitedSignal } : {}),
          ...(args.onProgress ? { onProgress: args.onProgress } : {}),
        });
        answer = { text: waited.text, lastMessageId: waited.lastMessageId };
      } catch (error) {
        deps.setWorkAbort(null);

        /*
         * A cancellation that surfaces here still happened after the task was
         * sent, so it is a reconciliation case - never a failure that earns a
         * retry.
         */
        if (classifyTurnFailure(error) === "cancelled") {
          await deps.noteStage({
            taskId,
            taskFingerprint: sendFingerprint,
            dispatchId: sendId,
            attempt: sendAttempt,
            stage: "RECONCILIATION_REQUIRED",
            ledgerEvent: "DISPATCH_STALLED",
            workbuddyMessageId: outboundId,
            detail: {
              outcome: "cancelled",
              reason: error instanceof Error ? error.message : String(error),
            },
          });
          throw new UnconfirmedDispatchError(
            `WorkBuddy cancelled task ${taskId} while its answer was being waited for`,
          );
        }

        throw error;
      }

      deps.setWorkAbort(null);

      /*
       * Output means the turn ran. Whether or not it finishes is not known
       * yet, and that is the one thing that must never be guessed at.
       */
      await deps.noteStage({
        taskId,
        taskFingerprint: sendFingerprint,
        dispatchId: sendId,
        attempt: sendAttempt,
        stage: "RESULT_RECEIVED",
        ledgerEvent: "RESULT_RECEIVED",
        workbuddyMessageId: outboundId,
        resultId: outboundId,
        detail: { bodyLength: answer?.text.length ?? 0, observedBy: "wait" },
      });

      if (!answer || !answer.text) {
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

      return { lastMessageId: answer?.lastMessageId ?? outboundId, body: answer?.text ?? "" };
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
    const { workbuddy, audit } = this.deps;

    const before = await workbuddy.getCurrentModel().catch(() => null);

    if (before === routed.label) {
      await audit.write("model_already_active", {
        taskId,
        modelId: routed.id,
        modelLabel: routed.label,
      });
      return;
    }

    await workbuddy.selectModel(routed.label);

    await audit.write("model_selected", {
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
    const { workbuddy, audit } = this.deps;

    try {
      const detection = await workbuddy.detectQuota();

      await audit.write("workbuddy_quota_probe", {
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
      await audit.write("workbuddy_quota_probe_failed", {
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
    const { router, store, audit } = this.deps;
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
    await router?.blockModel(
      routed.id,
      blockedUntil,
      `quota exhausted: ${quota.reason ?? routed.label}`,
    );
    router?.releasePin();

    await audit.write("model_quota_blocked", {
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

    if (!router) return null;

    /*
     * This attempt is finished and the task is going back to the queue, so the
     * store must stop reserving it - otherwise "another task is active" would
     * hide the re-queued task behind its own stale currentTask.
     */
    const dropCurrent = async (): Promise<void> => {
      await store.mutate((state) => {
        if (state.currentTask?.taskId !== taskId) return;
        state.currentTask = null;
        state.state = state.paused ? "PAUSED" : "IDLE";
      });
    };

    let selection: ModelSelection;

    try {
      selection = router.selectModel({
        requestedModelId: args.requestedModelId,
        now: new Date(),
      });
    } catch (error) {
      await dropCurrent();
      await this.holdForModelRecovery(taskId, args.text, args.sourceFingerprint, {
        taskFingerprint: this.currentFingerprint(taskId),
        nextResetAt: blockedUntil,
        reasons: [],
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }

    if (selection.kind === "no_available_model") {
      await dropCurrent();
      await this.holdForModelRecovery(taskId, args.text, args.sourceFingerprint, {
        taskFingerprint: this.currentFingerprint(taskId),
        nextResetAt: selection.nextResetAt,
        reasons: selection.reasons,
      });
      return null;
    }

    const next: RoutedModel = {
      id: selection.model.id,
      label: selection.model.label,
    };

    router.pin(next.id);

    await audit.write("model_routed", {
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

  /** The fingerprint the durable record still carries for a task. */
  private currentFingerprint(taskId: string): string {
    const live = this.deps.store.snapshot().currentTask;
    return live && live.taskId === taskId && live.taskFingerprint ? live.taskFingerprint : "*";
  }

  /** Bounded, so an always-exhausted model cannot spin the turn. */
  private quotaRetryLimit(): number {
    const configured = this.deps.config.modelRouter?.quotaRetries;
    return typeof configured === "number" && configured >= 0
      ? configured
      : 2;
  }

  /** Fallback block length when the notice carries no reset time. */
  private quotaBlockMs(): number {
    const configured = this.deps.config.modelRouter?.quotaBlockMs;
    return typeof configured === "number" && configured > 0
      ? configured
      : 3_600_000;
  }

  /**
   * One task went to the pending queue.
   *
   * The ledger records the queue, not just the failures: a task that never ran
   * because the relay was paused, or because no model was usable, is exactly
   * the chain that reconciliation has to be able to read as "queued, not
   * sent" instead of guessing a state the ledger never wrote.
   */
  private async recordEnqueued(input: {
    taskId: string;
    taskFingerprint: string;
    dispatchId?: string | null;
    attempt?: number | null;
    reason: string;
    detail?: Record<string, unknown> | null;
  }): Promise<void> {
    if (!this.deps.reconciliation) return;

    await this.deps.reconciliation.recordTaskEnqueued(input);
  }

  /**
   * No model is usable right now. The task is kept, never sent, and never
   * silently handed to a blocked model - a future quota watcher can pick it
   * back up once something recovers.
   */
  private async holdForModelRecovery(
    taskId: string,
    text: string,
    sourceFingerprint: string,
    detail: {
      nextResetAt: string | null;
      reasons: ModelUnavailableReason[];
      error?: string;
      taskFingerprint?: string | undefined;
    },
  ): Promise<void> {
    const { store, audit } = this.deps;

    await this.recordEnqueued({
      taskId,
      taskFingerprint: detail.taskFingerprint ?? "*",
      reason: "no_available_model",
      dispatchId: store.snapshot().currentTask?.dispatchId ?? null,
      attempt: store.snapshot().currentTask?.attempt ?? null,
      detail: { nextResetAt: detail.nextResetAt },
    });

    await store.enqueue({
      kind: "gpt_task",
      id: makeId("pending-gpt"),
      text,
      fingerprint: sourceFingerprint,
      createdAt: isoNow(),
      taskId,
      reason: "no_available_model",
    });

    await audit.write("model_no_available", {
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
}
