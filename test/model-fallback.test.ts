import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_MODELS,
  ModelRouter,
  ModelStateStore,
  fallbackOrder,
  parseFallbackMap,
  resolveModelId,
  selectModel,
} from "../src/model-router/index.js";
import type { ModelRuntimeState } from "../src/model-router/index.js";
import { parseRelayEnvelope } from "../src/protocol.js";

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

/** Runtime state where the listed ids are blocked until `ms` from NOW. */
function runtimeWith(blockedIds: readonly string[], ms = 7_200_000): Record<string, ModelRuntimeState> {
  const runtime: Record<string, ModelRuntimeState> = {};
  for (const id of blockedIds) {
    runtime[id] = { blockedUntil: isoAfterMs(ms), reason: "quota exhausted" };
  }
  return runtime;
}

let sandboxDir = "";
let seq = 0;

beforeAll(async () => {
  sandboxDir = await mkdtemp(join(tmpdir(), "zxr-model-fallback-"));
});

afterAll(async () => {
  await rm(sandboxDir, { recursive: true, force: true });
});

async function makeRouter(
  options: { fallbacks?: Record<string, string[]> | undefined } = {},
): Promise<ModelRouter> {
  seq += 1;
  const router = new ModelRouter({
    models: DEFAULT_MODELS,
    fallbacks: options.fallbacks ?? {},
    store: new ModelStateStore(pathToFileURL(join(sandboxDir, `fb-${seq}.json`))),
  });
  await router.init();
  return router;
}

describe("task protocol - MODEL constraint", () => {
  it("parses a MODEL header without disturbing the other fields", () => {
    const text = [
      "[ZHIXING_RELAY]",
      "TYPE: TASK",
      "TASK_ID: R21-1",
      "SOURCE: GPT",
      "MODEL: hy3",
      "",
      "Run the gate.",
    ].join("\n");

    expect(parseRelayEnvelope(text)).toMatchObject({
      taskId: "R21-1",
      type: "TASK",
      source: "GPT",
      model: "hy3",
    });
  });

  it("leaves model null when the task names none", () => {
    const text = [
      "[ZHIXING_RELAY]",
      "TYPE: TASK",
      "TASK_ID: R21-2",
      "SOURCE: GPT",
      "",
      "Run the gate.",
    ].join("\n");

    expect(parseRelayEnvelope(text)?.model).toBeNull();
  });
});

describe("fallback configuration", () => {
  it("parses the MODEL_FALLBACKS grammar", () => {
    expect(
      parseFallbackMap("hy4-preview:hy3,deepseek-v4.1-flash|hy3:glm-5.3-flash"),
    ).toEqual({
      "hy4-preview": [IDS.hy3, IDS.deepseek],
      hy3: [IDS.glm],
    });
  });

  it("returns an empty map for unset or junk input", () => {
    expect(parseFallbackMap("")).toEqual({});
    expect(parseFallbackMap(null)).toEqual({});
    expect(parseFallbackMap("no-colon-here")).toEqual({});
    expect(parseFallbackMap("|:|")).toEqual({});
  });

  it("drops a chain entry that looks like the start of another pair", () => {
    expect(parseFallbackMap("also:bad,:empty")).toEqual({
      also: ["bad"],
    });
  });

  it("skips unknown ids and never offers the requested model back", () => {
    const order = fallbackOrder(DEFAULT_MODELS, IDS.hy4, {
      "hy4-preview": [IDS.hy4, "not-a-model", IDS.hy3],
    });

    expect(order).toEqual([IDS.hy3, IDS.deepseek, IDS.glm]);
    expect(order).not.toContain(IDS.hy4);
  });
});

describe("requested model resolution", () => {
  it("matches an id before a label", () => {
    expect(resolveModelId(DEFAULT_MODELS, IDS.hy3)).toBe(IDS.hy3);
    expect(resolveModelId(DEFAULT_MODELS, "Hy3")).toBe(IDS.hy3);
  });

  it("returns null for an unknown or empty request", () => {
    expect(resolveModelId(DEFAULT_MODELS, "hy5-preview")).toBeNull();
    expect(resolveModelId(DEFAULT_MODELS, "  ")).toBeNull();
  });
});

