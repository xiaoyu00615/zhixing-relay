/**
 * The three terminal states, and the one policy that decides them.
 *
 * A task ends in exactly one of three ways, and they are three different human
 * decisions that must never be substituted for one another:
 *
 *   COMPLETED             the task really ran and its result finished the
 *                          lifecycle the system defines. Never written for a
 *                          task that never executed.
 *   CLOSED_WITHOUT_RESEND  the task may have run, or the send cannot be proven
 *                          either way; the operator decided that whatever the
 *                          truth is, it is never sent again.
 *   CANCELLED             the task provably did NOT run, and is now terminated:
 *                          it will never be executed.
 *
 * The difference between the last two is the whole point. "Never send it again"
 * and "it never ran" are different claims about the world, and a relay that
 * collapses them either re-runs work an operator abandoned, or refuses to let
 * anyone close a task that genuinely might be running.
 *
 * Everything here is pure: it reads events and answers a question. It never
 * touches the ledger, the clock, or the relay's state, which is what lets the
 * dangerous cases (a cancellation racing a redelivery, a completion whose owner
 * release never landed) be tested exhaustively without a relay in the room.
 */

import { identityFingerprints, isConcreteTaskFingerprint } from "./fingerprint.js";
import type { ReconciliationEvent, ReconciliationEventName } from "./types.js";

/** How a task ended. The three are ordered by how much they assert. */
export type TerminalKind = "COMPLETED" | "CLOSED_WITHOUT_RESEND" | "CANCELLED";

export const TERMINAL_KINDS: readonly TerminalKind[] = [
  "COMPLETED",
  "CLOSED_WITHOUT_RESEND",
  "CANCELLED",
];

/**
 * The dispositions an operator may write to close a task for good.
 *
 * A closure is the only way a task the relay has forgotten stops being a
 * blocker, and it has to name the kind of closure it is: "the work is done,
 * never send it again" is a different human decision from "it provably never
 * ran, stop it now", and the ledger keeps them apart on purpose.
 */
export type HistoricalDisposition = "close_without_resend" | "cancel_unsent";

export const HISTORICAL_DISPOSITIONS: readonly HistoricalDisposition[] = [
  "close_without_resend",
  "cancel_unsent",
];

/**
 * Whether a ledger row is an operator closure.
 *
 * Read from the row's own detail rather than from the event name, because
 * `RECONCILIATION_RESOLVED` already means something else - lifting the hold
 * on a frozen live task - and the two decisions must not be interchangeable.
 */
export function isClosingDisposition(detail: unknown): boolean {
  if (!detail || typeof detail !== "object") return false;
  const value = (detail as { disposition?: unknown }).disposition;
  return typeof value === "string" && (HISTORICAL_DISPOSITIONS as readonly string[]).includes(value);
}

/**
 * The evidence that WorkBuddy already has the task.
 *
 * Anything in this list turns a retry into a duplicate: the relay cannot prove
 * the first send never ran, and a send that runs twice cannot be undone. A
 * requeue row from an older release says only that somebody requeued - it is
 * an error record, not proof either way - so it can never outweigh a row that
 * proves the send happened.
 *
 * This is the single answer to "did this task reach WorkBuddy?", and every
 * layer asks here rather than re-listing the stages: a second list is a second
 * policy, and two policies drift into disagreeing about the same task.
 */
const PROVEN_SEND_EVIDENCE: readonly ReconciliationEventName[] = [
  "SEND_CONFIRMED",
  "RUNNING_CONFIRMED",
  "RESULT_RECEIVED",
  "RESULT_PERSISTED",
  "RESULT_DELIVERED",
  "RESULT_ACKED",
  "TASK_COMPLETED",
];

/**
 * The events that say the task started or answered again.
 *
 * A closure settles the *history* it was written about. It cannot settle a
 * send that happens after it, so anything in this list that follows a closure
 * is judged on its own terms.
 */
