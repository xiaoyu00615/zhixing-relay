import { isConcreteTaskFingerprint } from "./fingerprint.js";
import type { ReconciliationEvent } from "./types.js";

/**
 * Whether the relay already proved where a task came from.
 *
 * The live rule - "the GPT page is showing this envelope right now" - is the
 * right rule for a task the relay has just seen, and the wrong rule for a task
 * that has been waiting: ChatGPT virtualises and unmounts older messages, so a
 * task that was accepted minutes ago can be perfectly real and no longer
 * readable. Requiring the page to still show it means a durable queue entry
 * becomes unretryable the moment the page scrolls, which is how a task that
 * was never sent ends up being refused for ever for lack of proof rather than
 * for a reason.
 *
 * So the proof is split by when it is needed:
 *
 *   first acceptance   the live page has to prove it - assistant source,
 *                      envelope, taskId, message fingerprint, task
 *                      fingerprint - and accepting it writes TASK_ACCEPTED;
 *   every later retry  the TASK_ACCEPTED chain proves it. The page no longer
 *                      has to be carrying the bubble.
 *
 * This module is the second half: it reads the chain the first half wrote, and
 * it is deliberately strict. An accepted row only proves THIS task when the
 * taskId, the task fingerprint and the source message fingerprint all match
 * what is being asked about now; anything less is not attestation, it is a
 * coincidence between two envelopes.
 *
 * TASK_PUBLISHED is never enough on its own. Publishing is written before the
 * relay decides whether the task may run, so a refused attempt leaves a
 * published row behind: reading those as proof would let a retry manufacture
 * the very evidence that lets the next retry through.
 */

/** What a durable attestation says, and where it came from. */
export type SourceAttestation = {
  taskId: string;
  taskFingerprint: string;
  /** Fingerprint of the GPT message that carried the envelope. */
  sourceFingerprint: string;
  /** Ledger sequence of the accepted row that proves it. Never reassigned. */
  seq: number | null;
};

/** Why the chain does not prove this task. */
export type SourceProofReason =
  /** Nothing was ever accepted for this task. */
  | "no_accepted_chain"
  /** Accepted rows exist, but for another taskId. */
  | "task_id_mismatch"
  /** Accepted for this taskId, but under a different envelope. */
  | "task_fingerprint_mismatch"
  /** The same envelope, but a different GPT message behind it. */
  | "source_fingerprint_mismatch";

export type SourceProofVerdict =
  | { kind: "attested"; attestation: SourceAttestation }
  | { kind: "unproven"; reason: SourceProofReason };

export type SourceProofRequest = {
  taskId: string;
  taskFingerprint: string;
  /** Fingerprint of the GPT message the task is being attributed to now. */
  sourceFingerprint: string;
};

/**
 * The durable answer to "has this task already been proven to come from GPT?".
 *
 * Pure, and total: it never throws and never guesses. Every way of saying no
 * names itself, so a refusal can be read instead of inferred.
 */
export function durableSourceProof(
  history: readonly ReconciliationEvent[],
  request: SourceProofRequest,
): SourceProofVerdict {
  const accepted = history.filter((event) => event.event === "TASK_ACCEPTED");

  if (accepted.length === 0) {
    return { kind: "unproven", reason: "no_accepted_chain" };
  }

  const named = accepted.filter((event) => event.taskId === request.taskId);

  if (named.length === 0) {
    return { kind: "unproven", reason: "task_id_mismatch" };
  }

  /*
   * A task is only itself under one envelope. An accepted row carrying the
   * placeholder - written when the relay had no envelope to point at - proves
   * nothing about content, so it cannot be the row this is matched against.
   */
  const sameEnvelope = named.filter((event) =>
    isConcreteTaskFingerprint(event.taskFingerprint)
      ? event.taskFingerprint === request.taskFingerprint
      : false,
  );

  if (sameEnvelope.length === 0) {
    return { kind: "unproven", reason: "task_fingerprint_mismatch" };
  }

  const row = sameEnvelope.find(
    (event) =>
      event.messageFingerprint !== null &&
      event.messageFingerprint === request.sourceFingerprint,
  );

  if (!row) {
    return { kind: "unproven", reason: "source_fingerprint_mismatch" };
  }

  return {
    kind: "attested",
    attestation: {
      taskId: row.taskId,
      taskFingerprint: row.taskFingerprint,
      sourceFingerprint: row.messageFingerprint as string,
      seq: row.seq,
    },
  };
}

/** The boolean the dispatch decision needs, and the reason when it is false. */
export function sourceIsAttested(
  history: readonly ReconciliationEvent[],
  request: SourceProofRequest,
): boolean {
  return durableSourceProof(history, request).kind === "attested";
}
