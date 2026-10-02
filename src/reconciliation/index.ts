import { identityFingerprints, UNKNOWN_FINGERPRINT } from "./fingerprint.js";
import { TaskLedger } from "./ledger.js";
import { reconcile } from "./reconcile.js";
import type { ReconciliationLiveContext } from "./reconcile.js";
import type {
  ReconciliationEvent,
  ReconciliationEventName,
  ReconciliationSource,
} from "./types.js";

/** The answer to "close this task for good". */
export type CloseTaskResult =
  | { ok: true; event: ReconciliationEvent }
  | { ok: false; message: string };

export { TaskLedger, defaultLedgerUrl } from "./ledger.js";
export * from "./fingerprint.js";
export * from "./reconcile.js";
export type * from "./decision.js";
export { decideDispatch } from "./decision.js";
export * from "./types.js";

/**
 * The relay's public door into reconciliation.
 *
 * Relay Core only ever calls these five verbs. Nothing about how a ledger is
 * stored on disk, nor how a contradiction is recognised, lives here; the class
 * is the seam, not the logic.
 */
export class ReconciliationService {
  constructor(private readonly ledger: TaskLedger) {}

  /**
   * Records a task as published.
   *
   * Publishing is where a contradiction has to be caught: the same taskId
   * under a second fingerprint is not an update, and this refuses to make it
   * one. The refusal is recorded, so the ledger shows why the task never ran.
   */
  async recordTaskPublished(input: {
    taskId: string;
    taskFingerprint: string;
    messageFingerprint?: string | null;
    source?: ReconciliationSource;
    detail?: Record<string, unknown> | null;
  }): Promise<{ status: "ok" | "blocked"; taskId: string; fingerprint: string }> {
    const source = input.source ?? "gpt";
    const history = await this.ledger.history(input.taskId);

    /*
     * Only rows that name a task can collide with this one. A ledger that
     * already holds bookkeeping under the placeholder - which is what an older
     * requeue or a resolution wrote - is not a second envelope, so publishing
     * the real work underneath it is the normal thing, not a contradiction.
     */
    const prior = identityFingerprints(history.map((event) => event.taskFingerprint));
    const conflict = prior.find((fingerprint) => fingerprint !== input.taskFingerprint);

    if (conflict) {
      await this.ledger.appendMany([
        {
          event: "TASK_BLOCKED",
          taskId: input.taskId,
          taskFingerprint: input.taskFingerprint,
          source,
          messageFingerprint: input.messageFingerprint ?? null,
          detail: {
            reason: "identity_conflict",
            previousFingerprint: conflict,
            currentFingerprint: input.taskFingerprint,
          },
        },
        {
          event: "RECONCILIATION_BLOCKED",
          taskId: input.taskId,
          taskFingerprint: input.taskFingerprint,
          source: "relay",
          messageFingerprint: input.messageFingerprint ?? null,
          detail: {
            reason: "identity_conflict",
            previousFingerprint: conflict,
            currentFingerprint: input.taskFingerprint,
          },
        },
      ]);

      return { status: "blocked", taskId: input.taskId, fingerprint: input.taskFingerprint };
    }

    await this.ledger.append({
      event: "TASK_PUBLISHED",
      taskId: input.taskId,
      taskFingerprint: input.taskFingerprint,
      source,
      messageFingerprint: input.messageFingerprint ?? null,
      detail: input.detail ?? null,
    });

    return { status: "ok", taskId: input.taskId, fingerprint: input.taskFingerprint };
  }

  /** A task accepted for a turn: it is going to be sent, not just queued. */
  async recordTaskAccepted(input: {
    taskId: string;
    taskFingerprint: string;
    messageFingerprint?: string | null;
    source?: ReconciliationSource;
  }): Promise<ReconciliationEvent> {
    return this.ledger.append({
      event: "TASK_ACCEPTED",
      taskId: input.taskId,
      taskFingerprint: input.taskFingerprint,
      source: input.source ?? "relay",
      messageFingerprint: input.messageFingerprint ?? null,
    });
  }

  /** A task went to the queue instead of a turn. */
  async recordTaskEnqueued(input: {
    taskId: string;
    taskFingerprint: string;
    dispatchId?: string | null;
    attempt?: number | null;
    source?: ReconciliationSource;
    detail?: Record<string, unknown> | null;
  }): Promise<ReconciliationEvent> {
    return this.ledger.append({
      event: "TASK_ENQUEUED",
      taskId: input.taskId,
      taskFingerprint: input.taskFingerprint,
      dispatchId: input.dispatchId ?? null,
      attempt: input.attempt ?? null,
      source: input.source ?? "relay",
      detail: input.detail ?? null,
    });
  }

  /** One real attempt to run a task. Every send has one, and only one. */
  async recordDispatch(input: {
    taskId: string;
    taskFingerprint: string;
    dispatchId: string;
    attempt: number;
    model?: string | null;
    executor?: string | null;
    source?: ReconciliationSource;
    detail?: Record<string, unknown> | null;
  }): Promise<ReconciliationEvent> {
    return this.ledger.append({
      event: "DISPATCH_STARTED",
      taskId: input.taskId,
      taskFingerprint: input.taskFingerprint,
      dispatchId: input.dispatchId,
      attempt: input.attempt,
      model: input.model ?? null,
      executor: input.executor ?? "workbuddy",
      source: input.source ?? "relay",
      detail: input.detail ?? null,
    });
  }

