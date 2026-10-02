import { fingerprintShort, identityFingerprints, UNKNOWN_FINGERPRINT } from "./fingerprint.js";
import type { ReconciliationEvent, ReconciliationEventName } from "./types.js";

/**
 * Reconciliation, as a pure function.
 *
 * Nothing here touches the disk or the clock: it takes the events and reads
 * them. That is what makes the interesting cases - a task dispatched twice,
 * a task that never reached WorkBuddy, a contradiction between two envelopes
 * with the same taskId - testable without a relay in the room.
 *
 * The rule the whole module serves: when the chain is unsure, stop and
 * reconcile. Never answer uncertainty by sending again.
 */

export type ReconciliationFindingKind =
  | "identity_conflict"
  | "duplicate_dispatch"
  | "out_of_order"
  | "missing_execution_evidence"
  | "missing_result_receipt"
  | "result_not_delivered"
  | "never_dispatched"
  | "orphaned_task"
  // An operator closed this forgotten task instead of leaving it frozen.
  | "historical_task_closed"
  | "result_task_id_mismatch"
  | "resend_allowed"
  | "matched";

export type ReconciliationSeverity = "info" | "warning" | "blocking";

export type ReconciliationFinding = {
  kind: ReconciliationFindingKind;
  severity: ReconciliationSeverity;
  taskId: string;
  dispatchId: string | null;
  detail: string;
  events: ReconciliationEventName[];
};

export type TaskState =
  | "published"
  | "queued"
  | "dispatched"
  | "running"
  | "completed"
  | "blocked";

export type TaskReconciliation = {
  taskId: string;
  /** The fingerprint the task was first recorded under. */
  fingerprint: string;
  /**
   * Every fingerprint the task was ever recorded under, placeholders
   * included: a human reading a contradiction wants the whole chain, footnote
   * rows as well as identity rows.
   */
  fingerprints: string[];
  /**
   * The fingerprints that actually name the task. Two or more of these is a
   * contradiction; a placeholder never is, because it names nothing.
   */
  identities: string[];
  dispatchIds: string[];
  attempts: number[];
  evidence: ReconciliationEventName[];
  state: TaskState;
  findings: ReconciliationFinding[];
  /** The ledger sequence of the operator closure, when one closes this task. */
  closedAtSeq: number | null;
  /** Safe to send again only after a human has been told what the state is. */
  mayResend: boolean;
};

export type ReconciliationReport = {
  generatedAt: string;
  reason: string;
  tasks: TaskReconciliation[];
  findings: ReconciliationFinding[];
  /** At least one contradiction: stop scheduling until it is explained. */
  blocked: boolean;
  resendAllowed: boolean;
  tasksSeen: number;
  corruptLines: number;
};

/** The order the ledger is expected to produce. Later before earlier is out of order. */
const PIPELINE: readonly ReconciliationEventName[] = [
  "TASK_PUBLISHED",
  "TASK_ACCEPTED",
  "TASK_ENQUEUED",
  "DISPATCH_STARTED",
  "INPUT_CONFIRMED",
  "SEND_CONFIRMED",
  "RUNNING_CONFIRMED",
  "RESULT_RECEIVED",
  "RESULT_PERSISTED",
  "RESULT_DELIVERED",
  "RESULT_ACKED",
  "TASK_COMPLETED",
];

