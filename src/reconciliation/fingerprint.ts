import { createHash } from "node:crypto";

/**
 * Fingerprints for reconciliation.
 *
 * A fingerprint answers exactly one question: "is this the same work I have
 * already seen?". It must therefore ignore everything that changes between two
 * deliveries of the same task - the timestamp, the route, the attempt - and
 * depend only on the envelope's meaning.
 */

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Stable fingerprint of a TASK block.
 *
 * The whole envelope, markers included, is hashed. Markers make no difference
 * to the hash itself, but hashing them keeps the fingerprint computed over the
 * exact bytes Relay forwards, so "fingerprint" and "what WorkBuddy received"
 * cannot drift apart.
 */
export function taskFingerprint(block: string): string {
  return sha256(block.trim());
}

/** Fingerprint of a GPT message, used to tell two deliveries apart. */
export function messageFingerprint(text: string): string {
  return sha256(text);
}

/** The head of a fingerprint, for the human-readable details in a finding. */
export function fingerprintShort(fingerprint: string): string {
  return fingerprint.slice(0, 12);
}

/**
 * The dispatch id for one attempt at one task.
 *
 * `${taskId}#${attempt}` is the whole identity of a send: the same attempt
 * number is the same send, and a new attempt number is a new send that has to
 * be reconciled against the old one rather than silently replacing it.
 */
export function dispatchIdFor(taskId: string, attempt: number): string {
  return `${taskId}#${attempt}`;
}