const EXECUTION_EVIDENCE: readonly ReconciliationEventName[] = [
  "DISPATCH_STARTED",
  "INPUT_CONFIRMED",
  "SEND_ATTEMPTED",
  "SEND_CONFIRMED",
  "RUNNING_CONFIRMED",
  "RESULT_RECEIVED",
  "RESULT_PERSISTED",
  "RESULT_DELIVERED",
  "RESULT_ACKED",
  "TASK_COMPLETED",
];

/** Whether these events prove the task reached WorkBuddy at least once. */
export function hasProvenSend(evidence: readonly ReconciliationEventName[]): boolean {
  return PROVEN_SEND_EVIDENCE.some((event) => evidence.includes(event));
}

/**
 * Whether a send was attempted and never confirmed.
 *
 * The dangerous middle, and the reason it gets its own answer: the fence says a
 * click was about to happen, nothing says whether it landed, so the task may be
 * running right now. This is neither proof of arrival nor proof of absence, and
 * it has to veto a retry on its own - a requeue row is an error record, not a
 * licence to try again.
 *
 * It is deliberately *not* time-based: a fence stays uncertain however long ago
 * it was written, because nothing about waiting makes an unconfirmed click
 * safer.
 */
export function hasUncertainSend(evidence: readonly ReconciliationEventName[]): boolean {
  return (
    evidence.includes("SEND_ATTEMPTED") && !evidence.includes("SEND_CONFIRMED")
  );
}

/**
 * Whether any of these events says the task may have executed.
 *
 * Wider than {@link hasProvenSend} on purpose: `DISPATCH_STARTED` and
 * `INPUT_CONFIRMED` prove nothing about whether WorkBuddy ran the task, but
 * they do prove the relay got as far as putting it in front of the page. A
 * cancellation may not be written on that evidence, because "probably never
 * ran" is not "never ran".
 */
export function hasExecutionAttempt(evidence: readonly ReconciliationEventName[]): boolean {
  return EXECUTION_EVIDENCE.some((event) => evidence.includes(event));
}

/** One terminal decision, read out of the ledger. */
export type TerminalState = {
  kind: TerminalKind;
  /** Where the decision sits in the ledger; the newest one wins. */
  seq: number;
  /** The fingerprint the decision names, or the placeholder for a legacy row. */
  taskFingerprint: string;
  /**
   * Whether this decision still stands. A closure covers the history it was
   * written about and nothing after it, so a task that was closed and then
   * somehow sent again is NOT closed any more - it is a contradiction, and it
   * is reported as one.
   */
  stands: boolean;
  /** The operator's reason, when the row carried one. */
  reason: string | null;
};

function dispositionDetail(event: ReconciliationEvent): Record<string, unknown> | null {
  const detail = event.detail;
  return detail && typeof detail === "object" ? (detail as Record<string, unknown>) : null;
}

/**
 * The terminal state of one task, or null when it has not ended.
 *
 * Only the newest decision counts, because a task that was cancelled and later
 * closed is a task somebody changed their mind about, and the newest decision
 * is the one that was made last.
 */
export function terminalStateFor(
  events: readonly ReconciliationEvent[],
): TerminalState | null {
  let latest: TerminalState | null = null;

  for (const event of events) {
    let kind: TerminalKind | null = null;

    if (event.event === "TASK_COMPLETED") {
      kind = "COMPLETED";
    } else if (event.event === "TASK_CANCELLED") {
      kind = "CANCELLED";
    } else if (event.event === "RECONCILIATION_RESOLVED" && isClosingDisposition(event.detail)) {
      const disposition = dispositionDetail(event)?.disposition;
      kind = disposition === "cancel_unsent" ? "CANCELLED" : "CLOSED_WITHOUT_RESEND";
    }

    if (kind === null) continue;

    if (latest !== null && event.seq <= latest.seq) continue;
    latest = { kind, seq: event.seq, taskFingerprint: event.taskFingerprint, stands: true, reason: null };
  }

  if (latest === null) return null;

  const reason = dispositionDetail(
    events.find((event) => event.seq === latest?.seq) ?? ({} as ReconciliationEvent),
  )?.reason;

  /*
   * A decision stands only while nothing executed after it. This is what stops
   * a closure from becoming a permanent gag over a task that really did run:
   * the closure said "never send it again" about the history it could see, and
   * a send recorded after it is a fact the closure never spoke to.
   */
  const ranAfter = events.some(
    (event) => event.seq > latest!.seq && EXECUTION_EVIDENCE.includes(event.event),
  );

  return { ...latest, stands: !ranAfter, reason: typeof reason === "string" ? reason : null };
}

