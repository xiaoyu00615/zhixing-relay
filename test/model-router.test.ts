import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MODELS,
  ModelRouter,
  ModelStateStore,
  toIsoString,
} from "../src/model-router/index.js";
import type { ModelDefinition } from "../src/model-router/index.js";

const IDS = {
  hy4: "hy4-preview",
  hy3: "hy3",
  deepseek: "deepseek-v4.1-flash",
  glm: "glm-5.3-flash",
} as const;

/** Injected clock - no test here ever waits in real time. */
const NOW = new Date("2026-10-01T00:00:00.000Z");

function isoAfterMs(ms: number): string {
  return new Date(NOW.getTime() + ms).toISOString();
}

function byIdOrder(ids: readonly string[]): ModelDefinition[] {
  const catalog = new Map(DEFAULT_MODELS.map((m) => [m.id, m]));
  return ids.map((id) => {
    const model = catalog.get(id);
    if (!model) throw new Error(`fixture bug: unknown id ${id}`);
    return { ...model };
  });
}

function withDisabled(ids: readonly string[]): ModelDefinition[] {
  return DEFAULT_MODELS.map((model) =>
    ids.includes(model.id) ? { ...model, enabled: false } : model,
  );
}

let sandboxDir = "";
let seq = 0;

beforeAll(async () => {
  sandboxDir = await mkdtemp(join(tmpdir(), "zxr-model-router-"));
});

afterAll(async () => {
  await rm(sandboxDir, { recursive: true, force: true });
});

let files: string[] = [];

beforeEach(() => {
  files = [];
});

async function makeRouter(
  models: readonly ModelDefinition[] = DEFAULT_MODELS,
): Promise<ModelRouter> {
  seq += 1;
  const file = join(sandboxDir, `models-${seq}.json`);
  files.push(file);

  const router = new ModelRouter({
    models,
    store: new ModelStateStore(pathToFileURL(file)),
  });
  await router.init();
  return router;
}

async function readPersisted(fileIndex = 0): Promise<unknown> {
  const file = files[fileIndex];
  if (!file) throw new Error("no persisted file allocated");
  return JSON.parse(await readFile(file, "utf8"));
}

describe("model router - default catalog", () => {
  it("ships the four configured models in the user-given priority order", () => {
    expect(DEFAULT_MODELS.map((m) => m.label)).toEqual([
      "Hy4 preview",
      "Hy3",
      "Deepseek-V4.1-Flash",
      "GLM-5.3-Flash",
    ]);
  });
});

