/**
 * The delivery acknowledgement state machine.
 *
 * "Relay is busy" is not the same question as "the task has arrived". The old
 * single enum had to answer both, which is why a relay that had clicked send
 * looked exactly like one that was still waiting for WorkBuddy. The global
 * `RelayState` keeps describing the relay; `TaskExecutionStage` describes what
 * ONE task has reached, and it is the part that carries evidence.
 *
 * The stage may only move forward. An acknowledgement that belongs to an
 * older dispatch, or a stage that would take the task backwards, is stale
 * rather than contradictory: it is dropped here instead of being allowed to
 * rewrite a round that is already in flight.
 */

/** Where one dispatch of one task currently stands. */
export type TaskExecutionStage =
  | "QUEUED"
  | "DISPATCHING"
  | "INPUT_CONFIRMED"
  | "SEND_CONFIRMED"
  | "RUNNING_CONFIRMED"
  | "RESULT_RECEIVED"
  | "RESULT_PERSISTED"
  | "RESULT_DELIVERED"
  | "RESULT_ACKED"
  | "COMPLETED"
  | "RECONCILIATION_REQUIRED"
  | "BLOCKED"
  | "FAILED";

/** Every stage, in the order a healthy round walks through them. */
export const TASK_EXECUTION_STAGES: readonly TaskExecutionStage[] = [
  "QUEUED",
  "DISPATCHING",
  "INPUT_CONFIRMED",
  "SEND_CONFIRMED",
  "RUNNING_CONFIRMED",
  "RESULT_RECEIVED",
  "RESULT_PERSISTED",
  "RESULT_DELIVERED",
  "RESULT_ACKED",
  "COMPLETED",
  "RECONCILIATION_REQUIRED",
  "BLOCKED",
  "FAILED",
];

/** The stages a round walks through when everything goes right. */
const PIPELINE: readonly TaskExecutionStage[] = [
  "QUEUED",
  "DISPATCHING",
  "INPUT_CONFIRMED",
  "SEND_CONFIRMED",
  "RUNNING_CONFIRMED",
  "RESULT_RECEIVED",
  "RESULT_PERSISTED",
  "RESULT_DELIVERED",
  "RESULT_ACKED",
  "COMPLETED",
];

/**
 * Stages that report a problem rather than progress. They can be entered from
 * anywhere, because a task that was running can be cancelled and a task that
 * never started can be refused.
 */
const ALERT_STAGES: readonly TaskExecutionStage[] = [
  "RECONCILIATION_REQUIRED",
  "BLOCKED",
  "FAILED",
];

const STAGE_RANK: Record<TaskExecutionStage, number> = {
  QUEUED: 0,
  DISPATCHING: 1,
  INPUT_CONFIRMED: 2,
  SEND_CONFIRMED: 3,
  RUNNING_CONFIRMED: 4,
  RESULT_RECEIVED: 5,
  RESULT_PERSISTED: 6,
  RESULT_DELIVERED: 7,
  RESULT_ACKED: 8,
  COMPLETED: 9,
  RECONCILIATION_REQUIRED: -1,
  BLOCKED: -2,
  FAILED: -3,
};

/** Whether `value` is one of the stages above, so bad config cannot crash a read. */
export function isTaskExecutionStage(value: unknown): value is TaskExecutionStage {
  return typeof value === "string" && (TASK_EXECUTION_STAGES as readonly string[]).includes(value);
}

/** Position of a stage in the healthy order; alert stages sort before the first. */
export function stageRank(stage: TaskExecutionStage): number {
  return STAGE_RANK[stage];
}

/**
 * The durable record of one dispatch's progress.
 *
 * `stageStartedAt` and `lastProgressAt` exist for the watchdog this round only
 * prepares for: a stage that started long ago and never advanced is the only
 * thing that distinguishes "WorkBuddy is thinking" from "a poll died".
 */
export type TaskExecutionState = {
  stage: TaskExecutionStage;
  stageStartedAt: string;
  lastProgressAt: string;
  /** Bounded so a long round cannot grow the state file without limit. */
  history: TaskExecutionStage[];
  detail: Record<string, unknown> | null;
};

export function createExecutionState(input: {
  stage: TaskExecutionStage;
  at: string;
  detail?: Record<string, unknown> | null;
}): TaskExecutionState {
  return {
    stage: input.stage,
    stageStartedAt: input.at,
    lastProgressAt: input.at,
    history: [input.stage],
    detail: input.detail ?? null,
  };
}

/**
 * Moves a task to a new stage.
 *
 * Returns null when the move is not allowed, which is the caller's cue that
 * the acknowledgement was stale. An alert stage is always accepted, so a
 * cancellation can freeze a round that was mid-flight; a pipeline stage is
 * accepted only when it is genuinely further along, so a late copy of an older
 * acknowledgement can never rewind a task.
 */
export function advanceStage(
  current: TaskExecutionState | null | undefined,
  next: TaskExecutionStage,
  at: string,
): TaskExecutionState | null {
  if (!isTaskExecutionStage(next)) return null;

  const from = current?.stage;

  if (from === undefined) return createExecutionState({ stage: next, at });

  if (from === next) return current ?? null;

  const isAlert = ALERT_STAGES.includes(next);
  const forward = stageRank(next) > stageRank(from);

  if (!isAlert && !forward) return null;

  return {
    stage: next,
    stageStartedAt: next === from ? (current?.stageStartedAt ?? at) : at,
    lastProgressAt: at,
    history: [...(current?.history ?? []), next].slice(-32),
    detail: current?.detail ?? null,
  };
}

/** Whether a stage reports a problem, i.e. it may be re-entered. */
export function isAlertStage(stage: TaskExecutionStage): boolean {
  return ALERT_STAGES.includes(stage);
}

/** Writes extra evidence onto an existing stage without moving it. */
export function withStageDetail(
  state: TaskExecutionState | null | undefined,
  detail: Record<string, unknown>,
  at: string,
): TaskExecutionState | null {
  if (!state) return null;

  return {
    ...state,
    lastProgressAt: at,
    detail: { ...(state.detail ?? {}), ...detail },
  };
}

/**
 * True when an acknowledgement belongs to a dispatch the relay is no longer
 * running.
 *
 * This is the stale-evidence guard: an echo from an old round must not be
 * allowed to update the live task, because the live task may already be a
 * different task entirely.
 */
export function isStaleDispatch(
  current: { taskId?: string | undefined; dispatchId?: string | undefined } | null | undefined,
  incoming: { taskId?: string | undefined; dispatchId?: string | undefined },
): boolean {
  if (current?.taskId && incoming.taskId && current.taskId !== incoming.taskId) return true;
  if (!current?.dispatchId || !incoming.dispatchId) return false;
  return current.dispatchId !== incoming.dispatchId;
}