/**
 * Whether a task is finished, and may never be dispatched again.
 *
 * A decision that no longer stands is deliberately NOT terminal here: the
 * contradiction it describes is a question for a human, and answering it by
 * dispatching would be answering it wrongly in the dangerous direction.
 */
export function isTerminal(events: readonly ReconciliationEvent[]): boolean {
  return terminalStateFor(events)?.stands === true;
}

/** The concrete identities a chain has been recorded under. */
export function chainIdentities(events: readonly ReconciliationEvent[]): string[] {
  return identityFingerprints(events.map((event) => event.taskFingerprint));
}

/**
 * Whether a cancellation may be written for this task at all.
 *
 * Cancellation asserts the strongest thing a disposition can: that the task
 * never ran, so terminating it loses nothing. That assertion is only honest on
 * evidence that the task never got near WorkBuddy, which is why this refuses
 * the moment there is any execution evidence, and refuses a chain that already
 * has a terminal decision of its own.
 *
 * Returns the refusal reason rather than a boolean so the control surface can
 * tell an operator *why* a cancel was refused instead of only that it was.
 */
export type CancelRefusal =
  | "already_terminal"
  | "may_have_executed"
  | "identity_conflict"
  | "no_identity";

export type CancelEligibility =
  | { ok: true }
  | { ok: false; reason: CancelRefusal; detail: string };

export function cancelEligibility(
  events: readonly ReconciliationEvent[],
  taskFingerprint?: string | null,
): CancelEligibility {
  const terminal = terminalStateFor(events);

  if (terminal !== null && terminal.stands) {
    return {
      ok: false,
      reason: "already_terminal",
      detail:
        `this task already ended as ${terminal.kind} at seq ${terminal.seq}; ` +
        `a second terminal decision would be a second invented fact`,
    };
  }

  const evidence = [...new Set(events.map((event) => event.event))];

  if (hasExecutionAttempt(evidence)) {
    return {
      ok: false,
      reason: "may_have_executed",
      detail:
        `the ledger holds execution evidence (${EXECUTION_EVIDENCE.filter((event) =>
          evidence.includes(event),
        ).join(", ")}), so this task may have run; ` +
        `close it without a resend instead of cancelling it`,
    };
  }

  const identities = chainIdentities(events);

  /*
   * A cancellation names an exact envelope, so it can only be written when
   * there is exactly one envelope to name. Two identities are a contradiction
   * that predates this decision, and a chain with no identity at all has
   * nothing for the cancellation to be about.
   */
  if (identities.length > 1) {
    return {
      ok: false,
      reason: "identity_conflict",
      detail:
        `this task was published under ${identities.length} different envelopes; ` +
        `a contradiction has to be settled before anything is decided about it`,
    };
  }

  if (identities.length === 0) {
    return {
      ok: false,
      reason: "no_identity",
      detail: "this task has no recorded envelope, so there is no identity to cancel",
    };
  }

  if (taskFingerprint !== undefined && taskFingerprint !== null) {
    if (!isConcreteTaskFingerprint(taskFingerprint)) {
      return {
        ok: false,
        reason: "no_identity",
        detail: `the fingerprint offered for the cancellation (${taskFingerprint}) names no envelope`,
      };
    }

    if (identities[0] !== taskFingerprint) {
      return {
        ok: false,
        reason: "identity_conflict",
        detail:
          `the cancellation names a different envelope than the one on record ` +
          `(${identities[0]?.slice(0, 12)}); refusing to decide about the wrong task`,
      };
    }
  }

  return { ok: true };
}
