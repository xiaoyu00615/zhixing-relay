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

import { isTaskExecutionStage, stageRank } from "./stage.js";

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
};

export type RecoveryPlan =
  /**
   * A message is already in WorkBuddy and the round must simply listen for it.
   * The task record is untouched: nothing is typed, nothing is clicked.
   */
  | { kind: "resume_wait"; taskId: string; outboundId: string; modelId?: string | null }
  /** An answer already persisted; re-deliver THAT answer, never re-run the task. */
  | { kind: "redeliver_result" }
  /** Only the queue needs attention. */
  | { kind: "flush_queue" };

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
 * Before `SEND_CONFIRMED` nothing has been shown to WorkBuddy, so nothing can
 * have run: retrying is still honest. At and after `SEND_CONFIRMED` a message
 * exists, and the only correct action for an unknown outcome is to stop and
 * let a human decide - restarting the send would duplicate the task.
 */
export function sendIsProven(stage: string): boolean {
  const rank = isTaskExecutionStage(stage) ? stageRank(stage) : -1;
  return rank >= stageRank("SEND_CONFIRMED");
}

/**
 * The whole restart decision.
 *
 * The order matters: an answer that has already been persisted outranks
 * everything, because re-delivering it is safe while re-running its task never
 * is. A task that only ever reached the composer is recovered by listening;
 * one that was never shown is left to the queue.
 */
export function planRecovery(task: RecoverableTask | null): RecoveryPlan {
  if (!task) return { kind: "flush_queue" };

  /*
   * `result_pending` and `sent_to_gpt` both mean a persisted answer is waiting
   * for ChatGPT. The RESULT is in the durable queue, so all the recovery has
   * to do is hand it to the extension again.
   */
  if (task.status === "result_pending" || task.status === "sent_to_gpt") {
    return { kind: "redeliver_result" };
  }

  const outboundId = task.workbuddyOutboundMessageId;

  if (outboundId && RUNNING_STATUSES.has(task.status)) {
    return {
      kind: "resume_wait",
      taskId: task.taskId,
      outboundId,
      ...(task.modelId ? { modelId: task.modelId } : {}),
    };
  }

  /*
   * A record with no outbound id and no queued answer explains nothing, and the
   * only thing that can still be true is that no send happened: leave it to
   * the queue rather than inventing a message.
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