describe("model router - selection rules", () => {
  it("A: all models available -> picks Hy4 preview", async () => {
    const router = await makeRouter();
    const selection = router.selectModel(NOW);

    expect(selection.kind).toBe("selected");
    if (selection.kind !== "selected") return;
    expect(selection.model.label).toBe("Hy4 preview");
    expect(selection.model.id).toBe(IDS.hy4);
  });

  it("B: top model blocked -> falls through to Hy3", async () => {
    const router = await makeRouter();
    await router.blockModel(IDS.hy4, isoAfterMs(60_000), "quota exceeded");

    const selection = router.selectModel(NOW);
    expect(selection.kind).toBe("selected");
    if (selection.kind !== "selected") return;
    expect(selection.model.label).toBe("Hy3");
  });

  it("C: top model disabled -> falls through to Hy3", async () => {
    const router = await makeRouter(withDisabled([IDS.hy4]));
    const selection = router.selectModel(NOW);

    expect(selection.kind).toBe("selected");
    if (selection.kind !== "selected") return;
    expect(selection.model.label).toBe("Hy3");
  });

  it("D: block past its resetAt -> Hy4 preview recovers automatically", async () => {
    const router = await makeRouter();
    await router.blockModel(IDS.hy4, isoAfterMs(-1), "quota exceeded");

    const selection = router.selectModel(NOW);
    expect(selection.kind).toBe("selected");
    if (selection.kind !== "selected") return;
    expect(selection.model.label).toBe("Hy4 preview");
  });

  it("E: first two blocked -> picks Deepseek-V4.1-Flash", async () => {
    const router = await makeRouter();
    await router.blockModel(IDS.hy4, isoAfterMs(60_000), "quota exceeded");
    await router.blockModel(IDS.hy3, isoAfterMs(120_000), "quota exceeded");

    const selection = router.selectModel(NOW);
    expect(selection.kind).toBe("selected");
    if (selection.kind !== "selected") return;
    expect(selection.model.label).toBe("Deepseek-V4.1-Flash");
  });

  it("F: first three blocked -> picks GLM-5.3-Flash", async () => {
    const router = await makeRouter();
    await router.blockModel(IDS.hy4, isoAfterMs(60_000), "quota exceeded");
    await router.blockModel(IDS.hy3, isoAfterMs(120_000), "quota exceeded");
    await router.blockModel(IDS.deepseek, isoAfterMs(180_000), "quota exceeded");

    const selection = router.selectModel(NOW);
    expect(selection.kind).toBe("selected");
    if (selection.kind !== "selected") return;
    expect(selection.model.label).toBe("GLM-5.3-Flash");
  });

  it("G: every model blocked -> no_available_model with reasons and nextResetAt", async () => {
    const router = await makeRouter();
    const soonest = isoAfterMs(30_000);

    await router.blockModel(IDS.hy4, isoAfterMs(600_000), "daily quota");
    await router.blockModel(IDS.hy3, soonest, "daily quota");
    await router.blockModel(IDS.deepseek, isoAfterMs(900_000), "daily quota");
    await router.blockModel(IDS.glm, isoAfterMs(120_000), "daily quota");

    const selection = router.selectModel(NOW);
    expect(selection.kind).toBe("no_available_model");
    if (selection.kind !== "no_available_model") return;

    expect(selection.reasons).toHaveLength(4);
    expect(selection.reasons.map((r) => r.modelId)).toEqual([
      IDS.hy4,
      IDS.hy3,
      IDS.deepseek,
      IDS.glm,
    ]);
    expect(selection.reasons.every((r) => r.kind === "blocked")).toBe(true);
    expect(selection.reasons.every((r) => r.reason === "daily quota")).toBe(
      true,
    );
    expect(selection.nextResetAt).toBe(soonest);
  });

  it("I: reordering the config array changes the next selection immediately", async () => {
    const router = await makeRouter(
      byIdOrder([IDS.glm, IDS.hy4, IDS.hy3, IDS.deepseek]),
    );

    const selection = router.selectModel(NOW);
    expect(selection.kind).toBe("selected");
    if (selection.kind !== "selected") return;
    expect(selection.model.label).toBe("GLM-5.3-Flash");
  });

  it("J: mixed disabled and blocked states resolve correctly", async () => {
    const router = await makeRouter(withDisabled([IDS.hy4]));
    await router.blockModel(IDS.hy3, isoAfterMs(60_000), "rate limited");

    const selection = router.selectModel(NOW);
    expect(selection.kind).toBe("selected");
    if (selection.kind !== "selected") return;
    expect(selection.model.label).toBe("Deepseek-V4.1-Flash");
  });

  it("J2: disabled models are reported with kind=disabled and no reset time", async () => {
    const router = await makeRouter(withDisabled([IDS.hy4, IDS.hy3]));
    await router.blockModel(IDS.deepseek, isoAfterMs(60_000), "rate limited");
    await router.blockModel(IDS.glm, isoAfterMs(90_000), "rate limited");

    const snapshot = router.getSnapshot(NOW);
    const kinds = snapshot.models.map((m) => m.unavailableKind);

    expect(kinds[0]).toBe("disabled");
    expect(kinds[1]).toBe("disabled");
    expect(snapshot.nextResetAt).toBe(isoAfterMs(60_000));
  });

  it("L: blockedUntil exactly equal to now -> model is eligible again", async () => {
    const router = await makeRouter();
    await router.blockModel(IDS.hy4, NOW.toISOString(), "quota exceeded");

    const atBoundary = router.selectModel(NOW);
    expect(atBoundary.kind).toBe("selected");
    if (atBoundary.kind !== "selected") return;
    expect(atBoundary.model.label).toBe("Hy4 preview");
  });
});