describe("selection - a task names its model", () => {
  it("runs the requested model even though a higher-priority one is free", () => {
    const selection = selectModel({
      models: DEFAULT_MODELS,
      runtime: {},
      now: NOW,
      requestedModelId: IDS.hy3,
    });

    expect(selection.kind).toBe("selected");
    if (selection.kind !== "selected") return;
    expect(selection.model.id).toBe(IDS.hy3);
    expect(selection.source).toBe("requested");
    expect(selection.fellBack).toBe(false);
    expect(selection.requestedModelId).toBe(IDS.hy3);
  });

  it("says so when the requested model could not be used", () => {
    const selection = selectModel({
      models: DEFAULT_MODELS,
      runtime: runtimeWith([IDS.hy3]),
      now: NOW,
      requestedModelId: IDS.hy3,
    });

    // Hy4 preview is perfectly usable, so the task still runs - but the
    // result must never claim the request was honoured.
    expect(selection.kind).toBe("selected");
    if (selection.kind !== "selected") return;
    expect(selection.model.id).toBe(IDS.hy4);
    expect(selection.fellBack).toBe(true);
    expect(selection.source).toBe("requested");
    expect(selection.requestedModelId).toBe(IDS.hy3);
  });

  it("lets the configured chain reach past a catalog model", () => {
    // Both the request and the catalog's next choice are blocked, so the
    // catalog order alone has to land on Deepseek.
    const runtime = runtimeWith([IDS.hy3, IDS.hy4]);
    const plain = selectModel({
      models: DEFAULT_MODELS,
      runtime,
      now: NOW,
      requestedModelId: IDS.hy4,
    });
    expect(plain.kind === "selected" && plain.model.id).toBe(IDS.deepseek);

    // The same request with an explicit chain names GLM first, and the chain
    // wins even though Deepseek sits further up the catalog.
    const chained = selectModel({
      models: DEFAULT_MODELS,
      runtime,
      now: NOW,
      requestedModelId: IDS.hy4,
      fallbacks: { "hy4-preview": [IDS.glm] },
    });

    expect(chained.kind).toBe("selected");
    if (chained.kind !== "selected") return;
    expect(chained.model.id).toBe(IDS.glm);
    expect(chained.fellBack).toBe(true);
  });

  it("ignores a request for a model that is not in the catalog", () => {
    const selection = selectModel({
      models: DEFAULT_MODELS,
      runtime: {},
      now: NOW,
      requestedModelId: "hy5-preview",
    });

    expect(selection.kind).toBe("selected");
    if (selection.kind !== "selected") return;
    expect(selection.model.id).toBe(IDS.hy4);
    expect(selection.source).toBe("priority");
    expect(selection.fellBack).toBe(false);
  });

  it("keeps the task alive by falling back rather than raising no_available_model", () => {
    // Everything the task could accept is exhausted; only the fallback list is
    // still Alive - here it is not, so the task must be reported honestly.
    const selection = selectModel({
      models: DEFAULT_MODELS,
      runtime: runtimeWith([IDS.hy4, IDS.hy3, IDS.deepseek, IDS.glm]),
      now: NOW,
      requestedModelId: IDS.hy4,
    });

    expect(selection.kind).toBe("no_available_model");
    if (selection.kind !== "no_available_model") return;
    expect(selection.nextResetAt).toBe(isoAfterMs(7_200_000));
    expect(selection.reasons.map((reason) => reason.modelId)).toContain(IDS.hy4);
  });
});