  /** Any of the execution evidence events, recorded with the same identity. */
  async recordExecutionEvidence(input: {
    event: Extract<
      ReconciliationEventName,
      | "INPUT_CONFIRMED"
      | "SEND_CONFIRMED"
      | "RUNNING_CONFIRMED"
      | "RESULT_RECEIVED"
      | "RESULT_PERSISTED"
      | "RESULT_DELIVERED"
      | "RESULT_ACKED"
      | "INPUT_CONFIRM_FAILED"
      | "SEND_CONFIRM_FAILED"
      | "RUNNING_CONFIRM_TIMEOUT"
      | "DISPATCH_STALLED"
      | "TASK_COMPLETED"
      | "TASK_REQUEUED"
      | "TASK_BLOCKED"
    >;
    taskId: string;
    taskFingerprint: string;
    dispatchId?: string | null;
    attempt?: number | null;
    workbuddyMessageId?: string | null;
    resultId?: string | null;
    source?: ReconciliationSource;
    detail?: Record<string, unknown> | null;
  }): Promise<ReconciliationEvent> {
    return this.ledger.append({
      event: input.event,
      taskId: input.taskId,
      taskFingerprint: input.taskFingerprint,
      dispatchId: input.dispatchId ?? null,
      attempt: input.attempt ?? null,
      workbuddyMessageId: input.workbuddyMessageId ?? null,
      source: input.source ?? "relay",
      detail: input.detail ?? null,
    });
  }

  /**
   * Closes one task the live state has forgotten.
   *
   * This is the operator half of reconciliation: the relay knows the task is
   * gone from the state file, WorkBuddy ran it, and no result ever came back
   * into the relay - so the human says "it is finished, never send it again"
   * and that single decision is written against the task it names.
   *
   * What it deliberately does not do: delete or rewrite any earlier line,
   * invent a `TASK_COMPLETED`, `RESULT_RECEIVED` or acknowledgement that
   * never happened, put the task back on the queue, or touch any other task.
   * The closure is a new row that explains the old one, which is the only
   * form a decision may take in an append-only ledger.
   */
  async recordTaskClosedWithoutResend(input: {
    taskId: string;
    reason: string;
    source?: ReconciliationSource;
  }): Promise<CloseTaskResult> {
    const taskId = input.taskId.trim();
    if (taskId.length === 0) {
      return { ok: false, message: "a historical close needs the task it closes" };
    }

    const event = await this.ledger.append({
      event: "RECONCILIATION_RESOLVED",
      taskId,
      // Bookkeeping: the row closes a task, it does not name an envelope.
      taskFingerprint: UNKNOWN_FINGERPRINT,
      source: input.source ?? "control",
      detail: {
        disposition: "close_without_resend",
        reason: input.reason,
        taskId,
      },
    });

    return { ok: true, event };
  }

  /**
   * The end of a hold, recorded rather than edited.
   *
   * A hold is lifted by a NEW event saying why the chain is now explainable,
   * never by rewriting or deleting what the ledger already says. That is the
   * only way an operator can lift a freeze without erasing the evidence of the
   * mistake that froze it.
   *
   * With no task to point at it writes the placeholder, which is honest: the
   * resolution belongs to every task the hold froze, not to one of them. The
   * placeholder is bookkeeping, so it never counts as a task identity and its
   * presence cannot produce an identity conflict.
   */
  async recordReconciliationResolved(input: {
    taskId?: string | null;
    taskFingerprint?: string | null;
    reason: string;
    source?: ReconciliationSource;
  }): Promise<ReconciliationEvent> {
    return this.ledger.append({
      event: "RECONCILIATION_RESOLVED",
      taskId: input.taskId ?? "*",
      taskFingerprint: input.taskFingerprint ?? "*",
      source: input.source ?? "control",
      detail: { reason: input.reason },
    });
  }

  /** How many events the ledger holds. Cheap because it is only ever read. */
  async ledgerLength(): Promise<number> {
    return this.ledger.length();
  }

  async getTaskHistory(taskId: string): Promise<ReconciliationEvent[]> {
    return this.ledger.history(taskId);
  }

  /**
   * Reads the ledger and reports on every task it knows about.
   *
   * `context` is what the live relay is holding right now. It is not optional
   * decoration: without it every unfinished task in the ledger - including the
   * one being run this very second - reads as orphaned and freezes scheduling,
   * so the caller passes the queue and the task in flight as they are.
   */
  async reconcile(
    reason: string,
    context?: ReconciliationLiveContext,
  ): Promise<{
    report: import("./reconcile.js").ReconciliationReport;
    corruptLines: number;
  }> {
    const { events, corruptLines } = await this.ledger.list();
    const report = reconcile(events, {
      reason,
      corruptLines,
      pending: context?.pending ?? [],
      current: context?.current ?? null,
    });

    return { report, corruptLines };
  }

  /** Records that a reconciliation pass happened, and what it concluded. */
  async recordReconciliationOutcome(
    report: import("./reconcile.js").ReconciliationReport,
  ): Promise<void> {
    const blocking = report.findings.filter((finding) => finding.severity === "blocking");

    await this.ledger.append({
      event: blocking.length > 0 ? "RECONCILIATION_BLOCKED" : "RECONCILIATION_MATCHED",
      taskId: blocking[0]?.taskId ?? report.tasks[0]?.taskId ?? "*",
      taskFingerprint: report.tasks[0]?.fingerprint ?? "*",
      source: "relay",
      detail: {
        reason: report.reason,
        tasksSeen: report.tasksSeen,
        findings: report.findings.map((finding) => ({
          kind: finding.kind,
          severity: finding.severity,
          taskId: finding.taskId,
        })),
      },
    });
  }
}