describe("model router - persistence", () => {
  it("H: blockedUntil survives re-instantiation from disk", async () => {
    const until = isoAfterMs(3_600_000);
    const router = await makeRouter();
    await router.blockModel(IDS.hy4, until, "quota exhausted");
    const fileBefore = files[0];

    // New instance against the same file, as after a relay restart.
    seq -= 1;
    const reloaded = await makeRouter();
    expect(files[0]).toBe(fileBefore);

    const selection = reloaded.selectModel(NOW);
    expect(selection.kind).toBe("selected");
    if (selection.kind !== "selected") return;
    expect(selection.model.label).toBe("Hy3");

    const snapshot = reloaded.getSnapshot(NOW);
    const hy4 = snapshot.models.find((m) => m.model.id === IDS.hy4);
    expect(hy4?.runtime.blockedUntil).toBe(until);
    expect(hy4?.runtime.reason).toBe("quota exhausted");
    expect(hy4?.available).toBe(false);
  });

  it("H2: an expired block needs no manual cleanup to be usable", async () => {
    const router = await makeRouter();
    await router.blockModel(IDS.hy4, isoAfterMs(-60_000), "quota exhausted");

    const reloaded = await makeRouter();
    expect(reloaded.selectModel(NOW)).toMatchObject({ kind: "selected" });
  });

  it("H3: setEnabled survives a restart as a runtime override", async () => {
    const router = await makeRouter();
    await router.setEnabled(IDS.hy4, false);

    seq -= 1;
    const reloaded = await makeRouter();
    const selection = reloaded.selectModel(NOW);

    expect(selection.kind).toBe("selected");
    if (selection.kind !== "selected") return;
    expect(selection.model.label).toBe("Hy3");
  });

  it("H4: corrupt state file falls back to an empty state instead of throwing", async () => {
    const router = await makeRouter();
    const file = files[0];
    if (!file) throw new Error("fixture did not allocate a state file");

    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, "{ this is not json", "utf8");

    seq -= 1;
    const reloaded = await makeRouter();
    const selection = reloaded.selectModel(NOW);

    expect(selection.kind).toBe("selected");
    if (selection.kind !== "selected") return;
    expect(selection.model.label).toBe("Hy4 preview");
  });
});

describe("model router - explicit hygiene and pinning", () => {
  it("clears only blocks whose expiry has passed", async () => {
    const router = await makeRouter();
    await router.blockModel(IDS.hy4, isoAfterMs(-60_000), "old");
    await router.blockModel(IDS.hy3, isoAfterMs(60_000), "current");

    const cleared = await router.clearExpiredBlocks(NOW);
    expect(cleared).toBe(1);

    const snapshot = router.getSnapshot(NOW);
    expect(snapshot.models.find((m) => m.model.id === IDS.hy4)?.runtime.blockedUntil).toBeNull();
    expect(snapshot.models.find((m) => m.model.id === IDS.hy3)?.runtime.blockedUntil).toBe(
      isoAfterMs(60_000),
    );
  });

  it("M: a recovering higher-priority model does not steal the pinned turn", async () => {
    const router = await makeRouter();
    await router.blockModel(IDS.hy4, isoAfterMs(600_000), "quota exceeded");

    // Task starts while Hy4 is blocked, so Hy3 is chosen and pinned.
    const started = router.selectModel(NOW);
    expect(started.kind).toBe("selected");
    if (started.kind !== "selected") return;
    expect(started.model.label).toBe("Hy3");

    router.pin(started.model.id);
    expect(router.pinnedModelId()).toBe(IDS.hy3);

    // Mid-task Hy4's block is lifted externally.
    await router.clearBlock(IDS.hy4);

    const during = router.selectModel(NOW);
    expect(during.kind).toBe("selected");
    if (during.kind !== "selected") return;
    expect(during.model.label).toBe("Hy3");
    expect(during.pinned).toBe(true);

    // Next task: the recovered top model takes over again.
    router.releasePin();
    const next = router.selectModel(NOW);
    expect(next.kind).toBe("selected");
    if (next.kind !== "selected") return;
    expect(next.model.label).toBe("Hy4 preview");
    expect(next.pinned).toBe(false);
  });

  it("M2: an explicit pin wins over a usable higher-priority model", async () => {
    const router = await makeRouter();
    router.pin(IDS.glm);

    const selection = router.selectModel(NOW);
    expect(selection.kind).toBe("selected");
    if (selection.kind !== "selected") return;
    expect(selection.model.label).toBe("GLM-5.3-Flash");
    expect(selection.pinned).toBe(true);
  });
});