describe("selection - reserved user-preference layer", () => {
  it("outranks plain priority but never a task's own request", async () => {
    const router = await makeRouter();

    router.setUserPreference(IDS.hy3);
    expect(router.userPreferenceId()).toBe(IDS.hy3);

    const respected = router.selectModel({ now: NOW });
    expect(respected.kind === "selected" && respected.model.id).toBe(IDS.hy3);

    const overtaken = router.selectModel({ now: NOW, requestedModelId: IDS.glm });
    expect(
      overtaken.kind === "selected" && overtaken.model.id === IDS.glm,
    ).toBe(true);
  });

  it("is skipped when the preferred model is unavailable", () => {
    const selection = selectModel({
      models: DEFAULT_MODELS,
      runtime: runtimeWith([IDS.hy3]),
      now: NOW,
      userPreferenceId: IDS.hy3,
    });

    expect(selection.kind).toBe("selected");
    if (selection.kind !== "selected") return;
    expect(selection.model.id).toBe(IDS.hy4);
    expect(selection.source).toBe("priority");
  });

  it("is memory-only, so a fresh router falls back to priority", async () => {
    const first = await makeRouter();
    first.setUserPreference(IDS.hy3);

    const second = await makeRouter();
    expect(second.userPreferenceId()).toBeNull();
    expect(second.selectModel({ now: NOW }).kind === "selected").toBe(true);
  });

  it("rejects an unknown preference instead of silently storing it", async () => {
    const router = await makeRouter();
    expect(() => router.setUserPreference("hy5-preview")).toThrow(
      /unknown model id/,
    );
  });
});

describe("selection - the pin still protects a running turn", () => {
  it("answers a request with the pinned model", () => {
    const selection = selectModel({
      models: DEFAULT_MODELS,
      runtime: {},
      now: NOW,
      requestedModelId: IDS.glm,
      pin: IDS.hy3,
    });

    expect(selection.kind).toBe("selected");
    if (selection.kind !== "selected") return;
    expect(selection.model.id).toBe(IDS.hy3);
    expect(selection.pinned).toBe(true);
    expect(selection.source).toBe("pin");
  });
});

describe("router facade with a task request", () => {
  it("pins the model the fallback landed on and releases it again", async () => {
    const router = await makeRouter();
    await router.blockModel(IDS.hy4, isoAfterMs(600_000), "quota exceeded");
    await router.blockModel(IDS.hy3, isoAfterMs(600_000), "quota exceeded");

    const selection = router.selectModel({
      requestedModelId: IDS.hy3,
      now: NOW,
    });

    expect(selection.kind).toBe("selected");
    if (selection.kind !== "selected") return;
    expect(selection.model.id).toBe(IDS.deepseek);
    expect(selection.fellBack).toBe(true);

    expect(router.pin(selection.model.id)?.id).toBe(IDS.deepseek);
    expect(router.pinnedModelId()).toBe(IDS.deepseek);

    // The pin outranks every later request, including one naming Hy3 again.
    const during = router.selectModel({ requestedModelId: IDS.hy4, now: NOW });
    expect(during.kind === "selected" && during.model.id).toBe(IDS.deepseek);

    router.releasePin();
    expect(router.pinnedModelId()).toBeNull();
  });

  it("keeps selectModel(now) working unchanged", async () => {
    const router = await makeRouter();
    const selection = router.selectModel(NOW);

    expect(selection.kind).toBe("selected");
    if (selection.kind !== "selected") return;
    expect(selection.model.id).toBe(IDS.hy4);
    expect(selection.source).toBe("priority");
    expect(selection.fellBack).toBe(false);
  });

  it("routes a blocked-by-quota request through the explicit chain", async () => {
    const router = await makeRouter({
      fallbacks: { "hy4-preview": [IDS.glm, IDS.deepseek] },
    });
    await router.blockModel(IDS.hy4, isoAfterMs(600_000), "quota exceeded");
    // Hy3 would be next in the catalog; the chain must skip straight to GLM.
    await router.blockModel(IDS.hy3, isoAfterMs(600_000), "quota exceeded");

    const selection = router.selectModel({
      requestedModelId: IDS.hy4,
      now: NOW,
    });

    expect(selection.kind).toBe("selected");
    if (selection.kind !== "selected") return;
    // hy3 is ahead of GLM in the catalog but the chain is explicit.
    expect(selection.model.id).toBe(IDS.glm);
    expect(selection.fellBack).toBe(true);
  });
});
