/**
 * Identity model for task reconciliation.
 *
 * Four different things used to be expressed by one id, and the ambiguity is
 * what made a duplicated send look like a new task. They are分开 here on
 * purpose:
 *
 * - taskId        the business task GPT published
 * - dispatchId    this relay's attempt at running that task
 * - attempt       which loop iteration of that task this is
 * - taskFingerprint  the hash of the published TASK block
 *
 * A task is "the same task" when its taskId AND its fingerprint agree. Same
 * taskId with a different fingerprint is neither a retry of the old task nor a
 * rename of the new one: it is a contradiction, and a contradiction is a human
 * decision.
 */

/** Every event the ledger can hold. Append-only: nothing leaves this list. */
export type ReconciliationEventName =
  | "TASK_PUBLISHED"
  | "TASK_ACCEPTED"
  | "TASK_ENQUEUED"
  | "DISPATCH_STARTED"
  | "INPUT_CONFIRMED"
  | "SEND_CONFIRMED"
  | "RUNNING_CONFIRMED"
  | "RESULT_RECEIVED"
  | "RESULT_DELIVERED"
  | "TASK_COMPLETED"
  | "TASK_CANCELLED"
  | "TASK_REQUEUED"
  | "TASK_BLOCKED"
  | "INPUT_CONFIRM_FAILED"
  | "SEND_CONFIRM_FAILED"
  | "RUNNING_CONFIRM_TIMEOUT"
  | "RESULT_PERSISTED"
  | "RESULT_ACKED"
  | "DISPATCH_STALLED"
  | "RECONCILIATION_STARTED"
  | "RECONCILIATION_MATCHED"
  | "RECONCILIATION_RESEND_ALLOWED"
  | "RECONCILIATION_BLOCKED"
  | "RECONCILIATION_RESOLVED";

export const RECONCILIATION_EVENTS: readonly ReconciliationEventName[] = [
  "TASK_PUBLISHED",
  "TASK_ACCEPTED",
  "TASK_ENQUEUED",
  "DISPATCH_STARTED",
  "INPUT_CONFIRMED",
  "SEND_CONFIRMED",
  "RUNNING_CONFIRMED",
  "RESULT_RECEIVED",
  "RESULT_DELIVERED",
  "TASK_COMPLETED",
  "TASK_CANCELLED",
  "TASK_REQUEUED",
  "TASK_BLOCKED",
  "INPUT_CONFIRM_FAILED",
  "SEND_CONFIRM_FAILED",
  "RUNNING_CONFIRM_TIMEOUT",
  "RESULT_PERSISTED",
  "RESULT_ACKED",
  "DISPATCH_STALLED",
  "RECONCILIATION_STARTED",
  "RECONCILIATION_MATCHED",
  "RECONCILIATION_RESEND_ALLOWED",
  "RECONCILIATION_BLOCKED",
  "RECONCILIATION_RESOLVED",
];

/** Where the event came from. The relay is not the only writer. */
export type ReconciliationSource =
  | "gpt"
  | "extension"
  | "workbuddy"
  | "relay"
  | "control";

/** What ran the task. Kept separate from `model`, which names the model. */
export type ReconciliationExecutor = string;

export type ReconciliationEvent = {
  /** Append order, assigned by the ledger. Never reassigned. */
  seq: number;
  at: string;
  event: ReconciliationEventName;
  taskId: string;
  taskFingerprint: string;
  dispatchId: string | null;
  attempt: number | null;
  source: ReconciliationSource;
  executor: ReconciliationExecutor | null;
  model: string | null;
  /** Fingerprint of the GPT message that carried the envelope, when known. */
  messageFingerprint: string | null;
  workbuddyMessageId: string | null;
  detail: Record<string, unknown> | null;
};

/** What a caller writes. `seq` is the ledger's, never the caller's. */
export type NewReconciliationEvent = Omit<ReconciliationEvent, "seq">;

export function makeEvent(
  input: {
    event: ReconciliationEventName;
    taskId: string;
    taskFingerprint: string;
    dispatchId?: string | null;
    attempt?: number | null;
    source: ReconciliationSource;
    executor?: ReconciliationExecutor | null;
    model?: string | null;
    messageFingerprint?: string | null;
    workbuddyMessageId?: string | null;
    detail?: Record<string, unknown> | null;
  },
  at: string,
): NewReconciliationEvent {
  return {
    at,
    event: input.event,
    taskId: input.taskId,
    taskFingerprint: input.taskFingerprint,
    dispatchId: input.dispatchId ?? null,
    attempt: input.attempt ?? null,
    source: input.source,
    executor: input.executor ?? null,
    model: input.model ?? null,
    messageFingerprint: input.messageFingerprint ?? null,
    workbuddyMessageId: input.workbuddyMessageId ?? null,
    detail: input.detail ?? null,
  };
}