describe("model router - input validation", () => {
  it("K: unknown ids raise instead of silently polluting state", async () => {
    const router = await makeRouter();

    await expect(
      router.blockModel("does-not-exist", isoAfterMs(60_000), "x"),
    ).rejects.toThrow(/unknown model id/);
    await expect(router.clearBlock("does-not-exist")).rejects.toThrow(
      /unknown model id/,
    );
    await expect(router.setEnabled("does-not-exist", true)).rejects.toThrow(
      /unknown model id/,
    );
    expect(() => router.pin("does-not-exist")).toThrow(/unknown model id/);

    const persisted = (await readPersisted()) as {
      models: Record<string, unknown>;
    };
    expect(Object.keys(persisted.models)).toEqual([]);
  });

  it("rejects unparseable timestamps rather than guessing", async () => {
    const router = await makeRouter();
    await expect(router.blockModel(IDS.hy4, "tomorrow", "x")).rejects.toThrow(
      /invalid timestamp/,
    );
  });

  it("normalises a Date to canonical ISO", () => {
    expect(toIsoString(NOW)).toBe("2026-10-01T00:00:00.000Z");
    expect(toIsoString("2026-10-01T00:00:00.000Z")).toBe(
      "2026-10-01T00:00:00.000Z",
    );
  });
});

describe("model router - snapshot for future TUI and adapters", () => {
  it("exposes availability, reasons and the next reset time", async () => {
    const router = await makeRouter();
    await router.blockModel(IDS.hy4, isoAfterMs(600_000), "quota exceeded");
    await router.blockModel(IDS.hy3, isoAfterMs(900_000), "quota exceeded");

    const snapshot = router.getSnapshot(NOW);

    expect(snapshot.now).toBe(NOW.toISOString());
    expect(snapshot.pin).toBeNull();
    expect(snapshot.models).toHaveLength(4);
    expect(snapshot.models.map((m) => m.available)).toEqual([
      false,
      false,
      true,
      true,
    ]);
    expect(snapshot.nextResetAt).toBe(isoAfterMs(600_000));

    // The adapter still sees the exact WorkBuddy-facing label.
    const usable = snapshot.models.filter((m) => m.available);
    expect(usable[0]?.model.label).toBe("Deepseek-V4.1-Flash");
  });

  it("handles a model added later without touching selection code", async () => {
    const extended: ModelDefinition[] = [
      ...DEFAULT_MODELS,
      { id: "future-model", label: "Future Model", enabled: true },
    ];
    const router = await makeRouter(extended);
    for (const model of DEFAULT_MODELS) {
      await router.blockModel(model.id, isoAfterMs(60_000), "quota exceeded");
    }

    const selection = router.selectModel(NOW);
    expect(selection.kind).toBe("selected");
    if (selection.kind !== "selected") return;
    expect(selection.model.label).toBe("Future Model");
  });
});
