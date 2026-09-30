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
  ModelSelectionSource,
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

/**
 * Resolves what a task asked for against the catalog.
 *
 * Ids win over labels: a label is a UI string that can be renamed, an id is
 * the stable key every persisted block is stored under. Returning null for an
 * unknown request is deliberate - a typo must not become a selection.
 */
export function resolveModelId(
  models: readonly ModelDefinition[],
  requested: string | null | undefined,
): string | null {
  if (typeof requested !== "string") return null;
  const needle = requested.trim();
  if (needle === "") return null;

  const hit =
    models.find((model) => model.id === needle) ??
    models.find((model) => model.label === needle);

  return hit ? hit.id : null;
}

/**
 * The models to try after `requestedId` proves unusable.
 *
 * An explicit chain (from `MODEL_FALLBACKS`) is honoured first, then the
 * catalog order is appended so an incomplete chain can never leave a model
 * unreachable. The requested model itself is never offered: by the time this
 * runs it is known to be unusable, so returning it would be a dead end.
 */
export function fallbackOrder(
  models: readonly ModelDefinition[],
  requestedId: string,
  fallbacks?: Readonly<Record<string, readonly string[]>>,
): string[] {
  const known = new Set(models.map((model) => model.id));
  const ordered: string[] = [];

  const push = (id: string): void => {
    if (id === requestedId) return;
    if (known.has(id) && !ordered.includes(id)) ordered.push(id);
  };

  for (const id of fallbacks?.[requestedId] ?? []) push(id);
  for (const model of models) push(model.id);

  return ordered;
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
  /** What the task explicitly asked for; see ModelSelectionRequest. */
  requestedModelId?: string | null | undefined;
  /** Reserved seam for the future user-preference layer. */
  userPreferenceId?: string | null | undefined;
  /** Per-model fallback chains, keyed by the requested model's id. */
  fallbacks?: Readonly<Record<string, readonly string[]>> | undefined;
};

function selected(args: {
  model: ModelDefinition;
  source: ModelSelectionSource;
  requestedModelId: string | null;
  fellBack: boolean;
}): ModelSelection {
  return {
    kind: "selected",
    model: { ...args.model },
    pinned: args.source === "pin",
    requestedModelId: args.requestedModelId,
    source: args.source,
    fellBack: args.fellBack,
  };
}

export function selectModel(args: SelectModelArgs): ModelSelection {
  const nowMs = typeof args.now === "number" ? args.now : args.now.getTime();
  const evaluated = evaluateAvailability(args.models, args.runtime, nowMs);
  const requestedId = resolveModelId(args.models, args.requestedModelId);

  /*
   * The pin answers first, always.
   *
   * It describes the model of the turn already running in WorkBuddy. Honouring
   * a new task's request over it would mean yanking the model out from under
   * work in flight, which is the one thing this pin exists to prevent.
   */
  if (args.pin) {
    const pinned = args.models.find((model) => model.id === args.pin);
    if (pinned) {
      return selected({
        model: pinned,
        source: "pin",
        requestedModelId: requestedId,
        fellBack: false,
      });
    }
  }

  const requested = requestedId
    ? evaluated.find((entry) => entry.model.id === requestedId)
    : undefined;

  if (requested?.available) {
    return selected({
      model: requested.model,
      source: "requested",
      requestedModelId: requestedId,
      fellBack: false,
    });
  }

  /*
   * The request could not be honoured. A task asking for a model is not the
   * same as a task that cannot run at all, so this steps down the chain
   * instead of reporting no_available_model - the text still has to go
   * somewhere, and the router's job is to find the model that can take it.
   */
  if (requestedId) {
    for (const id of fallbackOrder(args.models, requestedId, args.fallbacks)) {
      const entry = evaluated.find((candidate) => candidate.model.id === id);
      if (entry?.available) {
        return selected({
          model: entry.model,
          source: "requested",
          requestedModelId: requestedId,
          fellBack: true,
        });
      }
    }
  }

  // Reserved seam: an operator/user preference outranks plain priority.
  const preferenceId = resolveModelId(args.models, args.userPreferenceId);
  if (preferenceId) {
    const entry = evaluated.find((candidate) => candidate.model.id === preferenceId);
    if (entry?.available) {
      return selected({
        model: entry.model,
        source: "preference",
        requestedModelId: requestedId,
        fellBack: false,
      });
    }
  }

  const first = evaluated.find((entry) => entry.available);
  if (first) {
    return selected({
      model: first.model,
      source: "priority",
      requestedModelId: requestedId,
      fellBack: false,
    });
  }

  return {
    kind: "no_available_model",
    reasons: evaluated
      .filter((entry) => !entry.available)
      .map(toUnavailableReason),
    nextResetAt: nextResetAt(evaluated, nowMs),
  };
}
