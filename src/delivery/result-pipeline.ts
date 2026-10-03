/**
 * The RESULT lifecycle: persist, deliver, acknowledge.
 *
 * Three facts that must never be collapsed into one:
 *
 *   WorkBuddy answered          is not   ChatGPT received the answer
 *   the answer was sent         is not   the extension said it took it
 *   the answer was queued       is not   the answer is safe
 *
 * So the answer is written to the durable queue FIRST, handed to the
 * extension SECOND, and only the extension's `chatgpt_send_result` closes the
 * round. A relay that dies between the second and the third finds the answer
 * still queued and re-delivers it - the one direction that loses nothing.
 *
 * This module owns the ordering and the lease. It knows nothing about
 * WorkBuddy's page, the router or the ledger: the relay hands it facts.
 */

import type { AppConfig } from "../config.js";
import type { AuditLog } from "../audit.js";
import type { BridgeServer } from "../bridge-server.js";
import type { RelayStore } from "../store.js";
import type { PendingItem } from "../types.js";
import { isoNow, makeId } from "../utils.js";
import type { TaskExecutionStage } from "./stage.js";
import { ResultDeliveryLedger, deliveryIdFor, resultDeliveryKey } from "./recovery.js";

/**
 * Thrown when the same result identity (task + WorkBuddy message) is asked to
 * persist two different payloads. That can only mean the outbox and a fresh
 * answer disagree about what this task produced, so the answer is not trusted:
 * it is failed closed rather than overwriting the durable copy.
 */
export class ResultIdentityContradiction extends Error {
  constructor(taskId: string, workbuddyMessageId: string) {
    super(
      `result identity contradiction for task ${taskId} message ${workbuddyMessageId}: ` +
        `a second, different payload was offered for an already-persisted result`,
    );
    this.name = "ResultIdentityContradiction";
  }
}

/** The write a stage change makes through to the ledger. */
export type StageWriter = (input: {
  taskId: string;
  stage: TaskExecutionStage;
  ledgerEvent: string;
  detail?: Record<string, unknown>;
}) => Promise<void>;

/** What the pipeline needs from the relay to observe the round's own facts. */
export type ResultPipelineHooks = {
  /** Writes the stage and its ledger event, with the current dispatch identity. */
  noteStage: StageWriter;
  /** Called once the round is really over; returns the relay's own bookkeeping. */
  onRoundCompleted: (taskId: string, reason: string) => Promise<boolean>;
  /** Called when a delivered-but-unacknowledged answer runs past its lease. */
  onLeaseExpired: (taskId: string) => Promise<void>;
};

export type ResultPipelineOptions = {
  store: RelayStore;
  audit: AuditLog;
  bridge: BridgeServer;
  config: AppConfig;
  hooks: ResultPipelineHooks;
};

/** The longest a delivered-but-unacknowledged round may hold its task. */
function leaseMs(config: AppConfig): number {
  const configured = config.relay?.resultLeaseMs;
  return typeof configured === "number" && configured > 0 ? configured : 120_000;
}

