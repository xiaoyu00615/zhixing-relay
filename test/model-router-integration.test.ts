import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { AuditLog } from "../src/audit.js";
import type { BridgeServer } from "../src/bridge-server.js";
import {
  DEFAULT_MODELS,
  ModelRouter,
  ModelStateStore,
} from "../src/model-router/index.js";
import type { ModelDefinition } from "../src/model-router/index.js";
import { ZhixingRelay } from "../src/relay.js";
import { RelayStore } from "../src/store.js";
import type { ExtensionInbound, PendingItem } from "../src/types.js";
import type { WorkBuddyClient } from "../src/workbuddy.js";
import { WorkBuddyModelError } from "../src/workbuddy/model.js";
import { AVAILABLE_DETECTION, type QuotaDetection } from "../src/workbuddy/quota.js";

const IDS = {
  hy4: "hy4-preview",
  hy3: "hy3",
  deepseek: "deepseek-v4.1-flash",
  glm: "glm-5.3-flash",
} as const;

const NOW = new Date("2026-10-01T00:00:00.000Z");
const BLOCK_2H = new Date(NOW.getTime() + 7_200_000);
/** The reset instant WorkBuddy prints in its quota notice. */
const RESET_AT = new Date(NOW.getTime() + 7_200_000).toISOString();

function taskText(taskId: string, model?: string | null): string {
  const headers = [
    "[ZHIXING_RELAY]",
    "TYPE: TASK",
    `TASK_ID: ${taskId}`,
    "SOURCE: GPT",
  ];
  if (model) headers.push(`MODEL: ${model}`);

  return [...headers, "", "Run the gate."].join("\n");
}

/**
 * The operations this integration is about. Recording them in order is how
 * the tests prove the task text can never reach WorkBuddy before the routed
 * model is actually applied.
 */
/**
 * One traced operation, stamped with the dispatch that produced it.
 *
 * The stamp is what makes every assertion below scope-safe: an entry can only
 * ever satisfy a barrier belonging to the same dispatch, so a task can never
 * be declared "reached the wait" because an earlier task once did the same.
 */
type Call = {
  dispatchId: number;
  kind:
    | "router.selectModel"
    | "router.pin"
    | "workbuddy.getCurrentModel"
    | "workbuddy.selectModel"
    | "workbuddy.sendText"
    | "workbuddy.wait"
    | "workbuddy.detectQuota";
  label?: string;
};

/** Bookkeeping for exactly one dispatched task. */
type DispatchRecord = {
  id: number;
  calls: Call[];
  /** Resolvers belonging to THIS dispatch's wait, and nobody else's. */
  waitHooks: Array<() => void>;
  finished: Promise<void>;
};

type WaitOutcome =
  | { ok: true; text?: string }
  | { ok: false; error: string };

type Harness = {
  relay: ZhixingRelay;
  router: ModelRouter;
  store: RelayStore;
  calls: Call[];
  sentToChatGpt: string[];
  auditEvents: { event: string; payload: Record<string, unknown> }[];
  /** What the real WorkBuddy UI claims is currently selected. */
  currentModel: string;
  /** Injected failure for the WorkBuddy-side selector. */
  selectModelError: WorkBuddyModelError | null;
  /** Injected failure for handing the text to WorkBuddy. */
  sendTextError: string | null;
  /**
   * Quota verdict injected into the first turn that finishes. Cleared as soon
   * as it is consumed, so a retry always resolves on the second attempt -
   * otherwise a "quota exhausted" that never clears could never finish.
   */
  quotaExhausted: { modelLabel: string; resetAt: string | null } | null;
  /** How many times the relay probed WorkBuddy for quota. */
  quotaProbes: number;
  /** Makes the quota probe itself throw (CDP failure). */
  quotaProbeError: string | null;
  /** When set, the wait settles immediately instead of hanging. */
  waitOutcome: WaitOutcome | null;
  /** Makes every router.selectModel() throw, to simulate a broken store. */
  routerThrow: Error | null;
  /** False makes the relay hold its RESULT instead of forwarding it. */
  bridgeConnected: boolean;
  /** Runs a full turn to completion, optionally naming a model in the task. */
  sendTask: (taskId: string, model?: string | null) => Promise<void>;
  /** Returns once THIS turn reaches WorkBuddy but before the reply arrives. */
  startTask: (taskId: string, model?: string | null) => Promise<void>;
  /** Releases the hanging wait of `id` (default: the most recent dispatch). */
  settle: (id?: number) => Promise<void>;
  /** Identifiers of everything dispatched through this harness, in order. */
  dispatchIds: () => number[];
  /** Only the calls produced by `id`. */
  callsFor: (id: number) => Call[];
  /** How many wait resolvers `id` still owns. */
  waitHooksFor: (id: number) => number;
  /** Pushes an inbound bridge message of any shape straight to the relay. */
  raw: (message: unknown) => Promise<void>;
  /** Pushes a ChatGPT user message (a human paste, or the RESULT returning). */
  userMessage: (text: string, fingerprint?: string) => Promise<void>;
};

let sandboxRoot = "";
let seq = 0;

beforeAll(async () => {
  sandboxRoot = await mkdtemp(join(tmpdir(), "zxr-router-relay-"));
});

afterAll(async () => {
  // Removed once at the end: a late write from a settled wait must not race
  // against a directory that no longer exists.
  await rm(sandboxRoot, { recursive: true, force: true });
});

afterEach(async () => {
  // No global hook registry to drain any more: every wait resolver lives on
  // its own DispatchRecord, so a task that was left hanging dies with the
  // harness and cannot leak into the next test.
  await new Promise((resolve) => setTimeout(resolve, 0));
});

function fakeAudit(sink: { event: string; payload: Record<string, unknown> }[]): AuditLog {
  return {
    write: async (event: string, payload: Record<string, unknown> = {}) => {
      sink.push({ event, payload });
    },
  } as unknown as AuditLog;
}

