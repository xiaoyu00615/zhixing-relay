/**
 * Persistence for Model Router runtime state (blockedUntil / reason and
 * operator enabled toggles).
 *
 * Same shape as RelayStore - constructor-injected URL plus
 * load/snapshot/mutate/save - so the two stores read consistently, but it owns
 * its own file: sharing state.json would drag model data through
 * RelayStore.mutate(), which truncates its own arrays on every write.
 *
 * Writes are atomic (temp file + rename) so a crash mid-write cannot leave a
 * truncated JSON file behind and silently wipe every block on the next boot.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelRuntimeState, PersistedModelState } from "./types.js";

const EMPTY: PersistedModelState = {
  version: 1,
  updatedAt: null,
  models: {},
  enabledOverrides: {},
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function sanitizeRuntimeMap(input: Record<string, unknown>): Record<
  string,
  ModelRuntimeState
> {
  const result: Record<string, ModelRuntimeState> = {};

  for (const [id, value] of Object.entries(input)) {
    if (!isRecord(value)) continue;
    result[id] = {
      blockedUntil: nullableString(value.blockedUntil),
      reason: nullableString(value.reason),
    };
  }

  return result;
}

function sanitizeBooleanMap(
  input: Record<string, unknown>,
): Record<string, boolean> {
  const result: Record<string, boolean> = {};

  for (const [id, value] of Object.entries(input)) {
    if (typeof value === "boolean") result[id] = value;
  }

  return result;
}

export class ModelStateStore {
  private state: PersistedModelState = structuredClone(EMPTY);

  constructor(private readonly url: URL) {}

  async load(): Promise<PersistedModelState> {
    const path = fileURLToPath(this.url);

    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedModelState>;

      this.state = {
        version: 1,
        updatedAt: nullableString(parsed?.updatedAt),
        models: isRecord(parsed?.models)
          ? sanitizeRuntimeMap(parsed.models)
          : {},
        enabledOverrides: isRecord(parsed?.enabledOverrides)
          ? sanitizeBooleanMap(parsed.enabledOverrides)
          : {},
      };
    } catch {
      this.state = structuredClone(EMPTY);
      await this.save();
    }

    return this.snapshot();
  }

  snapshot(): PersistedModelState {
    return structuredClone(this.state);
  }

  async mutate(mutator: (state: PersistedModelState) => void): Promise<void> {
    mutator(this.state);
    this.state.updatedAt = new Date().toISOString();
    await this.save();
  }

  /** Re-reads from disk, so external edits / restarts are picked up. */
  async reload(): Promise<PersistedModelState> {
    return this.load();
  }

  private async save(): Promise<void> {
    const path = fileURLToPath(this.url);
    await mkdir(dirname(path), { recursive: true });

    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2), "utf8");
    await rename(tmp, path);
  }
}
