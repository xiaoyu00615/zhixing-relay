/**
 * ModelRouter - the operational facade over the pure selection rules.
 *
 * It owns three things:
 *   1. the resolved catalog (order = priority, plus enabled state),
 *   2. the persisted runtime state (blockedUntil / reason / enabled overrides),
 *   3. an in-memory pin for whichever model the in-flight task is using.
 *
 * Deliberately NOT owned here: anything WorkBuddy-specific. A future adapter
 * takes `selection.model.label` and drives the real UI; the TUI reads
 * `getSnapshot()`. Neither has to understand persistence or priority.
 */

import {
  DEFAULT_MODELS,
  type ModelConfigOverrides,
  resolveModels,
} from "./config.js";
import {
  EMPTY_RUNTIME_STATE,
  evaluateAvailability,
  isBlocked,
  nextResetAt,
  selectModel as selectByRules,
  toIsoString,
} from "./select.js";
import { ModelStateStore } from "./store.js";
import type {
  ModelDefinition,
  ModelRouterSnapshot,
  ModelSelection,
  ModelSelectionRequest,
} from "./types.js";

export type ModelRouterOptions = {
  models?: readonly ModelDefinition[];
  /** Per-model fallback chains, used when a requested model is unusable. */
  fallbacks?: Readonly<Record<string, readonly string[]>>;
  store: ModelStateStore;
  /**
   * Reserved seam for a future user-preference layer. Memory only, like the
   * pin: it describes an operator's current wish, not durable configuration.
   */
  userPreferenceId?: string | null;
};

export class ModelRouter {
  private readonly models: ModelDefinition[];
  private readonly fallbacks: Readonly<Record<string, readonly string[]>>;
  private readonly store: ModelStateStore;
  private userPreference: string | null = null;
  private state = {
    version: 1 as const,
    updatedAt: null as string | null,
    models: {} as Record<string, { blockedUntil: string | null; reason: string | null }>,
    enabledOverrides: {} as Record<string, boolean>,
  };
  private pinId: string | null = null;

  constructor(options: ModelRouterOptions) {
    this.models = (options.models ?? DEFAULT_MODELS).map((model) => ({
      ...model,
    }));
    this.fallbacks = options.fallbacks ?? {};
    this.store = options.store;
    this.userPreference = options.userPreferenceId ?? null;
  }

  /** Convenience factory for wiring from app config. */
  static create(url: URL, overrides: ModelConfigOverrides = {}): ModelRouter {
    return new ModelRouter({
      models: resolveModels(overrides),
      store: new ModelStateStore(url),
    });
  }

  async init(): Promise<void> {
    this.state = await this.store.load();
  }

  async reload(): Promise<void> {
    this.state = await this.store.reload();
  }

  /**
   * Picks the highest-priority usable model, or a structured
   * no_available_model result carrying every reason and the nearest recovery
   * time. Time is injectable; nothing here waits.
   */
  selectModel(now?: Date): ModelSelection;
  /** Same rules, but as asked for by one specific task. */
  selectModel(request?: ModelSelectionRequest): ModelSelection;
  selectModel(
    arg: Date | ModelSelectionRequest = {},
  ): ModelSelection {
    this.dropStalePin();

    const request: ModelSelectionRequest =
      arg instanceof Date ? { now: arg } : arg ?? {};

    return selectByRules({
      models: this.definitions(),
      runtime: this.state.models,
      now: request.now ?? new Date(),
      pin: this.pinId,
      requestedModelId: request.requestedModelId,
      userPreferenceId: request.userPreferenceId ?? this.userPreference,
      fallbacks: this.fallbacks,
    });
  }

  /**
   * Reserved seam for the future user-preference layer: a choice that outranks
   * the catalog priority but is weaker than a task's own `MODEL:` request.
   * Memory only, so a restart falls back to plain priority rather than
   * resurrecting a preference nobody re-affirmed.
   */
  setUserPreference(modelId: string | null): void {
    if (modelId === null) {
      this.userPreference = null;
      return;
    }
    this.assertKnown(modelId);
    this.userPreference = modelId;
  }