export class ResultPipeline {
  private readonly store: RelayStore;
  private readonly audit: AuditLog;
  private readonly bridge: BridgeServer;
  private readonly config: AppConfig;
  private readonly hooks: ResultPipelineHooks;
  /** One entry per RESULT accepted in this process, never per restart. */
  private readonly claimed = new ResultDeliveryLedger();
  private lease: { taskId: string; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(options: ResultPipelineOptions) {
    this.store = options.store;
    this.audit = options.audit;
    this.bridge = options.bridge;
    this.config = options.config;
    this.hooks = options.hooks;
  }

  /**
   * True when this exact RESULT has already been accepted in this process.
   *
   * Guards the window between the resumed turn and the turn that produced the
   * answer: both can see the same answer, and a RESULT is not a subscription.
   */
  alreadyAccepted(input: {
    taskId: string;
    workbuddyMessageId: string;
    dispatchId?: string | null;
  }): boolean {
    return this.claimed.has(resultDeliveryKey(input));
  }

  /**
   * Writes the answer to the durable queue and marks the round as holding one.
   *
   * Nothing is delivered here. The queue entry is what survives a crash in the
   * delivery window, and it is the reason the answer can be re-sent without
   * WorkBuddy being asked to run the task again.
   *
   * Idempotent on the result identity `(taskId, workbuddyMessageId)`: a second
   * call for the same answer returns the durable copy already on the queue
   * instead of appending a second logical result. A second call with a
   * different payload is a contradiction and is failed closed - the outbox is
   * never silently overwritten.
   */
  async persist(input: {
    taskId: string;
    workbuddyMessageId: string;
    text: string;
    detail?: Record<string, unknown>;
  }): Promise<PendingItem> {
    const existing = await this.store.findPendingResult(
      input.taskId,
      input.workbuddyMessageId,
    );

    if (existing) {
      if (existing.text !== input.text) {
        throw new ResultIdentityContradiction(input.taskId, input.workbuddyMessageId);
      }
      return existing;
    }

    const item: PendingItem = {
      kind: "workbuddy_result",
      id: makeId("pending-wb"),
      taskId: input.taskId,
      text: input.text,
      workbuddyMessageId: input.workbuddyMessageId,
      createdAt: isoNow(),
    };

    await this.store.enqueue(item);

    await this.store.mutate((state) => {
      if (state.currentTask?.taskId !== input.taskId) return;
      state.currentTask.status = "result_pending";
      state.currentTask.sentToGptAt = isoNow();
    });

    await this.hooks.noteStage({
      taskId: input.taskId,
      stage: "RESULT_PERSISTED",
      ledgerEvent: "RESULT_PERSISTED",
      detail: { pendingId: item.id, ...(input.detail ?? {}) },
    });

    return item;
  }

  /**
   * Hands the persisted answer to ChatGPT.
   *
   * DELIVERY and ACKNOWLEDGEMENT are two different facts, and only the second
   * one closes the round. Until the extension says it took the answer, the
   * task stays in the queue owner's hands and holds a lease.
   */
  async deliver(input: {
    taskId: string;
    workbuddyMessageId: string;
    text: string;
    pendingId?: string | null;
    detail?: Record<string, unknown>;
  }): Promise<void> {
    /*
     * The delivery identity is derived only from durable facts, so it is the
     * same string on every crash, restart and replay of this answer. The
     * extension keys its injection idempotency on it, which is what keeps a
     * recovery from putting the answer into ChatGPT a second time. It is also
     * echoed back as `requestId` so the acknowledgement can be bound to the
     * exact delivery that produced it.
     */
    const dispatchId = this.store.snapshot().currentTask?.dispatchId ?? null;
    const deliveryId = deliveryIdFor({
      taskId: input.taskId,
      workbuddyMessageId: input.workbuddyMessageId,
      dispatchId,
    });
    const requestId = deliveryId;

    await this.bridge.send({
      type: "send_to_chatgpt",
      requestId,
      deliveryId,
      text: input.text,
      autoSend: this.config.relay.autoSendToChatGPT,
    });

    await this.hooks.noteStage({
      taskId: input.taskId,
      stage: "RESULT_DELIVERED",
      ledgerEvent: "RESULT_DELIVERED",
      detail: {
        requestId,
        deliveryId,
        via: "bridge",
        autoSend: this.config.relay.autoSendToChatGPT,
        ...(input.detail ?? {}),
      },
    });

    await this.store.mutate((state) => {
      if (state.currentTask?.taskId !== input.taskId) return;
      state.currentTask.status = "sent_to_gpt";
      state.currentTask.sentToGptAt = isoNow();
      state.currentTask.deliveryId = deliveryId;
      state.state = "WAIT_GPT";
    });

    /*
     * The durable copy has done its job, but only after the round can no
     * longer be confused with an undelivered one. Dropping it any earlier
     * would let a crash look like a lost answer.
     */
    if (input.pendingId) {
      await this.store.removePending(input.pendingId);
    }

    await this.audit.write("workbuddy_result_sent_to_gpt", {
      taskId: input.taskId,
      workbuddyMessageId: input.workbuddyMessageId,
      requestId,
      deliveryId,
      autoSend: this.config.relay.autoSendToChatGPT,
    });
  }

  /**
   * Closes the round the way only the extension can: after it acknowledged a
   * delivery. Returns false when the round is already gone, so callers stay
   * idempotent.
   */
  async acknowledge(input: { taskId: string }): Promise<boolean> {
    const task = this.store.snapshot().currentTask;
    if (!task || task.taskId !== input.taskId) return false;
    if (task.status !== "sent_to_gpt") return false;

    if (this.lease?.taskId === input.taskId) {
      this.clearLease();
    }

    await this.hooks.onRoundCompleted(input.taskId, "gpt_send_confirmed");

    return true;
  }

  /**
   * Arms the lease for an answer nobody has acknowledged yet.
   *
   * The lease is armed the moment the RESULT exists, not when it is delivered:
   * a send that never lands must not hold the task hostage.
   */
  armLease(taskId: string): void {
    this.clearLease();

    const timer = setTimeout(() => {
      void this.hooks.onLeaseExpired(taskId);
    }, leaseMs(this.config));

    // A lease must never be the reason the process stays alive.
    timer.unref?.();

    this.lease = { taskId, timer };
  }

  clearLease(): void {
    if (!this.lease) return;
    clearTimeout(this.lease.timer);
    this.lease = null;
  }

  /** The lease holder, so a relay can show who is still waiting for an ACK. */
  leasedTaskId(): string | null {
    return this.lease?.taskId ?? null;
  }

  /** RESULT_LEASE_MS, so the relay can report the window it is working with. */
  leaseMs(): number {
    return leaseMs(this.config);
  }
}
