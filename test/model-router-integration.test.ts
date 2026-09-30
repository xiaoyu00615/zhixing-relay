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

const IDS = {
  hy4: "hy4-preview",
  hy3: "hy3",
  deepseek: "deepseek-v4.1-flash",
  glm: "glm-5.3-flash",
} as const;

const NOW = new Date("2026-10-01T00:00:00.000Z");
const BLOCK_2H = new Date(NOW.getTime() + 7_200_000);

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
    | "workbuddy.wait";
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
  /** When set, the wait settles immediately instead of hanging. */
  waitOutcome: WaitOutcome | null;
  /** Makes every router.selectModel() throw, to simulate a broken store. */
  routerThrow: Error | null;
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
  options: { blockAll?: boolean } = {},
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
  } as Harness;

  const bridge = {
    hasClient: () => true,
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
  } as unknown as WorkBuddyClient;

  const config = {
    relay: {
      pauseOnManualUserMessage: false,
      gptForwardMode: "tagged",
      autoSendToChatGPT: true,
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

  h.relay = relay;
  h.router = router;

  const dispatchTo = (
    taskId: string,
    model?: string | null,
  ): Promise<void> => {
    if (!messageHandler) throw new Error("bridge handler was never registered");
    return messageHandler({
      type: "chatgpt_assistant_message",
      text: taskText(taskId, model),
      fingerprint: `fp-${taskId}`,
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
    expect(kindsOf(aCalls)[aCalls.length - 1]).toBe("workbuddy.wait");
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
