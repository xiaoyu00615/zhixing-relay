import { dispatchIdFor, identityFingerprints } from "./fingerprint.js";
import { durableSourceProof } from "./source-proof.js";
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
   * Fingerprint of the GPT message this task is being attributed to. Required:
   * it is half of the durable source attestation, and a request that left it
   * out would silently read as "unproven" - a refusal nobody asked for.
   */
  sourceFingerprint: string;
  /**
   * The task as it was last seen on the GPT page, re-read just now. Null when
   * the page is not carrying the envelope any more - which is what happens as
   * soon as ChatGPT unmounts an older message, so on its own it is not
   * evidence of anything.
   */
  gptEvidence: { taskId: string; taskFingerprint: string } | null;
  /**
   * The task is being handed over straight from a message the GPT page just
   * produced, so the page does not have to be asked to repeat itself. Only the
   * live intake path carries this; a queue flush never does.
   */
  observedOnGptPage?: boolean;
  maxAttempts: number;
  now?: Date;
};

function has(history: readonly ReconciliationEvent[], event: ReconciliationEvent["event"]): boolean {
  return history.some((item) => item.event === event);
}

function latestAttempt(history: readonly ReconciliationEvent[]): number {
  return history.reduce((max, item) => (typeof item.attempt === "number" ? Math.max(max, item.attempt) : max), -1);
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
  /*
   * Only fingerprints that name the task can contradict each other. A requeue
   * or a resolution written without an envelope to point at carries the
   * placeholder, and counting that placeholder as a second envelope is how a
   * healthy chain reads as "published twice with different content".
   */
  const fingerprints = identityFingerprints(history.map((item) => item.taskFingerprint));
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
   * Every dispatch from here on needs the task's provenance to be proven
   * somehow - by the page, right now, or by the chain the relay wrote when it
   * first accepted it. The two are the same claim from different moments, and
   * both are read before anything is sent.
   */
  const observed =
    request.observedOnGptPage === true ||
    (request.gptEvidence !== null &&
      request.gptEvidence.taskId === taskId &&
      request.gptEvidence.taskFingerprint === request.taskFingerprint);

  const proof = durableSourceProof(history, {
    taskId,
    taskFingerprint: request.taskFingerprint,
    sourceFingerprint: request.sourceFingerprint,
  });

  if (!observed && proof.kind !== "attested") {
    return {
      kind: "blocked",
      reason: "gpt_not_found",
      detail:
        `task ${taskId} is not on the GPT page with the same envelope and no accepted ` +
        `chain attests to it (${proof.reason}), so there is no proof of what was published`,
    };
  }

  /*
   * A dispatch that exists but was never confirmed either way is the only
   * case where a retry can be justified.
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

    return {
      kind: "resend_allowed",
      dispatchId: dispatchIdFor(taskId, attempt),
      attempt,
      reason: observed
        ? "no execution evidence and the same envelope is still published"
        : `no execution evidence and the accepted chain still attests to this envelope ` +
          `(seq ${proof.kind === "attested" ? proof.attestation.seq : "unknown"})`,
    };
  }

  return {
    kind: "dispatched",
    dispatchId: dispatchIdFor(taskId, 0),
    attempt: 0,
    reason: observed
      ? "first dispatch of a published task"
      : `first dispatch of a task the accepted chain attests to ` +
        `(seq ${proof.kind === "attested" ? proof.attestation.seq : "unknown"})`,
  };
}