function distinct<T>(values: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const value of values) {
    const key = typeof value === "string" ? value : String(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function emptyReport(reason: string, corruptLines: number): ReconciliationReport {
  return {
    generatedAt: "",
    reason,
    tasks: [],
    findings: [],
    blocked: false,
    resendAllowed: false,
    tasksSeen: 0,
    corruptLines,
  };
}

/**
 * The evidence that WorkBuddy already has the task.
 *
 * Anything in this list turns a retry into a duplicate: the relay cannot
 * prove the first send never ran, and a send that runs twice cannot be
 * undone. A requeue row from an older release says only that somebody
 * requeued - it is an error record, not proof either way - so it can never
 * outweigh a row that proves the send happened.
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

export function hasProvenSend(evidence: readonly ReconciliationEventName[]): boolean {
  return PROVEN_SEND_EVIDENCE.some((event) => evidence.includes(event));
}

/**
 * The events that say the task started or answered again.
 *
 * A closure settles the *history* it was written about. It cannot settle a
 * send that happens after it, so anything in this list that follows a
 * closure is judged on its own terms.
 */
const EXECUTION_EVIDENCE: readonly ReconciliationEventName[] = [
  "DISPATCH_STARTED",
  "INPUT_CONFIRMED",
  "SEND_CONFIRMED",
  "RUNNING_CONFIRMED",
  "RESULT_RECEIVED",
  "RESULT_PERSISTED",
  "RESULT_DELIVERED",
  "RESULT_ACKED",
  "TASK_COMPLETED",
];

/**
 * The dispositions an operator may write to close a task for good.
 *
 * A closure is the only way a task the relay has forgotten stops being a
 * blocker, and it has to name the kind of closure it is: "the work is done,
 * never send it again" is a different human decision from "drop it", and the
 * ledger keeps them apart on purpose.
 */
export type HistoricalDisposition = "close_without_resend";

export const HISTORICAL_DISPOSITIONS: readonly HistoricalDisposition[] = ["close_without_resend"];

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

/** The closure that closes this chain, or null when there is none. */
function lastClosure(events: readonly ReconciliationEvent[]): ReconciliationEvent | null {
  let latest: ReconciliationEvent | null = null;

  for (const event of events) {
    if (event.event !== "RECONCILIATION_RESOLVED") continue;
    if (!isClosingDisposition(event.detail)) continue;
    if (latest === null || event.seq > latest.seq) latest = event;
  }

  return latest;
}

/**
 * What the live relay knows, so the ledger can tell a task it is still
 * running from one it has lost.
 */
export type ReconciliationLiveContext = {
  pending?: readonly string[];
  current?: string | null;
};

/**
 * Reads one task's events.
 *
 * `context` carries what the live relay knows - the ids that are queued and
 * the one in flight - because the ledger can also hold tasks that the state
 * file has already forgotten, and a forgotten published task is precisely the
 * "漏发" case a human has to see. Without the live context every unfinished
 * task in the ledger reads as orphaned, which is why the caller has to pass
 * it: the ledger records what happened, the live state says what is true now,
 * and only both together can answer the orphan question honestly.
 */
export function reconcileTask(
  events: readonly ReconciliationEvent[],
  context?: ReconciliationLiveContext,
): TaskReconciliation {
  const taskId = events[0]?.taskId ?? "";
  const fingerprints = distinct(events.map((event) => event.taskFingerprint));
  /*
   * Identity is asked from the fingerprints that name the task and nothing
   * else. A ledger row written by bookkeeping - a requeue or a resolution
   * that the writer could not attach to an envelope - carries a placeholder
   * for exactly that reason, and counting it as a second identity is what
   * turned a working chain into a contradiction.
   */
  const identities = identityFingerprints(events.map((event) => event.taskFingerprint));
  const dispatchIds = distinct(
    events
      .map((event) => event.dispatchId)
      .filter((id): id is string => typeof id === "string"),
  );
  const attempts = distinct(
    events
      .map((event) => event.attempt)
      .filter((value): value is number => typeof value === "number"),
  ).sort((a, b) => a - b);

  const evidence = distinct(events.map((event) => event.event));
  const has = (name: ReconciliationEventName) => evidence.includes(name);

  /*
   * A closure is the only honest way out of "the ledger knows a task the
   * relay does not": the human says what happened outside the relay, and the
   * ledger records it. It is read here so the orphan question below can tell
   * a forgotten task that was closed from one that was simply lost.
   */
  const closure = lastClosure(events);
  const closedAtSeq = closure?.seq ?? null;
  const afterClosure = closure === null ? [] : events.filter((event) => event.seq > closure.seq);
  const ranAgainAfterClosure = afterClosure.some((event) => EXECUTION_EVIDENCE.includes(event.event));
  const closedByOperator = closure !== null && !ranAgainAfterClosure;

  const findings: ReconciliationFinding[] = [];

  /*
   * Identity is the first question: if the same taskId arrived twice with two
   * different envelopes, nothing else about the task is trustworthy enough to
   * resend anything, so this one blocks on its own.
   */
  if (identities.length > 1) {
    findings.push({
      kind: "identity_conflict",
      severity: "blocking",
      taskId,
      dispatchId: dispatchIds[0] ?? null,
      events: evidence,
      detail:
        `task ${taskId} was published under ${identities.length} different fingerprints ` +
        `(${identities.map(fingerprintShort).join(", ")}); refusing to overwrite the old task and ` +
        `refusing to send either`,
    });
  }

  const duplicateDispatches = dispatchIds.filter(
    (id) => events.filter((event) => event.dispatchId === id && event.event === "DISPATCH_STARTED").length > 1,
  );
  if (duplicateDispatches.length > 0) {
    findings.push({
      kind: "duplicate_dispatch",
      severity: "blocking",
      taskId,
      dispatchId: duplicateDispatches.join(",") || null,
      detail:
        `the same send (${duplicateDispatches.join(", ")}) was started more than once; ` +
        `the second send is not a retry and must be reconciled before anything is resent`,
      events: ["DISPATCH_STARTED"],
    });
  }

  /*
   * Two present events are out of order when the ledger shows them the other
   * way round from the pipeline, e.g. a result recorded before the send that
   * produced it.
   */
  const actualAt = new Map(evidence.map((name, index) => [name, index]));
  const inversions: ReconciliationEventName[] = [];

  for (let i = 0; i < PIPELINE.length; i += 1) {
    const earlier = PIPELINE[i];
    if (earlier === undefined || !has(earlier)) continue;

    for (let j = i + 1; j < PIPELINE.length; j += 1) {
      const later = PIPELINE[j];
      if (later === undefined || !has(later)) continue;
      if ((actualAt.get(earlier) ?? 0) > (actualAt.get(later) ?? 0)) {
        inversions.push(later);
        break;
      }
    }
  }
  if (inversions.length > 0) {
    findings.push({
      kind: "out_of_order",
      severity: "warning",
      taskId,
      dispatchId: null,
      detail: `events arrived against the expected pipeline (${inversions.join(", ")})`,
      events: inversions,
    });
  }

  const started = has("DISPATCH_STARTED") || has("SEND_CONFIRMED");
  if (started && !has("RUNNING_CONFIRMED")) {
    findings.push({
      kind: "missing_execution_evidence",
      severity: "warning",
      taskId,
      dispatchId: dispatchIds[0] ?? null,
      detail:
        `the task reached the send but WorkBuddy never confirmed that it started running; ` +
        `reconcile against WorkBuddy before sending again`,
      events: ["DISPATCH_STARTED", "SEND_CONFIRMED"],
    });
  }

  if (has("RESULT_RECEIVED") && !has("RESULT_DELIVERED")) {
    findings.push({
      kind: "result_not_delivered",
      severity: "warning",
      taskId,
      dispatchId: dispatchIds[0] ?? null,
      detail: "WorkBuddy answered but the result was not handed to ChatGPT yet",
      events: ["RESULT_RECEIVED"],
    });
  }

  const missingResultReceipt = has("DISPATCH_STARTED") || has("SEND_CONFIRMED");
  if (missingResultReceipt && !has("RESULT_RECEIVED") && !has("RESULT_DELIVERED")) {
    findings.push({
      kind: "missing_result_receipt",
      severity: "warning",
      taskId,
      dispatchId: dispatchIds[0] ?? null,
      detail: "the task was sent but no result ever came back from WorkBuddy",
      events: ["DISPATCH_STARTED", "SEND_CONFIRMED"],
    });
  }

  let state: TaskState;

  if (findings.some((finding) => finding.kind === "identity_conflict") || has("TASK_BLOCKED")) {
    state = "blocked";
  } else if (has("TASK_COMPLETED")) {
    state = "completed";
  } else if (has("RESULT_RECEIVED") || has("RESULT_DELIVERED") || has("RUNNING_CONFIRMED")) {
    state = "running";
  } else if (has("DISPATCH_STARTED") || has("SEND_CONFIRMED") || has("INPUT_CONFIRMED")) {
    state = "dispatched";
  } else if (has("TASK_ENQUEUED")) {
    state = "queued";
  } else {
    state = "published";
  }

  if (has("TASK_PUBLISHED") && started === false && !has("TASK_ENQUEUED")) {
    findings.push({
      kind: "never_dispatched",
      severity: "warning",
      taskId,
      dispatchId: null,
      detail: "the task was published but never dispatched and never queued",
      events: ["TASK_PUBLISHED"],
    });
  }

  const pending = context?.pending ?? [];
  const inFlight = context?.current ?? null;
  const inRelay = pending.includes(taskId) || inFlight === taskId;

  if (inRelay === false && state !== "completed" && state !== "blocked" && has("TASK_PUBLISHED")) {
    /*
     * Two different answers to the same question, and only a human can tell
     * them apart:
     *
     *   lost        the ledger knows a task the relay does not, and nothing
     *               says what became of it - blocking, and blocking is the
     *               only safe answer because a lost task may be running now;
     *   closed      an operator looked at the chain, saw that WorkBuddy
     *               finished the work, and decided it will never be resent -
     *               the orphan is settled, and the event is recorded rather
     *               than the task, so the history stays readable.
     *
     * A closure never covers what happens after it: a send recorded after the
     * closure is judged on its own, so a later abnormal execution cannot be
     * hidden by an older decision.
     */
    if (closedByOperator) {
      findings.push({
        kind: "historical_task_closed",
        severity: "info",
        taskId,
        dispatchId: null,
        events: ["RECONCILIATION_RESOLVED"],
        detail:
          `task ${taskId} is not in the relay state, and an operator closed it at seq ${closedAtSeq} ` +
          `without it being resent; the old orphan is settled, the task stays out of the queue, and ` +
          `nothing after seq ${closedAtSeq} is covered by this decision`,
      });
    } else {
      findings.push({
        kind: "orphaned_task",
        severity: "blocking",
        taskId,
        dispatchId: null,
        detail:
          `task ${taskId} is in the ledger but no longer in the relay state ` +
          `(not queued, not in flight); it has to be reconciled against GPT, not silently resent`,
        events: ["TASK_PUBLISHED"],
      });
    }
  }

  if (has("TASK_REQUEUED") && !has("RUNNING_CONFIRMED")) {
    findings.push({
      kind: "resend_allowed",
      severity: "info",
      taskId,
      dispatchId: null,
      detail:
        "the task was requeued and nothing ever confirmed that it ran, so a retry is not a duplicate",
      events: ["TASK_REQUEUED"],
    });
  }

  const blocking = findings.some((finding) => finding.severity === "blocking");

  /*
   * A retry once nothing confirmed the task ran is safe; a retry after that is
   * a duplicate send, and that is never allowed. The proof that beats a
   * requeue is any evidence that WorkBuddy got the task, so the old requeue
   * row from an earlier release cannot reopen a send that already happened -
   * and a task an operator closed is not ours to send either.
   */
  const mayResend =
    !blocking && closure === null && has("TASK_REQUEUED") && !hasProvenSend(evidence);

  if (findings.length === 0) {
    findings.push({
      kind: "matched",
      severity: "info",
      taskId,
      dispatchId: dispatchIds[0] ?? null,
      detail: "the recorded chain matches the expected one",
      events: evidence,
    });
  }

  return {
    taskId,
    fingerprint: identities[0] ?? UNKNOWN_FINGERPRINT,
    fingerprints,
    identities,
    dispatchIds,
    attempts,
    evidence,
    state,
    findings,
    closedAtSeq,
    mayResend,
  };
}

/** Reads the whole ledger and reports on every task in append order. */
export function reconcile(
  events: readonly ReconciliationEvent[],
  options?: { reason?: string; now?: Date; corruptLines?: number; pending?: readonly string[]; current?: string | null },
): ReconciliationReport {
  const reason = options?.reason ?? "manual";
  if (events.length === 0) return emptyReport(reason, options?.corruptLines ?? 0);

  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const groups = new Map<string, ReconciliationEvent[]>();
  for (const event of ordered) {
    const bucket = groups.get(event.taskId);
    if (bucket) bucket.push(event);
    else groups.set(event.taskId, [event]);
  }

  const context = {
    pending: options?.pending ?? [],
    current: options?.current ?? null,
  };

  const tasks = [...groups.entries()].map(([taskId, group]) => reconcileTask(group, context));

  const findings = tasks.flatMap((task) => task.findings);

  /*
   * A result that belongs to a task the relay is not running is a contradiction
   * between the ledger and the live state, and the state is what every other
   * decision is made from. Whichever one is wrong, the answer is the same:
   * stop scheduling until a human has said which is true, because the result
   * may have been produced by something that is still running.
   */
  const inFlight = context.current;

  if (inFlight) {
    for (const task of tasks) {
      if (task.taskId === inFlight) continue;
      if (!task.evidence.includes("RESULT_RECEIVED") && !task.evidence.includes("RESULT_DELIVERED")) {
        continue;
      }

      findings.push({
        kind: "result_task_id_mismatch",
        severity: "blocking",
        taskId: task.taskId,
        dispatchId: task.dispatchIds[0] ?? null,
        events: task.evidence.filter(
          (event) => event === "RESULT_RECEIVED" || event === "RESULT_DELIVERED",
        ),
        detail:
          `task ${task.taskId} produced a result while the relay had ${inFlight} in flight; ` +
          `the ledger and the live state disagree and neither is proven, so scheduling stops`,
      });
    }
  }

  return {
    generatedAt: (options?.now ?? new Date()).toISOString(),
    reason,
    tasks,
    findings,
    blocked: findings.some((finding) => finding.severity === "blocking"),
    resendAllowed: tasks.some((task) => task.mayResend),
    tasksSeen: tasks.length,
    corruptLines: options?.corruptLines ?? 0,
  };
}
