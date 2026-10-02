import { TaskLedger } from "./ledger.js";
import { reconcile } from "./reconcile.js";
import type {
  ReconciliationEvent,
  ReconciliationEventName,
  ReconciliationSource,
} from "./types.js";

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

    const prior = [...new Set(history.map((event) => event.taskFingerprint))];
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
   * The end of a hold, recorded rather than edited.
   *
   * A hold is lifted by a NEW event saying why the chain is now explainable,
   * never by rewriting or deleting what the ledger already says. That is the
   * only way an operator can lift a freeze without erasing the evidence of the
   * mistake that froze it.
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

  /** Reads the ledger and reports on every task it knows about. */
  async reconcile(reason: string): Promise<{
    report: import("./reconcile.js").ReconciliationReport;
    corruptLines: number;
  }> {
    const { events, corruptLines } = await this.ledger.list();
    const report = reconcile(events, { reason, corruptLines });

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

