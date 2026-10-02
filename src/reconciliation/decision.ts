import { dispatchIdFor } from "./fingerprint.js";
import type { ReconciliationEvent } from "./types.js";

/**
 * Whether a task may be sent to WorkBuddy again.
 *
 * This is the whole of the "blind resend" question, and it is answered from
 * evidence only. Nothing here guesses: when the ledger cannot prove that the
 * previous dispatch never reached WorkBuddy, the answer is to block, because
 * the alternative - a second dispatch of a task that may already be running -
 * loses work that cannot be recovered.
 */

export type DispatchBlockedReason =
  | "identity_conflict"
  | "already_completed"
  | "already_running"
  | "send_confirmed"
  | "duplicate_dispatch"
  | "attempts_exhausted"
  | "gpt_not_found"
  | "no_evidence_of_failure";

export type DispatchDecision =
  | { kind: "dispatched"; dispatchId: string; attempt: number; reason: string }
  | { kind: "resend_allowed"; dispatchId: string; attempt: number; reason: string }
  | { kind: "blocked"; reason: DispatchBlockedReason; detail: string };

export type DispatchRequest = {
  taskId: string;
  taskFingerprint: string;
  /**
   * The task as it was last seen on the GPT page. A resend is only ever
   * allowed when the page still carries the very same envelope; if it does
   * not, the relay has no way to know what was actually published.
   */
  gptEvidence: { taskId: string; taskFingerprint: string } | null;
  maxAttempts: number;
  now?: Date;
};

function has(history: readonly ReconciliationEvent[], event: ReconciliationEvent["event"]): boolean {
  return history.some((item) => item.event === event);
}

function latestAttempt(history: readonly ReconciliationEvent[]): number {
  return history.reduce((max, item) => (typeof item.attempt === "number" ? Math.max(max, item.attempt) : max), -1);
}

function distinctFingerprints(history: readonly ReconciliationEvent[]): string[] {
  const seen = new Set<string>();
  for (const item of history) seen.add(item.taskFingerprint);
  return [...seen];
}

export function decideDispatch(
  history: readonly ReconciliationEvent[],
  request: DispatchRequest,
): DispatchDecision {
  const taskId = request.taskId;

  /*
   * First question, always: is this even the same task as the one on record?
   * A second envelope with the same name is a contradiction, and no amount of
   * helpfulness makes a contradiction schedulable.
   */
  const fingerprints = distinctFingerprints(history);
  if (fingerprints.length > 1 && fingerprints.includes(request.taskFingerprint)) {
    return {
      kind: "blocked",
      reason: "identity_conflict",
      detail: `task ${taskId} was published twice with different envelopes`,
    };
  }

  /*
   * A task with a result in the ledger is finished, and a finished task is
   * never sent again - not even to "re-check" it.
   */
  if (has(history, "RESULT_RECEIVED") || has(history, "RESULT_DELIVERED") || has(history, "TASK_COMPLETED")) {
    return {
      kind: "blocked",
      reason: "already_completed",
      detail: `task ${taskId} already produced a result; resending would duplicate it`,
    };
  }

  /*
   * Anything that proves WorkBuddy actually ran the task freezes scheduling.
   * "It was cancelled" is not evidence that nothing happened: the turn may
   * have written files before it was stopped.
   */
  if (has(history, "RUNNING_CONFIRMED")) {
    return {
      kind: "blocked",
      reason: "already_running",
      detail: `task ${taskId} was seen running; a second dispatch would run it twice`,
    };
  }

  if (has(history, "SEND_CONFIRMED")) {
    return {
      kind: "blocked",
      reason: "send_confirmed",
      detail: `task ${taskId} was confirmed sent; without proof that it never ran, the next send is a duplicate`,
    };
  }

  /*
   * A dispatch that exists but was never confirmed either way is the only
   * case where a retry can be justified - and only with the GPT page still
   * carrying the identical envelope.
   */
  const dispatched = has(history, "DISPATCH_STARTED") || has(history, "INPUT_CONFIRMED");

  if (dispatched) {
    const attempt = latestAttempt(history) + 1;

    if (attempt >= request.maxAttempts) {
      return {
        kind: "blocked",
        reason: "attempts_exhausted",
        detail: `task ${taskId} already attempted ${attempt} time(s) (max ${request.maxAttempts})`,
      };
    }

    const matches =
      request.gptEvidence !== null &&
      request.gptEvidence.taskId === taskId &&
      request.gptEvidence.taskFingerprint === request.taskFingerprint;

    if (!matches) {
      return {
        kind: "blocked",
        reason: "gpt_not_found",
        detail:
          `task ${taskId} is not on the GPT page with the same envelope, so there is no ` +
          `proof of what was published`,
      };
    }

    return {
      kind: "resend_allowed",
      dispatchId: dispatchIdFor(taskId, attempt),
      attempt,
      reason: "no execution evidence and the same envelope is still published",
    };
  }

  return {
    kind: "dispatched",
    dispatchId: dispatchIdFor(taskId, 0),
    attempt: 0,
    reason: "first dispatch of a published task",
  };
}
