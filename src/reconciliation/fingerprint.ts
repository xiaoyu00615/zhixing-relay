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
 * The placeholder a writer uses when it has no task to name.
 *
 * It is bookkeeping, not identity: it says "the row exists, but nobody knew
 * which task it belongs to". Treating it as a fingerprint of a task is what
 * makes a healthy chain look like a contradiction - one real envelope and one
 * placeholder are not two versions of the same work, they are one version and
 * one footnote about it.
 */
export const UNKNOWN_FINGERPRINT = "*";

/**
 * True for a fingerprint that actually names a task.
 *
 * A real fingerprint is any value a writer could have hashed an envelope
 * into. The placeholder, an empty string and a missing value name nothing, so
 * they are not identity and can never be one half of a contradiction.
 */
export function isConcreteTaskFingerprint(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value !== UNKNOWN_FINGERPRINT;
}

/**
 * The fingerprints of a chain that name the task, distinct, in order of first
 * appearance.
 *
 * This - and only this - is what identity conflicts are counted from: more
 * than one entry here means the same taskId was published under two different
 * envelopes, which is a contradiction a human has to settle. One entry, no
 * matter how many placeholder rows surround it, is one identity.
 */
export function identityFingerprints(fingerprints: readonly (string | null | undefined)[]): string[] {
  const seen: string[] = [];
  const known = new Set<string>();

  for (const value of fingerprints) {
    if (!isConcreteTaskFingerprint(value)) continue;
    if (known.has(value)) continue;
    known.add(value);
    seen.push(value);
  }

  return seen;
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