  userPreferenceId(): string | null {
    return this.userPreference;
  }

  /**
   * Blocks a model until an absolute instant. Accepts a Date or an ISO string;
   * relative durations are rejected rather than silently interpreted, because
   * "2 hours" would be wrong the moment the process restarts.
   */
  async blockModel(
    modelId: string,
    blockedUntil: Date | string,
    reason: string | null = null,
  ): Promise<void> {
    this.assertKnown(modelId);
    const iso = toIsoString(blockedUntil);

    await this.store.mutate((state) => {
      state.models[modelId] = { blockedUntil: iso, reason };
    });

    await this.reload();
  }

  async clearBlock(modelId: string): Promise<void> {
    this.assertKnown(modelId);

    await this.store.mutate((state) => {
      state.models[modelId] = { ...EMPTY_RUNTIME_STATE };
    });

    await this.reload();
  }

  /** Runtime override of the static `enabled` flag; survives restarts. */
  async setEnabled(modelId: string, enabled: boolean): Promise<void> {
    this.assertKnown(modelId);

    await this.store.mutate((state) => {
      state.enabledOverrides[modelId] = enabled;
    });

    await this.reload();
  }

  /** Optional hygiene: drops blocks whose expiry already passed. */
  async clearExpiredBlocks(now: Date = new Date()): Promise<number> {
    const nowMs = now.getTime();
    const expired = Object.entries(this.state.models)
      .filter(([, runtime]) => !isBlocked(runtime, nowMs))
      .map(([id]) => id);

    for (const id of expired) {
      await this.store.mutate((state) => {
        state.models[id] = { ...EMPTY_RUNTIME_STATE };
      });
    }

    if (expired.length > 0) await this.reload();
    return expired.length;
  }

  /**
   * Pins a model for the lifetime of the current task, so a higher-priority
   * model coming back cannot interrupt work already handed to WorkBuddy.
   * The pin is intentionally memory-only: it describes an in-flight turn, and
   * persisting it would let a crash resurrect a task-scoped selection.
   */
  pin(modelId?: string): ModelDefinition | null {
    if (modelId !== undefined) {
      this.assertKnown(modelId);
      this.pinId = modelId;
      return this.findById(modelId);
    }

    const selection = this.selectModel();
    if (selection.kind === "no_available_model") return null;

    this.pinId = selection.model.id;
    return selection.model;
  }

  releasePin(): void {
    this.pinId = null;
  }

  pinnedModelId(): string | null {
    return this.pinId;
  }

  /** Stable read model for TUI and future adapters. */
  getSnapshot(now: Date = new Date()): ModelRouterSnapshot {
    this.dropStalePin();

    const evaluated = evaluateAvailability(
      this.definitions(),
      this.state.models,
      now.getTime(),
    );

    return {
      now: now.toISOString(),
      pin: this.pinId,
      models: evaluated,
      nextResetAt: nextResetAt(evaluated, now.getTime()),
    };
  }

  private definitions(): ModelDefinition[] {
    return this.models.map((model) => {
      const override = this.state.enabledOverrides[model.id];
      return typeof override === "boolean"
        ? { ...model, enabled: override }
        : model;
    });
  }

  private assertKnown(modelId: string): void {
    if (!this.models.some((model) => model.id === modelId)) {
      throw new Error(`unknown model id: ${modelId}`);
    }
  }

  private findById(modelId: string): ModelDefinition {
    const found = this.models.find((model) => model.id === modelId);
    if (!found) throw new Error(`unknown model id: ${modelId}`);
    return { ...found };
  }

  /** A pin whose model left the catalog cannot be honoured silently. */
  private dropStalePin(): void {
    if (this.pinId === null) return;
    if (!this.models.some((model) => model.id === this.pinId)) {
      this.pinId = null;
    }
  }
}
