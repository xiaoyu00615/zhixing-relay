/**
 * Model Router domain types.
 *
 * Static configuration (who exists, in what order) and dynamic runtime state
 * (who is blocked right now) are deliberately separate types, because they are
 * stored separately: configuration is code/env, runtime state is a file under
 * data/ that must never be committed.
 *
 * All timestamps are absolute ISO 8601 strings. Relative values such as
 * "blocked for another 2 hours" are never persisted - only the instant the
 * block expires. That way a restart, or a machine whose clock moved, can still
 * decide availability correctly.
 */

export type ModelDefinition = {
  id: string;
  label: string;
  enabled: boolean;
};

export type ModelRuntimeState = {
  blockedUntil: string | null;
  reason: string | null;
};

export type ModelUnavailableKind = "disabled" | "blocked";

export type ModelUnavailableReason = {
  modelId: string;
  label: string;
  kind: ModelUnavailableKind;
  blockedUntil: string | null;
  reason: string | null;
};

export type ModelSelection =
  | {
      kind: "selected";
      model: ModelDefinition;
      /** true when the result came from the shared pin, not from priority. */
      pinned: boolean;
    }
  | {
      kind: "no_available_model";
      reasons: ModelUnavailableReason[];
      /** Earliest block expiry among selectable models, or null if none. */
      nextResetAt: string | null;
    };

export type ModelAvailability = {
  model: ModelDefinition;
  runtime: ModelRuntimeState;
  available: boolean;
  unavailableKind: ModelUnavailableKind | null;
};

export type ModelRouterSnapshot = {
  /** The instant this snapshot was evaluated (injected in tests). */
  now: string;
  /** Model id currently pinned by the in-flight task, or null. */
  pin: string | null;
  models: ModelAvailability[];
  nextResetAt: string | null;
};

export type PersistedModelState = {
  version: 1;
  updatedAt: string | null;
  models: Record<string, ModelRuntimeState>;
  /**
   * Operator toggles from setEnabled(). These are runtime overrides of the
   * static config, so they live with the runtime state and survive restarts,
   * but they are NOT part of the versioned configuration itself.
   */
  enabledOverrides: Record<string, boolean>;
};
