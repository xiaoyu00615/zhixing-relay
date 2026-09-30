/**
 * Pure selection rules.
 *
 * Nothing here touches the filesystem, the clock, the DOM or the Relay Core.
 * Time is always passed in, which is what makes quota-expiry recovery
 * testable without actually waiting.
 */

import type {
  ModelAvailability,
  ModelDefinition,
  ModelRuntimeState,
  ModelSelection,
  ModelUnavailableReason,
} from "./types.js";

export const EMPTY_RUNTIME_STATE: ModelRuntimeState = Object.freeze({
  blockedUntil: null,
  reason: null,
});

/** Parses an ISO string; returns null for empty/unparseable values. */
export function toEpochMs(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Normalises a Date or ISO string to a canonical absolute ISO string. */
export function toIsoString(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  if (Number.isNaN(ms)) {
    throw new Error(`invalid timestamp: ${JSON.stringify(String(value))}`);
  }
  return new Date(ms).toISOString();
}

/**
 * A block only holds while it is strictly in the future.
 * `blockedUntil <= now` means the quota window has elapsed and the model is
 * eligible again - no manual cleanup needed.
 */
export function isBlocked(runtime: ModelRuntimeState, nowMs: number): boolean {
  const untilMs = toEpochMs(runtime.blockedUntil);
  if (untilMs === null) return false;
  return untilMs > nowMs;
}

export function evaluateAvailability(
  models: readonly ModelDefinition[],
  runtime: Record<string, ModelRuntimeState>,
  nowMs: number,
): ModelAvailability[] {
  return models.map((model) => {
    const state = runtime[model.id] ?? EMPTY_RUNTIME_STATE;

    if (!model.enabled) {
      return {
        model: { ...model },
        runtime: { ...state },
        available: false,
        unavailableKind: "disabled" as const,
      };
    }

    if (isBlocked(state, nowMs)) {
      return {
        model: { ...model },
        runtime: { ...state },
        available: false,
        unavailableKind: "blocked" as const,
      };
    }

    return {
      model: { ...model },
      runtime: { ...state },
      available: true,
      unavailableKind: null,
    };
  });
}

export function toUnavailableReason(
  entry: ModelAvailability,
): ModelUnavailableReason {
  return {
    modelId: entry.model.id,
    label: entry.model.label,
    kind: entry.unavailableKind ?? "blocked",
    blockedUntil: entry.runtime.blockedUntil,
    reason: entry.runtime.reason,
  };
}

/**
 * Earliest future block expiry among models that would actually become usable.
 * A disabled model has no meaningful reset time, so it is excluded.
 */
export function nextResetAt(
  evaluated: readonly ModelAvailability[],
  nowMs: number,
): string | null {
  let earliest: number | null = null;

  for (const entry of evaluated) {
    if (entry.available) continue;
    if (entry.unavailableKind !== "blocked") continue;

    const untilMs = toEpochMs(entry.runtime.blockedUntil);
    if (untilMs === null || untilMs <= nowMs) continue;

    if (earliest === null || untilMs < earliest) earliest = untilMs;
  }

  return earliest === null ? null : new Date(earliest).toISOString();
}

export type SelectModelArgs = {
  models: readonly ModelDefinition[];
  runtime: Record<string, ModelRuntimeState>;
  now: Date | number;
  /**
   * Shared model id. When set, it wins over priority so that a higher-priority
   * model recovering mid-task cannot steal the running turn.
   */
  pin?: string | null;
};

export function selectModel(args: SelectModelArgs): ModelSelection {
  const nowMs = typeof args.now === "number" ? args.now : args.now.getTime();
  const evaluated = evaluateAvailability(args.models, args.runtime, nowMs);

  if (args.pin) {
    const pinned = args.models.find((model) => model.id === args.pin);
    if (pinned) {
      return { kind: "selected", model: { ...pinned }, pinned: true };
    }
  }

  const first = evaluated.find((entry) => entry.available);
  if (first) {
    return { kind: "selected", model: { ...first.model }, pinned: false };
  }

  return {
    kind: "no_available_model",
    reasons: evaluated
      .filter((entry) => !entry.available)
      .map(toUnavailableReason),
    nextResetAt: nextResetAt(evaluated, nowMs),
  };
}