async function makeHarness(
  models: readonly ModelDefinition[] = DEFAULT_MODELS,
  options: { blockAll?: boolean; resultLeaseMs?: number } = {},
): Promise<Harness> {
  seq += 1;
  const dir = join(sandboxRoot, `case-${seq}`);
  await mkdir(dir, { recursive: true });

  const store = new RelayStore(pathToFileURL(join(dir, "state.json")));
  await store.load();

  const router = new ModelRouter({
    models,
    store: new ModelStateStore(pathToFileURL(join(dir, "models.json"))),
  });
  await router.init();

  if (options.blockAll) {
    for (const model of DEFAULT_MODELS) {
      await router.blockModel(model.id, BLOCK_2H, "quota exhausted");
    }
  }

  const calls: Call[] = [];
  const records: DispatchRecord[] = [];
  const sentToChatGpt: string[] = [];
  const auditEvents: { event: string; payload: Record<string, unknown> }[] = [];

  /** The dispatch currently in flight, or 0 while nothing is dispatching. */
  let activeDispatchId = 0;
  let nextDispatchId = 0;
  /** Keeps every dispatched message a distinct fingerprint for the relay. */
  let fingerprintSeq = 0;
  let messageHandler: ((message: ExtensionInbound) => Promise<void>) | null = null;

  /**
   * Appends one traced operation to BOTH the global journal and the slice of
   * the dispatch that owns it. Nothing is recorded outside a dispatch, so a
   * stale entry from an earlier task is structurally impossible.
   */
  const record = (kind: Call["kind"], label?: string): void => {
    const entry: Call =
      label === undefined
        ? { dispatchId: activeDispatchId, kind }
        : { dispatchId: activeDispatchId, kind, label };

    calls.push(entry);
    records.find((r) => r.id === activeDispatchId)?.calls.push(entry);
  };

  const h = {
    store,
    calls,
    sentToChatGpt,
    auditEvents,
    currentModel: "Hy4 preview",
    selectModelError: null,
    sendTextError: null,
    waitOutcome: null,
    routerThrow: null,
    bridgeConnected: true,
    quotaExhausted: null,
    quotaProbes: 0,
    quotaProbeError: null,
  } as Harness;

  const bridge = {
    hasClient: () => h.bridgeConnected,
    onMessage: (handler: (message: ExtensionInbound) => Promise<void>) => {
      messageHandler = handler;
    },
    send: async (message: { text: string }) => {
      sentToChatGpt.push(message.text);
    },
    close: async () => {},
    start: async () => {},
  } as unknown as BridgeServer;

  const workbuddy = {
    init: async () => {},
    online: async () => true,
    getCurrentModel: async () => {
      record("workbuddy.getCurrentModel");
      return h.currentModel;
    },
    selectModel: async (label: string) => {
      record("workbuddy.selectModel", label);
      if (h.selectModelError) throw h.selectModelError;
      h.currentModel = label;
      return { changed: true, previous: null, current: label };
    },
    sendText: async () => {
      record("workbuddy.sendText");
      if (h.sendTextError) throw new Error(h.sendTextError);
      return "wb-1";
    },
    waitForAssistantReply: async () => {
      record("workbuddy.wait");

      if (h.waitOutcome) {
        if (!h.waitOutcome.ok) throw new Error(h.waitOutcome.error);
        return {
          text: h.waitOutcome.text ?? "RESULT BODY",
          lastMessageId: "wb-1",
          assistantMessages: [],
        };
      }

      // Hangs on purpose: several tests inspect state mid-turn. The resolver
      // is registered on THIS dispatch only, so settling one task cannot
      // finish another one that happens to be waiting.
      return new Promise((resolve) => {
        records
          .find((r) => r.id === activeDispatchId)
          ?.waitHooks.push(() =>
            resolve({
              text: h.waitOutcome?.ok ? (h.waitOutcome.text ?? "RESULT BODY") : "RESULT BODY",
              lastMessageId: "wb-1",
              assistantMessages: [],
            }),
          );
      });
    },
    detectQuota: async (): Promise<QuotaDetection> => {
      record("workbuddy.detectQuota");
      h.quotaProbes += 1;

      if (h.quotaProbeError) throw new Error(h.quotaProbeError);

      // One-shot: the first turn reports the limit, later turns are clean.
      const injected = h.quotaExhausted;
      h.quotaExhausted = null;

      if (!injected) return { ...AVAILABLE_DETECTION, modelLabel: h.currentModel };

      return {
        status: "quota_exhausted",
        modelLabel: injected.modelLabel,
        resetAt: injected.resetAt,
        reason: `当前您在${injected.modelLabel}模型的免费使用量已超过频率限制`,
        source: "turn",
      };
    },
  } as unknown as WorkBuddyClient;

  const config = {
    relay: {
      pauseOnManualUserMessage: false,
      gptForwardMode: "tagged",
      autoSendToChatGPT: true,
      ...(options.resultLeaseMs === undefined
        ? {}
        : { resultLeaseMs: options.resultLeaseMs }),
    },
    modelRouter: {
      quotaRetries: 2,
      quotaBlockMs: 3_600_000,
    },
  } as unknown as AppConfig;

  // Trace select/pin on the real router so the assertions observe the true
  // order rather than a reimplementation of it.
  const traced = new Proxy(router, {
    get(target, prop) {
      // NOTE: never `Reflect.get(target, prop, receiver)(...)` - that calls
      // the prototype method unbound, so `this` would be undefined inside it.
      if (prop === "selectModel") {
        return (now?: Date) => {
          if (h.routerThrow) throw h.routerThrow;
          record("router.selectModel");
          return target.selectModel(now);
        };
      }
      if (prop === "pin") {
        return (id?: string) => {
          const model = target.pin(id);
          if (model) record("router.pin", model.id);
          return model;
        };
      }
      return Reflect.get(target, prop);
    },
  });

  const relay = new ZhixingRelay(config, bridge, store, fakeAudit(auditEvents), workbuddy, traced);

  // Registers the bridge handler, so tests can push any inbound message.
  await relay.init();

  h.relay = relay;
  h.router = router;

  const dispatchTo = (
    taskId: string,
    model?: string | null,
  ): Promise<void> => {
    if (!messageHandler) throw new Error("bridge handler was never registered");
    /*
     * Unique per dispatch: the relay drops a message whose fingerprint it has
     * seen, so dispatching the same task twice (a retry) needs a fresh one.
     */
    fingerprintSeq += 1;
    return messageHandler({
      type: "chatgpt_assistant_message",
      text: taskText(taskId, model),
      fingerprint: `fp-${taskId}-${fingerprintSeq}`,
    });
  };

  /**
   * Dispatches one task inside a fresh dispatch scope.
   *
   * `barrier` resolves as soon as THIS dispatch records its own wait - never
   * by counting historical ones. `complete` waits for the whole turn.
   */
  const startDispatch = async (
    taskId: string,
    mode: "barrier" | "complete",
    model?: string | null,
  ): Promise<void> => {
    const record_: DispatchRecord = {
      id: nextDispatchId++,
      calls: [],
      waitHooks: [],
      finished: Promise.resolve(),
    };
    records.push(record_);
    activeDispatchId = record_.id;

    const restore = (): void => {
      activeDispatchId = 0;
    };
    const finished = dispatchTo(taskId, model).then(restore, (error: unknown) => {
      restore();
      throw error;
    });
    finished.catch(() => {});
    record_.finished = finished;

    if (mode === "complete") {
      await finished;
      return;
    }

    await Promise.race([
      finished,
      flushUntil(() =>
        record_.calls.some((call) => call.kind === "workbuddy.wait"),
      ),
    ]);
  };

  h.sendTask = async (taskId: string, model?: string | null) => {
    if (!messageHandler) await relay.init();
    await startDispatch(taskId, "complete", model);
  };

  h.startTask = async (taskId: string, model?: string | null) => {
    if (!messageHandler) await relay.init();
    await startDispatch(taskId, "barrier", model);
  };

  h.settle = async (id?: number) => {
    const target =
      id === undefined
        ? records[records.length - 1]
        : records.find((r) => r.id === id);

    if (!target) return;

    for (const hook of target.waitHooks.splice(0)) hook();
    await target.finished;
  };

  h.dispatchIds = () => records.map((r) => r.id);
  h.callsFor = (id: number) => records.find((r) => r.id === id)?.calls ?? [];
  h.waitHooksFor = (id: number) =>
    records.find((r) => r.id === id)?.waitHooks.length ?? 0;

  /** Feeds an inbound message of any shape, including ones the union omits. */
  h.raw = async (message: unknown): Promise<void> => {
    if (!messageHandler) throw new Error("bridge handler was never registered");
    await messageHandler(message as ExtensionInbound);
  };

  /** Feeds the ChatGPT thread as a human/user message. */
  h.userMessage = async (text: string, fingerprint = "fp-manual"): Promise<void> => {
    await h.raw({ type: "chatgpt_user_message", text, fingerprint });
  };

  return h;
}

