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
  /** Per-model fallback chains, keyed by the model id. */
  fallbacks?: Readonly<Record<string, readonly string[]>>;
};

/**
 * Parses `MODEL_FALLBACKS="hy4-preview:hy3|hy3:glm-5.3-flash"`.
 *
 * The form is deliberately flat text instead of JSON: this lives in .env next
 * to MODEL_PRIORITY, and a colon-plus-pipe grammar reads faster than an
 * escaped array while offering nothing JSON would.
 *
 * A chain entry containing ":" is dropped: the grammar has no way to escape
 * one, so a stray colon means the operator started another pair.
 */
export function parseFallbackMap(value: string | null | undefined): Record<
  string,
  string[]
> {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "") return {};

  const map: Record<string, string[]> = {};

  for (const pair of raw.split("|")) {
    const trimmed = pair.trim();
    if (trimmed === "") continue;

    const separator = trimmed.indexOf(":");
    if (separator <= 0) continue;

    const key = trimmed.slice(0, separator).trim();
    const chain = trimmed
      .slice(separator + 1)
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "" && !item.includes(":"));

    if (key === "" || chain.length === 0) continue;
    map[key] = chain;
  }

  return map;
}

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
