/**
 * Model catalog and configuration resolution.
 *
 * The array order IS the priority order. Adding a model later means pushing one
 * more entry here - there is deliberately no four-model-specific logic anywhere
 * in this module or in the selection rules.
 *
 * ids are stable machine identifiers; labels are the WorkBuddy UI strings.
 * Business state is always keyed by id, so renaming a label can never break
 * persisted blocks.
 */

import type { ModelDefinition } from "./types.js";

export const DEFAULT_MODELS: readonly ModelDefinition[] = [
  { id: "hy4-preview", label: "Hy4 preview", enabled: true },
  { id: "hy3", label: "Hy3", enabled: true },
  { id: "deepseek-v4.1-flash", label: "Deepseek-V4.1-Flash", enabled: true },
  { id: "glm-5.3-flash", label: "GLM-5.3-Flash", enabled: true },
];

export type ModelConfigOverrides = {
  /** Requested order; known ids are hoisted, unknown ids are ignored. */
  priority?: readonly string[];
  /** ids to force off; unknown ids are ignored. */
  disabled?: readonly string[];
};

/**
 * Applies optional priority/enabled overrides to the catalog.
 * Models missing from `priority` keep their catalog order and are appended.
 */
export function resolveModels(
  overrides: ModelConfigOverrides = {},
  catalog: readonly ModelDefinition[] = DEFAULT_MODELS,
): ModelDefinition[] {
  const models = catalog.map((model) => ({ ...model }));
  const disabled = new Set(overrides.disabled ?? []);

  let ordered = models;

  const priority = overrides.priority ?? [];
  if (priority.length > 0) {
    const remaining = new Map(models.map((model) => [model.id, model]));
    const hoisted: ModelDefinition[] = [];

    for (const id of priority) {
      const model = remaining.get(id);
      if (!model) continue;
      hoisted.push(model);
      remaining.delete(id);
    }

    ordered = [...hoisted, ...models.filter((m) => remaining.has(m.id))];
  }

  if (disabled.size === 0) return ordered;

  return ordered.map((model) =>
    disabled.has(model.id) ? { ...model, enabled: false } : model,
  );
}