function timeline(calls: Call[]): string[] {
  return calls.map((call) => {
    switch (call.kind) {
      case "router.pin":
        return `pin:${call.label}`;
      case "workbuddy.selectModel":
        return `setModel:${call.label}`;
      default:
        return call.kind.replace(/^(router|workbuddy)\./, "");
    }
  });
}

async function flushUntil(
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for the relay to reach the expected point");
}

/** Calls scoped to one dispatch, optionally pinned to a label. */
function hasCall(calls: readonly Call[], kind: Call["kind"], label?: string): boolean {
  return calls.some(
    (call) => call.kind === kind && (label === undefined || call.label === label),
  );
}

function kindsOf(calls: readonly Call[]): string[] {
  return calls.map((call) => call.kind);
}

/** The labels the UI was actually switched to, in order. */
function appliedLabels(calls: readonly Call[]): string[] {
  const labels: string[] = [];
  for (const call of calls) {
    if (call.kind === "workbuddy.selectModel" && call.label !== undefined) {
      labels.push(call.label);
    }
  }
  return labels;
}

/** The `model_routed` audit record the relay wrote for the turn. */
function modelRouted(
  auditEvents: { event: string; payload: Record<string, unknown> }[],
): Record<string, unknown> | undefined {
  return auditEvents.find((event) => event.event === "model_routed")?.payload;
}

