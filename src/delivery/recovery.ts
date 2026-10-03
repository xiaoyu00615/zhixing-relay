/**
 * What a restarted relay must do with the task it finds on disk.
 *
 * The decision is made from the durable record alone. A process that comes
 * back after a crash cannot know whether the message it sent is still in
 * WorkBuddy's composer, whether WorkBuddy already ran it, or whether the
 * answer has already reached ChatGPT - so it must not guess, and it must not
 * send again. Sending again is the one action that cannot be undone: it makes
 * WorkBuddy run a task a second time and gives ChatGPT two answers.
 *
 * Everything here is a pure function of the persisted task record: no timers,
 * no bridge, no DOM.
 */

import { isTaskExecutionStage, stageRank, type TaskExecutionStage } from "./stage.js";

/** The task record the relay persists while a round is in flight. */
export type RecoverableTask = {
  taskId: string;
  status: string;
  /** Set once a message has been observed on the page for this task. */
  workbuddyOutboundMessageId?: string | null | undefined;
  modelId?: string | null | undefined;
  /** Identity of the send, so a recovered wait cannot be mistaken for a new one. */
  dispatchId?: string | null | undefined;
  attempt?: number | null | undefined;
  execution?: { stage?: unknown } | null | undefined;
  /**
   * True when a `workbuddy_result` outbox entry for this task already sits in
   * the durable queue. The outbox is the source of truth for a result that has
   * not yet been delivered: its presence means the answer is safe and must be
   * re-delivered, never re-fetched from WorkBuddy.
   */
  hasPendingResult?: boolean | undefined;
};

export type RecoveryPlan =
  /**
   * A message is already in WorkBuddy and the round must simply listen for it.
   * The task record is untouched: nothing is typed, nothing is clicked.
   */
  | { kind: "resume_wait"; taskId: string; outboundId: string; modelId?: string | null }
  /** An answer already persisted; re-deliver THAT answer, never re-run the task. */
  | { kind: "redeliver_result"; taskId: string }
  /**
   * The answer was already handed to the extension (durable RESULT_DELIVERED /
   * RESULT_ACKED evidence exists) but the round is still open. Do NOT re-deliver
   * and do NOT re-wait WorkBuddy: the only safe move is to re-arm the lease and
   * let the acknowledgement - or a thread observation - close the round.
   */
  | { kind: "wait_ack"; taskId: string }
  /**
   * A send was attempted and never confirmed. The click may have landed, so
   * the task is frozen for a human: it is not re-sent, not re-waited, and not
   * treated as never-tried.
   */
  | { kind: "reconcile_send_attempt"; taskId: string }
  /** Only the queue needs attention. */
  | { kind: "flush_queue" };

/**
 * A stable identity for one logical delivery of one logical result.
 *
 * Built only from durable facts (task id, dispatch id, the WorkBuddy message
 * the answer came from), so it is identical across every crash, restart and
 * recovery the same answer walks through. The bridge sink keys its idempotency
 * on this, which is what lets a recovery replay the delivery without injecting
 * the answer into ChatGPT a second time.
 */
export function deliveryIdFor(input: {
  taskId: string;
  workbuddyMessageId: string;
  dispatchId?: string | null;
}): string {
  return `delivery:${input.taskId}#${input.dispatchId ?? "*"}#${input.workbuddyMessageId}`;
}

/** Statuses that mean the round is still alive and only needs a listener. */
const RUNNING_STATUSES = new Set([
  "sending",
  "sending_confirmed",
  "waiting_workbuddy",
  "result_pending",
  "sent_to_gpt",
]);

/** The durable stage, defaulting to the first one when the read says nothing. */
function durableStage(task: RecoverableTask): string {
  const stage = task.execution?.stage;
  return typeof stage === "string" && isTaskExecutionStage(stage) ? stage : "DISPATCHING";
}

/** The stage a persisted record stopped at, for callers that hold only the record. */
export function durableStageOf(task: RecoverableTask | null): string {
  return task ? durableStage(task) : "DISPATCHING";
}

/**
 * True once the record proves the payload reached the page.
 *
 * Before `SEND_CONFIRMED` nothing has been *shown* to WorkBuddy, so nothing can
 * have run: retrying is still honest. At and after `SEND_CONFIRMED` a message
 * exists, and the only correct action for an unknown outcome is to stop and let
 * a human decide - restarting the send would duplicate the task.
 *
 * `SEND_ATTEMPTED` sits below `SEND_CONFIRMED` on purpose and is therefore NOT
 * proof. It is the fence written just before the click: the record says a click
 * was about to happen, which is a reason to freeze, not a reason to claim the
 * message was delivered. This function answers "do we know it arrived?", and the
 * honest answer past the fence is still "we do not know" - which is why the
 * fence is read separately, as uncertainty, rather than here as proof.
 */
export function sendIsProven(stage: string): boolean {
  const rank = isTaskExecutionStage(stage) ? stageRank(stage) : -1;
  return rank >= stageRank("SEND_CONFIRMED");
}

/**
 * The whole restart decision.
 *
 * The order matters: the durable outbox outranks everything, because a result
 * that already sits in the queue is safe to re-deliver while re-running its
 * task never is. Next comes proof that the extension already took the answer:
 * re-delivering it again would be a duplicate, so the round is parked on its
 * lease. Only then does a message still in WorkBuddy justify a listener, and a
 * task that was never shown is left to the queue.
 */
export function planRecovery(task: RecoverableTask | null): RecoveryPlan {
  if (!task) return { kind: "flush_queue" };

  const stage = durableStage(task);

  /*
   * 1. The durable record already proves the extension received the answer
   *    (RESULT_DELIVERED or RESULT_ACKED on the ledger). Re-sending it again
   *    would duplicate the message in ChatGPT even with the sink's idempotency
   *    gate - the gate is a backstop, never a license to re-send. The only
   *    honest move is to wait for the acknowledgement (or a thread observation)
   *    to close the round; the lease is re-armed by the caller so a lost ack
   *    still expires instead of hanging for ever.
   *
   *    This check outranks `hasPendingResult` on purpose: a crash can leave the
   *    outbox entry in place after the ledger already recorded the delivery
   *    (the outbox is removed only after RESULT_DELIVERED is written). When both
   *    are present, the delivery is the stronger proof, so we park on the lease
   *    rather than risk a duplicate.
   */
  if (stageRank(stage as TaskExecutionStage) >= stageRank("RESULT_DELIVERED")) {
    return { kind: "wait_ack", taskId: task.taskId };
  }

  /*
   * 2. The outbox is the source of truth for a result that has been received
   *    but not yet proven delivered. Its presence means the answer is durable
   *    and must be handed to the extension again - never re-fetched from
   *    WorkBuddy, which would produce a second logical result. This covers the
   *    "persist crash window": the queue holds the answer even when the live
   *    status still says waiting_workbuddy.
   */
  if (task.hasPendingResult) {
    return { kind: "redeliver_result", taskId: task.taskId };
  }

  /*
   * 3. The ledger names a result stage (the answer was received, or was even
   *    "persisted") but neither the outbox nor a delivery exists. That is a
   *    contradiction: the persist path enqueues the outbox BEFORE it writes
   *    RESULT_PERSISTED, so a RESULT_PERSISTED with no payload can only mean the
   *    durable outbox was lost, and a RESULT_RECEIVED with no outbox means the
   *    answer was never queued. Re-waiting WorkBuddy would re-run the task and
   *    re-fetch an answer that is already gone, so fail closed: do nothing that
   *    can invent a result or re-run the task. A human reconciles it. No
   *    resume_wait, no redeliver.
   */
  if (stageRank(stage as TaskExecutionStage) >= stageRank("RESULT_RECEIVED")) {
    return { kind: "flush_queue" };
  }

  const outboundId = task.workbuddyOutboundMessageId;

  /*
   * 4. A recorded send attempt that was never confirmed.
   *
   * The fence says the click was about to happen. Whether it landed is not in
   * the record, so there is nothing to wait for - no message id was ever
   * observed - and nothing safe to do either. This is deliberately NOT a
   * `resume_wait`: listening for a turn that may never arrive would leave the
   * round open against a composer that may or may not have been submitted.
   *
   * It is also never downgraded by waiting. Time does not make an unconfirmed
   * click safer, so the only exit is a human decision.
   */
  if (stage === "SEND_ATTEMPTED") {
    return { kind: "reconcile_send_attempt", taskId: task.taskId };
  }

  if (outboundId && RUNNING_STATUSES.has(task.status)) {
    return {
      kind: "resume_wait",
      taskId: task.taskId,
      outboundId,
      ...(task.modelId ? { modelId: task.modelId } : {}),
    };
  }

  /*
   * A record that names a result stage but has neither the outbox nor delivery
   * evidence is contradictory (the persist path always queues before it writes
   * RESULT_PERSISTED). The conservative reading is "do nothing that can invent a
   * result or re-run the task": a human reconciles it. No resume_wait, no
   * redeliver.
   */
  return { kind: "flush_queue" };
}

/** Whether the durable record says a message is already on the page. */
export function hasProvenSend(task: RecoverableTask | null): boolean {
  if (!task) return false;
  return sendIsProven(durableStage(task));
}

/**
 * Lets one dispatch own a recovered wait exactly once.
 *
 * `/control/resume` answers immediately and the wait runs in the background,
 * which is what makes a resume under pm2 usable at all. That also means a
 * second resume can arrive while the first turn is still listening: without
 * this gate the relay would read the same message twice and forward two
 * answers - once from the resumed turn, once from the new one.
 */
export class ResumeGuard {
  private owner: string | null = null;

  /** True when this dispatch is the one allowed to run the recovered wait. */
  claim(dispatchId: string): boolean {
    if (this.owner === dispatchId) return false;
    this.owner = dispatchId;
    return true;
  }

  /** True when the dispatch currently owns the recovered wait. */
  holds(dispatchId: string): boolean {
    return this.owner === dispatchId;
  }

  /** The dispatch holding the wait, so a restart can tell the round apart. */
  heldBy(): string | null {
    return this.owner;
  }

  release(dispatchId?: string): void {
    if (dispatchId === undefined || this.owner === dispatchId) {
      this.owner = null;
    }
  }
}

/**
 * Recognises the same RESULT arriving twice.
 *
 * A recovered turn and the turn that produced it can both reach
 * "WorkBuddy answered" for one dispatch, and every later relay restart starts
 * with an empty memory. The key is the dispatch identity plus the message the
 * answer came from, so two different tasks can never collide.
 */
export function resultDeliveryKey(input: {
  taskId: string;
  workbuddyMessageId: string;
  dispatchId?: string | null;
}): string {
  return `${input.taskId}#${input.dispatchId ?? "*"}#${input.workbuddyMessageId}`;
}

export class ResultDeliveryLedger {
  private readonly seen = new Set<string>();

  /** True the first time a particular RESULT is accepted. */
  claim(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  /** True once a result of this dispatch has been accepted. */
  has(key: string): boolean {
    return this.seen.has(key);
  }

  size(): number {
    return this.seen.size;
  }
}