describe("model router <> relay integration", () => {
  it("routes the default task to Hy4 preview", async () => {
    const h = await makeHarness();
    // Start elsewhere so a real switch is required, not a no-op.
    h.currentModel = "GLM-5.3-Flash";

    await h.startTask("t-default");

    expect(hasCall(h.calls, "workbuddy.selectModel", "Hy4 preview")).toBe(true);
    expect(h.router.pinnedModelId()).toBe(IDS.hy4);
    expect(h.store.snapshot().currentTask?.modelId).toBe(IDS.hy4);
  });

  it("selects, pins and applies the model before handing over any task text", async () => {
    const h = await makeHarness();
    h.currentModel = "GLM-5.3-Flash";

    await h.startTask("t-order");

    const trace = timeline(h.calls);
    const select = trace.indexOf("selectModel");
    const pin = trace.findIndex((entry) => entry.startsWith("pin:"));
    const readCurrent = trace.indexOf("getCurrentModel");
    const setModel = trace.findIndex((entry) => entry.startsWith("setModel:"));
    const send = trace.indexOf("sendText");
    const wait = trace.indexOf("wait");

    expect(select).toBeGreaterThanOrEqual(0);
    expect(pin).toBeGreaterThan(select);
    expect(readCurrent).toBeGreaterThan(pin);
    expect(setModel).toBeGreaterThan(readCurrent);
    expect(send).toBeGreaterThan(setModel);
    expect(wait).toBeGreaterThan(send);
  });

  it("does not touch the selector when WorkBuddy already shows the routed model", async () => {
    const h = await makeHarness();
    h.currentModel = "Hy4 preview";

    await h.startTask("t-noop");

    expect(h.calls.some((c) => c.kind === "workbuddy.selectModel")).toBe(false);
    expect(h.auditEvents.map((e) => e.event)).toContain("model_already_active");
    expect(h.calls.some((c) => c.kind === "workbuddy.sendText")).toBe(true);
  });

  it("does not send the TASK when WorkBuddy lacks the routed model", async () => {
    const h = await makeHarness();
    h.currentModel = "GLM-5.3-Flash";
    h.selectModelError = new WorkBuddyModelError(
      "MODEL_NOT_FOUND",
      'WorkBuddy has no model labelled "Hy4 preview"',
      ["Hy3"],
    );

    await h.sendTask("t-missing-model");

    expect(h.calls.some((c) => c.kind === "workbuddy.sendText")).toBe(false);
    expect(h.router.pinnedModelId()).toBeNull();
    expect(h.store.snapshot().currentTask).toBeNull();
  });

  it("does not send the TASK when the router itself fails, and keeps it queued", async () => {
    const h = await makeHarness();
    h.routerThrow = new Error("router store unreadable");

    await h.sendTask("t-router-broken");

    expect(h.calls.some((c) => c.kind === "workbuddy.sendText")).toBe(false);
    expect(h.calls.some((c) => c.kind === "workbuddy.selectModel")).toBe(false);
    expect(h.store.snapshot().currentTask).toBeNull();

    const queued = h.store.snapshot().pending as PendingItem[];
    expect(queued).toHaveLength(1);
    expect(queued[0]?.text ?? "").toContain("TASK_ID: t-router-broken");
  });

  it("releases the pin when WorkBuddy send fails", async () => {
    const h = await makeHarness();
    h.currentModel = "GLM-5.3-Flash";
    h.sendTextError = "WorkBuddy composer rejected the input";

    await h.sendTask("t-send-fail");

    expect(h.calls.some((c) => c.kind === "workbuddy.wait")).toBe(false);
    expect(h.router.pinnedModelId()).toBeNull();
    expect(h.store.snapshot().currentTask).toBeNull();
  });

  it("releases the pin when the WorkBuddy wait fails", async () => {
    const h = await makeHarness();
    h.currentModel = "GLM-5.3-Flash";
    h.waitOutcome = { ok: false, error: "WorkBuddy task cancelled" };

    await h.sendTask("t-wait-fail");

    expect(h.router.pinnedModelId()).toBeNull();
    expect(h.store.snapshot().currentTask).toBeNull();
  });

  it("releases the pin after a normal RESULT round trip", async () => {
    const h = await makeHarness();
    h.waitOutcome = { ok: true, text: "gate passed" };

    await h.sendTask("t-ok");

    expect(h.sentToChatGpt.some((text) => text.includes("TYPE: RESULT"))).toBe(true);
    expect(h.sentToChatGpt.some((text) => text.includes("gate passed"))).toBe(true);
    expect(h.router.pinnedModelId()).toBeNull();
  });

  it("keeps the pinned model when a higher-priority model recovers mid-task", async () => {
    const h = await makeHarness();
    h.currentModel = "GLM-5.3-Flash";
    await h.router.blockModel(IDS.hy4, BLOCK_2H, "quota exhausted");

    await h.startTask("t-pinned");

    expect(h.router.pinnedModelId()).toBe(IDS.hy3);
    expect(h.store.snapshot().currentTask?.modelId).toBe(IDS.hy3);
    expect(h.store.snapshot().currentTask?.modelLabel).toBe("Hy3");

    // Hy4 becomes usable again while this task is still running.
    await h.router.clearBlock(IDS.hy4);
    const selection = h.router.selectModel(NOW);
    expect(selection.kind === "selected" && selection.pinned).toBe(true);
    expect(selection.kind === "selected" && selection.model.id).toBe(IDS.hy3);

    const applied = h.calls
      .filter((c) => c.kind === "workbuddy.selectModel")
      .map((c) => c.label);

    expect(h.router.pinnedModelId()).toBe(IDS.hy3);
    expect(applied).toEqual(["Hy3"]);

    await h.settle();
  });

  it("lets the next task use the recovered high-priority model", async () => {
    const h = await makeHarness();
    h.currentModel = "GLM-5.3-Flash";
    await h.router.blockModel(IDS.hy4, BLOCK_2H, "quota exhausted");

    h.waitOutcome = { ok: true };
    await h.sendTask("t-first");
    const [first, second] = h.dispatchIds();
    expect(first).toBeDefined();
    expect(second).toBeUndefined();
    expect(hasCall(h.callsFor(first!), "workbuddy.selectModel", "Hy3")).toBe(true);

    await h.router.clearBlock(IDS.hy4);
    await h.startTask("t-second");
    const next = h.dispatchIds()[1];
    expect(next).toBeDefined();
    expect(hasCall(h.callsFor(next!), "workbuddy.selectModel", "Hy4 preview")).toBe(true);

    // The second turn's slice holds only its own operations.
    expect(h.callsFor(next!).every((call) => call.dispatchId === next)).toBe(true);
  });

  it("satisfies a later task's wait barrier from its own work, not the journal", async () => {
    const h = await makeHarness();
    h.currentModel = "GLM-5.3-Flash";

    // Task A runs to completion, leaving its wait as the last journal entry.
    // Any barrier that inspects the journal instead of the current dispatch
    // would be satisfied by that entry the instant task B starts.
    h.waitOutcome = { ok: true, text: "a-result" };
    await h.sendTask("t-a");

    const [a] = h.dispatchIds();
    const aCalls = h.callsFor(a!);
    expect(kindsOf(aCalls)).toContain("workbuddy.wait");
    // The quota probe runs after the wait, so the turn's last CORE call is
    // the wait; the dispatch scoping above proves nothing leaked either way.
    const coreTail = kindsOf(aCalls).filter(
      (kind) => kind !== "workbuddy.detectQuota",
    );
    expect(coreTail[coreTail.length - 1]).toBe("workbuddy.wait");
    expect(h.sentToChatGpt.some((text) => text.includes("a-result"))).toBe(true);

    // Task B now starts; its reply is left hanging on purpose.
    h.waitOutcome = null;
    await h.startTask("t-b");
    const b = h.dispatchIds()[1]!;
    const bCalls = h.callsFor(b);
    const sent = kindsOf(bCalls).indexOf("workbuddy.sendText");
    const waited = kindsOf(bCalls).indexOf("workbuddy.wait");

    expect(sent).toBeGreaterThanOrEqual(0);
    expect(waited).toBeGreaterThan(sent); // B reached its OWN wait, in order
    expect(bCalls.every((call) => call.dispatchId === b)).toBe(true);
    expect(h.callsFor(a!).every((call) => call.dispatchId === a)).toBe(true);

    h.waitOutcome = { ok: true, text: "b-result" };
    await h.settle(b);
    expect(h.sentToChatGpt.some((text) => text.includes("b-result"))).toBe(true);
  });

  it("keeps a pending wait owned by its own dispatch when another task starts", async () => {
    const h = await makeHarness();
    h.currentModel = "GLM-5.3-Flash";

    // ---- Task A reaches its wait and is left hanging on purpose ----
    await h.startTask("t-a");
    const [a] = h.dispatchIds();
    expect(kindsOf(h.callsFor(a!))).toContain("workbuddy.wait");
    expect(h.waitHooksFor(a!)).toBe(1);

    // A's round is abandoned, so the store accepts task B while A's wait is
    // still pending - the exact shape that used to let one task's wait
    // release another's.
    await h.store.mutate((state) => {
      state.currentTask = null;
      state.state = "IDLE";
    });

    await h.startTask("t-b");
    const b = h.dispatchIds()[1]!;
    expect(kindsOf(h.callsFor(b))).toContain("workbuddy.sendText");
    expect(kindsOf(h.callsFor(b))).toContain("workbuddy.wait");
    expect(h.callsFor(b).every((call) => call.dispatchId === b)).toBe(true);
    expect(h.router.pinnedModelId()).toBe(IDS.hy4);

    // Settling A must release A's resolver only: B is still waiting.
    expect(h.waitHooksFor(b)).toBe(1);
    await h.settle(a!);
    expect(h.waitHooksFor(b)).toBe(1);

    h.waitOutcome = { ok: true, text: "b-result" };
    await h.settle(b);
    expect(h.sentToChatGpt.some((text) => text.includes("b-result"))).toBe(true);
  });

  it("keeps the TASK queued and reports nextResetAt when every model is blocked", async () => {
    const h = await makeHarness(DEFAULT_MODELS, { blockAll: true });

    await h.sendTask("t-all-blocked");

    expect(h.calls.some((c) => c.kind === "workbuddy.sendText")).toBe(false);
    expect(h.calls.some((c) => c.kind === "workbuddy.selectModel")).toBe(false);
    expect(h.store.snapshot().currentTask).toBeNull();

    const queued = h.store.snapshot().pending as PendingItem[];
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: "gpt_task" });
    expect(queued[0]?.text ?? "").toContain("TASK_ID: t-all-blocked");

    const event = h.auditEvents.find((e) => e.event === "model_no_available");
    expect(event).toBeTruthy();
    expect(event?.payload.nextResetAt).toBe(BLOCK_2H.toISOString());
    expect(event?.payload.reasons).toHaveLength(DEFAULT_MODELS.length);
  });

  it("re-pins from currentTask.modelId when a resumed wait follows a restart", async () => {
    const h = await makeHarness();
    h.currentModel = "GLM-5.3-Flash";
    await h.router.blockModel(IDS.hy4, BLOCK_2H, "quota exhausted");

    await h.startTask("t-recover");
    expect(h.store.snapshot().currentTask?.modelId).toBe(IDS.hy3);

    // Simulate a process restart reading the same durable state.
    const freshRouter = new ModelRouter({
      models: DEFAULT_MODELS,
      store: new ModelStateStore(
        pathToFileURL(join(sandboxRoot, `case-${seq}`, "models.json")),
      ),
    });
    await freshRouter.init();

    const freshRelay = new ZhixingRelay(
      {
        relay: {
          pauseOnManualUserMessage: false,
          gptForwardMode: "tagged",
          autoSendToChatGPT: true,
        },
      } as unknown as AppConfig,
      {
        hasClient: () => true,
        onMessage: () => {},
        send: async () => {},
        close: async () => {},
      } as unknown as BridgeServer,
      h.store,
      fakeAudit([]),
      {
        init: async () => {},
        online: async () => true,
        getCurrentModel: async () => "Hy3",
        selectModel: async () => ({ changed: false, previous: "Hy3", current: "Hy3" }),
        sendText: async () => "wb-1",
        waitForAssistantReply: () => new Promise(() => {}),
      } as unknown as WorkBuddyClient,
      freshRouter,
    );

    await freshRelay.init();
    expect(h.store.snapshot().paused).toBe(true);

    await freshRelay.resume();

    expect(freshRouter.pinnedModelId()).toBe(IDS.hy3);
  });

  it("posts exactly one RESULT when the recovered wait is clean", async () => {
    const h = await makeHarness();
    h.currentModel = "Hy4 preview";

    await h.startTask("t-recovered-clean");

    // A second relay reading the same durable state, after a restart.
    const freshRouter = new ModelRouter({
      models: DEFAULT_MODELS,
      store: new ModelStateStore(
        pathToFileURL(join(sandboxRoot, `case-${seq}`, "models.json")),
      ),
    });
    await freshRouter.init();

    /** Everything the recovered turn typed into WorkBuddy. */
    const sent: string[] = [];

    const freshRelay = new ZhixingRelay(
      {
        relay: {
          pauseOnManualUserMessage: false,
          gptForwardMode: "tagged",
          autoSendToChatGPT: true,
        },
      } as unknown as AppConfig,
      {
        hasClient: () => true,
        onMessage: () => {},
        // The RESULT the recovered turn forwards has to be observable here.
        send: async (message: { text: string }) => {
          h.sentToChatGpt.push(message.text);
        },
        close: async () => {},
      } as unknown as BridgeServer,
      h.store,
      fakeAudit(h.auditEvents),
      {
        init: async () => {},
        online: async () => true,
        getCurrentModel: async () => "Hy4 preview",
        selectModel: async () => ({
          changed: false,
          previous: "Hy4 preview",
          current: "Hy4 preview",
        }),
        sendText: async (text: string) => {
          sent.push(text);
          return "wb-1";
        },
        // Answers at once, the way an already-finished round would.
        waitForAssistantReply: async () => ({
          text: "RESULT BODY",
          lastMessageId: "wb-1",
          assistantMessages: [],
        }),
        detectQuota: async () => ({ ...AVAILABLE_DETECTION, modelLabel: "Hy4 preview" }),
      } as unknown as WorkBuddyClient,
      freshRouter,
    );

    await freshRelay.init();
    // resume() releases the recovered wait without awaiting it.
    await freshRelay.resume();
    /*
     * Releasing the pin is the `finally` of the whole recovered turn, so it
     * only lands once the turn - and every result it forwards - is done.
     * Sampling the forwarded text any earlier would race against the send.
     */
    await flushUntil(() => freshRouter.pinnedModelId() === null);

    // The recovered turn waits for the message that was already sent: typing
    // the task again would make WorkBuddy answer the request twice.
    expect(sent).toHaveLength(0);

    // The loop waited for the already-sent message; waiting again here would
    // deliver the same RESULT to ChatGPT twice.
    expect(
      h.sentToChatGpt.filter((text) => text.includes("RESULT BODY")),
    ).toHaveLength(1);
  });

  it("re-sends a recovered task on the next model after the answer reports quota", async () => {
    const h = await makeHarness();
    h.currentModel = "Hy4 preview";

    await h.startTask("t-recovered-quota");

    const freshRouter = new ModelRouter({
      models: DEFAULT_MODELS,
      store: new ModelStateStore(
        pathToFileURL(join(sandboxRoot, `case-${seq}`, "models.json")),
      ),
    });
    await freshRouter.init();

    /* Waits hang until the test releases them, so the retry can be observed. */
    const pendingWaits: Array<() => void> = [];
    /** Everything typed into WorkBuddy by the recovered relay. */
    const sent: string[] = [];
    const answer = (): {
      text: string;
      lastMessageId: string;
      assistantMessages: [];
    } => ({ text: "RESULT BODY", lastMessageId: "wb-2", assistantMessages: [] });

    const freshRelay = new ZhixingRelay(
      {
        relay: {
          pauseOnManualUserMessage: false,
          gptForwardMode: "tagged",
          autoSendToChatGPT: true,
        },
      } as unknown as AppConfig,
      {
        hasClient: () => true,
        onMessage: () => {},
        // The RESULT the recovered turn forwards has to be observable here.
        send: async (message: { text: string }) => {
          h.sentToChatGpt.push(message.text);
        },
        close: async () => {},
      } as unknown as BridgeServer,
      h.store,
      fakeAudit(h.auditEvents),
      {
        init: async () => {},
        online: async () => true,
        getCurrentModel: async () => "Hy4 preview",
        selectModel: async (label: string) => {
          h.currentModel = label;
          return { changed: true, previous: "Hy4 preview", current: label };
        },
        sendText: async (text: string) => {
          sent.push(text);
          return "wb-2";
        },
        waitForAssistantReply: () =>
          new Promise((resolve) => {
            pendingWaits.push(() => resolve(answer()));
          }),
        // Exhausted once - exactly like the one-shot probe in the main harness.
        detectQuota: async (): Promise<QuotaDetection> => {
          const injected = h.quotaExhausted;
          h.quotaExhausted = null;
          return injected
            ? {
                status: "quota_exhausted",
                modelLabel: injected.modelLabel,
                resetAt: injected.resetAt,
                reason: "quota exhausted",
                source: "turn",
              }
            : { ...AVAILABLE_DETECTION, modelLabel: h.currentModel };
        },
      } as unknown as WorkBuddyClient,
      freshRouter,
    );

    await freshRelay.init();
    // resume() releases the recovered wait fire-and-forget.
    await freshRelay.resume();
    await flushUntil(() => pendingWaits.length === 1);

    expect(pendingWaits).toHaveLength(1);
    expect(h.store.snapshot().currentTask?.modelId).toBe(IDS.hy4);
    // Waiting only: the recovered turn must not type the task a second time.
    expect(sent).toHaveLength(0);

    // The recovered answer arrives on the model the task was using.
    h.quotaExhausted = { modelLabel: "Hy4 preview", resetAt: RESET_AT };
    pendingWaits[0]?.();
    await flushUntil(() => pendingWaits.length > 1);

    const blocked = h.auditEvents.find((e) => e.event === "model_quota_blocked");
    expect(blocked).toMatchObject({
      event: "model_quota_blocked",
      payload: { modelId: IDS.hy4, retry: 1 },
    });

    // The retry re-sends the SAME task text, once, on the next usable model.
    expect(sent).toEqual([taskText("t-recovered-quota")]);

    // The task went back out, on the next usable model, under its own id.
    const lastRouted = [...h.auditEvents]
      .reverse()
      .find((event) => event.event === "model_routed")?.payload;
    expect(lastRouted).toMatchObject({
      modelId: IDS.hy3,
      retried: true,
      retry: 1,
      previousModelId: IDS.hy4,
    });

    expect(h.store.snapshot().currentTask?.taskId).toBe("t-recovered-quota");

    pendingWaits[1]?.();
    await flushUntil(() =>
      h.sentToChatGpt.some((text) => text.includes("RESULT BODY")),
    );

    // One RESULT for the whole recovered turn, never two.
    expect(
      h.sentToChatGpt.filter((text) => text.includes("RESULT BODY")),
    ).toHaveLength(1);

    // The claim on the model ends with the turn, not with the send.
    await flushUntil(() => freshRouter.pinnedModelId() === null);
    expect(freshRouter.pinnedModelId()).toBeNull();
    expect(h.store.snapshot().pending).toHaveLength(0);
  });

  it("runs a task that names its model on that model, never on Hy4", async () => {
    const h = await makeHarness();
    h.currentModel = "Hy4 preview";
    h.waitOutcome = { ok: true };

    await h.sendTask("t-named-hy3", IDS.hy3);

    const routed = modelRouted(h.auditEvents);
    expect(routed).toMatchObject({
      requestedModelId: IDS.hy3,
      modelId: IDS.hy3,
      source: "requested",
      fellBack: false,
    });

    // Hy4 preview is first in the catalog and was free, so landing on it here
    // would mean the request was simply ignored.
    expect(appliedLabels(h.calls)).toEqual(["Hy3"]);

    expect(h.sentToChatGpt.some((text) => text.includes("RESULT BODY"))).toBe(
      true,
    );
    expect(h.router.pinnedModelId()).toBeNull();
  });

  it("falls back when the named model cannot run, and still sends", async () => {
    const h = await makeHarness();
    await h.router.blockModel(IDS.hy4, BLOCK_2H, "quota exhausted");
    h.currentModel = "Hy4 preview";
    h.waitOutcome = { ok: true };

    await h.sendTask("t-named-fallback", IDS.hy4);

    const routed = modelRouted(h.auditEvents);
    expect(routed).toMatchObject({
      requestedModelId: IDS.hy4,
      modelId: IDS.hy3,
      source: "requested",
      fellBack: true,
    });

    // The task text reached WorkBuddy on the fallback model: refusing here
    // would drop work that a perfectly usable model could take.
    expect(appliedLabels(h.calls)).toEqual(["Hy3"]);
    expect(h.calls.some((call) => call.kind === "workbuddy.sendText")).toBe(
      true,
    );
    expect(h.router.pinnedModelId()).toBeNull();
  });

  it("falls back to Hy3 and re-sends when Hy4 reports quota exhausted", async () => {
    const h = await makeHarness();
    h.currentModel = "Hy4 preview";
    h.waitOutcome = { ok: true, text: "hy4 refuses: quota" };
    h.quotaExhausted = { modelLabel: "Hy4 preview", resetAt: RESET_AT };

    await h.sendTask("t-quota");

    // The task moved to Hy3 and was really handed over again.
    expect(appliedLabels(h.calls)).toEqual(["Hy3"]);
    expect(hasCall(h.calls, "workbuddy.sendText")).toBe(true);
    expect(h.quotaProbes).toBe(2); // once per attempt

    // Hy4 was blocked with the reset instant the notice carried.
    const blocked = h.auditEvents.find((e) => e.event === "model_quota_blocked");
    expect(blocked?.payload).toMatchObject({
      taskId: "t-quota",
      modelId: IDS.hy4,
      blockedUntil: RESET_AT,
    });

    // The RESULT travelled for the finished task, on the fallback model.
    expect(h.sentToChatGpt.some((text) => text.includes("hy4 refuses: quota"))).toBe(
      true,
    );
    expect(h.sentToChatGpt.filter((t) => t.includes("TYPE: RESULT"))).toHaveLength(1);
    expect(h.router.pinnedModelId()).toBeNull();
  });

  it("keeps the TASK_ID and the task identity across a quota retry", async () => {
    const h = await makeHarness();
    h.currentModel = "Hy4 preview";
    h.waitOutcome = { ok: true, text: "attempt 1" };
    h.quotaExhausted = { modelLabel: "Hy4 preview", resetAt: RESET_AT };

    await h.sendTask("t-quota-same-id");

    const routedEvents = h.auditEvents.filter(
      (e) => e.event === "model_routed" && e.payload.retried === true,
    );
    expect(routedEvents).toHaveLength(1);
    expect(
      h.auditEvents.every((e) =>
        "taskId" in e.payload ? e.payload.taskId === "t-quota-same-id" : true,
      ),
    ).toBe(true);

    // No duplicate task was queued: the task finished on the fallback model.
    const pending = h.store.snapshot().pending as PendingItem[];
    expect(pending).toHaveLength(0);

    /*
     * The round is closed the moment its RESULT reaches ChatGPT, even after a
     * retry, so the identity of the task is carried by the forwarded text and
     * the audit trail - not by a task record nobody is waiting for any more.
     */
    expect(h.store.snapshot().currentTask).toBeNull();
    expect(h.store.snapshot().state).toBe("IDLE");
    const forwarded = h.sentToChatGpt.find((text) => text.includes("attempt 1"));
    expect(forwarded).toContain("TASK_ID: t-quota-same-id");
  });

  it("pins the fallback model for the retry and releases it at the end", async () => {
    const h = await makeHarness();
    h.currentModel = "Hy4 preview";
    h.waitOutcome = { ok: true, text: "retry body" };
    h.quotaExhausted = { modelLabel: "Hy4 preview", resetAt: RESET_AT };

    await h.sendTask("t-quota-pin");

    // The first pin is dropped when the model is blocked, the second covers
    // the retry; nothing is left pinned once the round is over.
    const pins = h.calls
      .filter((c) => c.kind === "router.pin" && c.label !== undefined)
      .map((c) => c.label);
    expect(pins).toEqual([IDS.hy4, IDS.hy3]);
    expect(h.router.pinnedModelId()).toBeNull();
  });

  it("stores the reset time as the moment the model becomes usable again", async () => {
    const h = await makeHarness();
    h.currentModel = "Hy4 preview";
    h.waitOutcome = { ok: true, text: "body" };
    h.quotaExhausted = { modelLabel: "Hy4 preview", resetAt: RESET_AT };

    await h.sendTask("t-quota-reset");

    // A moment before the reset the model is still held.
    const justBefore = h.router
      .getSnapshot(new Date(Date.parse(RESET_AT) - 1000))
      .models.find((entry) => entry.model.id === IDS.hy4);
    expect(justBefore?.runtime.blockedUntil).toBe(RESET_AT);
    expect(justBefore?.unavailableKind).toBe("blocked");
    expect(justBefore?.available).toBe(false);

    // At the reset instant the block no longer holds.
    const atReset = h.router
      .getSnapshot(new Date(RESET_AT))
      .models.find((entry) => entry.model.id === IDS.hy4);
    expect(atReset?.available).toBe(true);
  });

  it("lets the blocked model back in once its reset instant has passed", async () => {
    const h = await makeHarness();
    h.currentModel = "Hy4 preview";
    h.waitOutcome = { ok: true, text: "body" };
    h.quotaExhausted = { modelLabel: "Hy4 preview", resetAt: RESET_AT };

    await h.sendTask("t-quota-expiry");

    // One second before the reset: still blocked.
    const before = h.router.selectModel({
      now: new Date(Date.parse(RESET_AT) - 1000),
    });
    expect(before.kind === "selected" && before.model.id).toBe(IDS.hy3);

    // At the reset instant the block no longer holds, so Hy4 wins again.
    const after = h.router.selectModel({ now: new Date(RESET_AT) });
    expect(after.kind === "selected" && after.model.id).toBe(IDS.hy4);
  });

  it("stops the task and keeps it queued when every fallback is exhausted", async () => {
    const h = await makeHarness();
    for (const id of [IDS.hy3, IDS.deepseek, IDS.glm]) {
      await h.router.blockModel(id, BLOCK_2H, "quota exhausted");
    }

    h.currentModel = "Hy4 preview";
    h.waitOutcome = { ok: true, text: "quota body" };
    h.quotaExhausted = { modelLabel: "Hy4 preview", resetAt: RESET_AT };

    await h.sendTask("t-quota-nowhere");

    // Used up to the retry limit and then refused: never sent a second time.
    expect(hasCall(h.calls, "workbuddy.sendText")).toBe(true);
    expect(
      h.calls.filter((c) => c.kind === "workbuddy.wait"),
    ).toHaveLength(1);
    expect(h.sentToChatGpt.some((text) => text.includes("TYPE: RESULT"))).toBe(false);

    // The stale currentTask is gone, so the re-queued task is not hidden
    // behind its own in-flight record.
    expect(h.store.snapshot().currentTask).toBeNull();

    const queued = h.store.snapshot().pending as PendingItem[];
    expect(queued).toHaveLength(1);
    expect(queued[0]?.text ?? "").toContain("TASK_ID: t-quota-nowhere");

    const event = h.auditEvents.find((e) => e.event === "model_no_available");
    expect(event?.payload.nextResetAt).toBe(RESET_AT);
    expect(h.router.pinnedModelId()).toBeNull();
  });

  it("does not retry when the quota probe itself fails", async () => {
    const h = await makeHarness();
    h.currentModel = "Hy4 preview";
    h.waitOutcome = { ok: true, text: "probe failed" };
    h.quotaProbeError = "CDP connection closed";

    await h.sendTask("t-quota-probe-failed");

    // An unreadable page is not a quota: a usable model must not be blocked.
    expect(h.quotaProbes).toBe(1);
    expect(
      h.auditEvents.some((e) => e.event === "workbuddy_quota_probe_failed"),
    ).toBe(true);
    expect(h.router.getSnapshot().models.find((m) => m.model.id === IDS.hy4)?.available).toBe(
      true,
    );
    expect(h.sentToChatGpt.some((text) => text.includes("probe failed"))).toBe(true);
  });

  it("releases the task the moment the RESULT reaches ChatGPT", async () => {
    const h = await makeHarness();
    h.waitOutcome = { ok: true, text: "gate passed" };

    // An answer waiting behind the round that is about to finish.
    await h.store.enqueue({
      kind: "workbuddy_result",
      id: "pending-wb-early",
      taskId: "t-earlier",
      text: "queued answer",
      workbuddyMessageId: "wb-earlier",
      createdAt: new Date().toISOString(),
    });

    await h.sendTask("t-release");

    // The RESULT went out exactly once.
    expect(h.sentToChatGpt.filter((text) => text.includes("gate passed"))).toHaveLength(1);

    // ...and with it the task record nobody is waiting for any more.
    expect(h.store.snapshot().currentTask).toBeNull();
    expect(h.store.snapshot().state).toBe("IDLE");
    expect(
      h.auditEvents.some(
        (e) =>
          e.event === "round_completed" &&
          e.payload.taskId === "t-release" &&
          e.payload.reason === "result_delivered",
      ),
    ).toBe(true);

    // A released round is an idle relay, so the queue moved on.
    expect(h.store.snapshot().pending).toHaveLength(0);
    expect(h.sentToChatGpt.some((text) => text.includes("queued answer"))).toBe(true);
  });

  it("holds the RESULT when the bridge is down, then releases it on lease expiry", async () => {
    const h = await makeHarness(DEFAULT_MODELS, { resultLeaseMs: 20 });
    h.waitOutcome = { ok: true, text: "held answer" };

    // Nothing can confirm the delivery, so the lease has to.
    h.bridgeConnected = false;
    await h.sendTask("t-lease");

    await flushUntil(() =>
      h.auditEvents.some((e) => e.event === "result_lease_expired"),
    );

    expect(h.store.snapshot().currentTask).toBeNull();
    expect(
      h.auditEvents.some(
        (e) =>
          e.event === "round_completed" &&
          e.payload.reason === "result_lease_expired",
      ),
    ).toBe(true);

    /*
     * The lease released the record, not the work. The release wakes the
     * queue, which puts the RESULT back where it waits for the bridge.
     */
    await flushUntil(() =>
      (h.store.snapshot().pending as PendingItem[]).some((item) =>
        (item.text ?? "").includes("held answer"),
      ),
    );

    const queued = h.store.snapshot().pending as PendingItem[];
    expect(queued).toHaveLength(1);
    expect(queued[0]?.text).toContain("held answer");
    expect(h.sentToChatGpt).toHaveLength(0);
  });

  it("releases a stale WAIT_GPT record as soon as traffic arrives", async () => {
    const h = await makeHarness();
    h.waitOutcome = { ok: true, text: "stale answer" };

    // The shape a restart reads: a RESULT delivered long ago, still holding.
    await h.store.mutate((state) => {
      const sentAt = new Date(Date.now() - 600_000).toISOString();
      state.currentTask = {
        taskId: "t-stale",
        sourceFingerprint: "fp-stale",
        sourceText: "Run the gate.",
        startedAt: sentAt,
        status: "sent_to_gpt",
        sentToGptAt: sentAt,
      };
      state.state = "WAIT_GPT";
    });

    await h.raw({ type: "chatgpt_page_ready", title: "stale page" });

    expect(h.auditEvents.some((e) => e.event === "result_lease_expired")).toBe(true);
    expect(h.store.snapshot().currentTask).toBeNull();
  });

  it("never lets the queue start work while a task record exists", async () => {
    const h = await makeHarness();

    await h.store.enqueue({
      kind: "gpt_task",
      id: "p-blocked",
      text: taskText("t-blocked"),
      fingerprint: "fp-blocked",
      createdAt: new Date().toISOString(),
    });

    // A round that delivered its RESULT but still holds its record.
    await h.store.mutate((state) => {
      state.currentTask = {
        taskId: "t-holding",
        sourceFingerprint: "fp-holding",
        sourceText: "Run the gate.",
        startedAt: new Date().toISOString(),
        status: "sent_to_gpt",
        sentToGptAt: new Date().toISOString(),
      };
      state.state = "WAIT_GPT";
    });

    await h.relay.resume();

    expect(
      (h.store.snapshot().pending as PendingItem[]).map((item) => item.id),
    ).toEqual(["p-blocked"]);
    expect(h.calls.some((call) => call.kind === "workbuddy.sendText")).toBe(false);

    // A round whose answer WorkBuddy is still producing is blocked for the
    // same reason, so the queue stays untouched there too.
    await h.store.mutate((state) => {
      state.currentTask = {
        taskId: "t-working",
        sourceFingerprint: "fp-working",
        sourceText: "Run the gate.",
        startedAt: new Date().toISOString(),
        status: "waiting_workbuddy",
      };
      state.state = "WAIT_WORKBUDDY";
    });

    await h.relay.resume();

    expect(
      (h.store.snapshot().pending as PendingItem[]).map((item) => item.id),
    ).toEqual(["p-blocked"]);
    expect(h.calls.some((call) => call.kind === "workbuddy.sendText")).toBe(false);
  });

  it("puts a cancelled task back in the queue instead of losing it", async () => {
    const h = await makeHarness();
    h.waitOutcome = { ok: false, error: "WorkBuddy task cancelled" };

    await h.sendTask("t-cancelled");

    const queued = h.store.snapshot().pending as PendingItem[];
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      kind: "gpt_task",
      taskId: "t-cancelled",
      retryCount: 1,
      reason: "WorkBuddy task cancelled",
    });
    expect(queued[0]?.text ?? "").toContain("TASK_ID: t-cancelled");

    expect(h.sentToChatGpt.some((text) => text.includes("TYPE: RESULT"))).toBe(false);
    expect(h.auditEvents.some((e) => e.event === "task_requeued")).toBe(true);
    expect(h.router.pinnedModelId()).toBeNull();
  });

  it("stops requeuing a task WorkBuddy always refuses", async () => {
    const h = await makeHarness();
    h.waitOutcome = { ok: false, error: "WorkBuddy task cancelled" };

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await h.sendTask("t-persistent");
    }

    const queued = h.store.snapshot().pending as PendingItem[];
    // Three requeues were allowed; the fourth attempt was refused.
    expect(queued).toHaveLength(3);
    expect(queued[2]).toMatchObject({ taskId: "t-persistent", retryCount: 3 });
    expect(
      h.auditEvents.filter((e) => e.event === "task_requeued"),
    ).toHaveLength(3);
    expect(h.auditEvents.some((e) => e.event === "task_retry_exhausted")).toBe(true);
    expect(h.sentToChatGpt.some((text) => text.includes("TYPE: RESULT"))).toBe(false);
  });

  it("treats a RESULT pasted into ChatGPT as the completion signal", async () => {
    const h = await makeHarness();

    await h.startTask("t-pasted");
    expect(h.store.snapshot().currentTask?.taskId).toBe("t-pasted");

    // A RESULT belonging to another round must not close this one.
    await h.userMessage(
      [
        "[ZHIXING_RELAY]",
        "TYPE: RESULT",
        "TASK_ID: t-other",
        "SOURCE: GPT",
        "",
        "not this task",
      ].join("\n"),
    );

    expect(h.store.snapshot().currentTask?.taskId).toBe("t-pasted");

    await h.userMessage(
      [
        "[ZHIXING_RELAY]",
        "TYPE: RESULT",
        "TASK_ID: t-pasted",
        "SOURCE: GPT",
        "",
        "done by hand",
      ].join("\n"),
    );

    expect(h.auditEvents.some((e) => e.event === "result_observed_in_chatgpt")).toBe(
      true,
    );
    expect(h.store.snapshot().currentTask).toBeNull();
    expect(h.store.snapshot().state).toBe("IDLE");

    // The paste is Relay's own output arriving, not a new request: it neither
    // forwarded a RESULT nor handed the task to WorkBuddy a second time.
    expect(h.sentToChatGpt).toHaveLength(0);
    expect(
      h.calls.filter((call) => call.kind === "workbuddy.sendText"),
    ).toHaveLength(1);
  });

  it("degrades to priority routing when the named model is unknown", async () => {
    const h = await makeHarness();
    h.currentModel = "Hy3";
    h.waitOutcome = { ok: true };

    await h.sendTask("t-named-unknown", "hy5-preview");

    const routed = modelRouted(h.auditEvents);
    expect(routed).toMatchObject({
      requestedModelId: "hy5-preview",
      modelId: IDS.hy4,
      source: "priority",
      fellBack: false,
    });

    expect(appliedLabels(h.calls)).toEqual(["Hy4 preview"]);
    expect(h.calls.some((call) => call.kind === "workbuddy.sendText")).toBe(
      true,
    );
    expect(h.router.pinnedModelId()).toBeNull();
  });
});
