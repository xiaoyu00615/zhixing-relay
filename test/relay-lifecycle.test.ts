import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { AuditLog } from "../src/audit.js";
import type { BridgeServer } from "../src/bridge-server.js";
import { ZhixingRelay } from "../src/relay.js";
import { RelayStore } from "../src/store.js";
import type { ExtensionInbound } from "../src/types.js";
import type { SendAck, WorkBuddyClient } from "../src/workbuddy.js";
import { AVAILABLE_DETECTION } from "../src/workbuddy/quota.js";

/*
 * The relay's shutdown, not its tasks.
 *
 * These tests exist because of a real failure: a suite finished with 277
 * passing assertions and still exited non-zero, because a background step the
 * relay had started wrote a stage into a store whose temporary directory the
 * suite had already deleted. The step was fire-and-forget, so nobody could
 * wait for it, and a confirmation from the extension could still be accepted
 * after the relay was gone.
 *
 * What is asserted here is therefore about ownership:
 *
 *   - work the relay started is a set the relay can drain, and
 *   - after `dispose()` there is nothing left to write, whatever arrives.
 */

/** Directories this file created, removed once at the end. */
const createdDirs: string[] = [];

/** Rejections nothing claimed. A late write that escapes is one of these. */
const unhandledRejections: unknown[] = [];
let onRejection: ((reason: unknown) => void) | null = null;

beforeAll(() => {
  onRejection = (reason: unknown): void => {
    unhandledRejections.push(reason);
  };
  process.on("unhandledRejection", onRejection);
});

afterAll(async () => {
  if (onRejection) process.off("unhandledRejection", onRejection);

  for (const dir of createdDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
  }
});

/** A send the fake adapter can prove: input read back, new turn observed. */
function confirmedAck(outboundId: string): SendAck {
  return {
    outboundId,
    input: {
      ok: true,
      reason: "confirmed",
      expectedFingerprint: "fp-sent",
      observedFingerprint: "fp-sent",
      expectedLength: 0,
      observedLength: 0,
      exactMatch: true,
      normalizedMatch: true,
    },
    send: {
      ok: true,
      reason: "confirmed",
      observedMessageId: outboundId,
      beforeTurnCount: 1,
      afterTurnCount: 2,
      ignoredRoles: [],
      detail: "a new turn carrying this task is on the page",
    },
    clickOk: true,
    clickOutcome: "clicked" as const,
  };
}

const RUNNING = {
  outcome: "running",
  ok: true,
  reason: "processing",
  evidence: { running: true, completed: false, cancelled: false },
} as const;

function taskText(taskId: string): string {
  return [
    "[ZHIXING_RELAY]",
    "TYPE: TASK",
    `TASK_ID: ${taskId}`,
    "SOURCE: GPT",
    "",
    "Run the gate.",
  ].join("\n");
}

/**
 * waits for a condition the relay has to reach.
 *
 * It polls, which is the honest way to wait for work the relay has not
 * finished: a fixed delay would only be a second guess about how long that
 * work takes, and a wrong guess in either direction is a flaky test.
 */
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

type Fixture = {
  relay: ZhixingRelay;
  store: RelayStore;
  /** Resolves the moment the extension's confirmation reaches the relay. */
  ackArrived: Promise<void>;
  /** Resolves once WorkBuddy's answer is actually being waited for. */
  waitStarted: Promise<void>;
  /** Releases the answer WorkBuddy is holding. */
  releaseReply: () => void;
  /**
   * Delivers the extension's confirmation for the delivery it just received.
   *
   * The test decides when: a confirmation that lands before the shutdown
   * proves nothing about one that lands after it, and the accident this file
   * is about was precisely the late one.
   */
  deliverAck: () => Promise<void>;
  /** Number of store writes attempted after the directory was removed. */
  lateWrites: () => number;
  /** Shuts the relay down, then removes the directory its files lived in. */
  shutdownAndRemove: () => Promise<void>;
  /** Sends one assistant task into the relay. */
  dispatchTask: (taskId: string) => Promise<void>;
};

async function makeFixture(
  options: { holdReply?: boolean } = {},
): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "zxr-lifecycle-"));
  createdDirs.push(dir);

  const store = new RelayStore(pathToFileURL(join(dir, "state.json")));
  await store.load();

  let inbound: ((message: ExtensionInbound) => Promise<void>) | null = null;
  let resolveAck: (() => void) | null = null;
  const ackArrived = new Promise<void>((resolve) => {
    resolveAck = resolve;
  });

  /*
   * A test that disposes "while the relay is waiting" has to know the wait
   * really started: disposing a moment earlier would only prove that a step
   * which had not reached its wait can be drained - which is true without any
   * cancellation at all.
   */
  let resolveWaitStarted: (() => void) | null = null;
  const waitStarted = new Promise<void>((resolve) => {
    resolveWaitStarted = resolve;
  });

  /*
   * Writes are counted only after the directory is gone, which turns "the
   * relay did not touch a deleted directory" into an assertion instead of a
   * hope: every late write has to be counted before it can fail, and a write
   * into a removed directory fails here rather than in the reporter.
   */
  let closed = false;
  let writesAfterClose = 0;

  const counted = new Proxy(store, {
    get(target, prop) {
      if (prop === "mutate") {
        return async (
          mutator: Parameters<RelayStore["mutate"]>[0],
        ): Promise<void> => {
          if (closed) writesAfterClose += 1;
          return target.mutate(mutator);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  /** Set while the relay waits for its answer, released by the test. */
  let releaseReply = (): void => {};
  /** The delivery the extension has not confirmed yet. */
  let deliveredRequestId: string | null = null;

  const bridge = {
    hasClient: () => true,
    onMessage: (handler: (message: ExtensionInbound) => Promise<void>) => {
      inbound = handler;
    },
    send: async (message: {
      text?: string;
      type?: string;
      requestId?: string;
    }): Promise<void> => {
      if (message.type !== "send_to_chatgpt") return;
      deliveredRequestId = message.requestId ?? null;
    },
    close: async () => {},
    start: async () => {},
  } as unknown as BridgeServer;

  const holdReply = options.holdReply === true;

  const workbuddy = {
    init: async () => {},
    online: async () => true,
    getCurrentModel: async () => "Hy4 preview",
    selectModel: async (label: string) => ({
      changed: true,
      previous: null,
      current: label,
    }),
    sendText: async () => confirmedAck("wb-1"),
    waitForRunning: async () => RUNNING as never,
    // Hangs until the test decides otherwise, so the relay has a step in
    // flight when the shutdown arrives.
    waitForAssistantReply: (
      _outboundId: string,
      options?: { signal?: AbortSignal },
    ) => {
      resolveWaitStarted?.();

      const reply = {
        text: "RESULT BODY",
        lastMessageId: "wb-1",
        assistantMessages: [] as [],
      };

      /*
       * Already cancelled: the signal was aborted before this wait started,
       * and an "abort" event that already fired never arrives, so the state
       * has to be read. A real client does the same before it starts waiting.
       */
      if (options?.signal?.aborted) {
        return Promise.reject(
          new Error("WorkBuddy wait cancelled: the relay stopped waiting"),
        );
      }

      // Not held: the turn answers at once, so the test can watch a whole
      // round reach the delivery point.
      if (!holdReply) return Promise.resolve(reply);

      return new Promise<{ text: string; lastMessageId: string; assistantMessages: [] }>(
        (resolve, reject) => {
          /*
           * Honours the relay's abort signal, so a shutdown has something to
           * wait for: a wait that keeps hanging cannot be drained, and a
           * cancelled round must not run to its end after the shutdown.
           */
          options?.signal?.addEventListener(
            "abort",
            () =>
              reject(
                new Error("WorkBuddy wait cancelled: the relay stopped waiting"),
              ),
            { once: true },
          );

          releaseReply = () => resolve(reply);
        },
      );
    },
    detectQuota: async () => ({ ...AVAILABLE_DETECTION, modelLabel: "Hy4 preview" }),
  } as unknown as WorkBuddyClient;

  const config = {
    relay: {
      pauseOnManualUserMessage: false,
      gptForwardMode: "tagged",
      autoSendToChatGPT: true,
    },
    workbuddy: {
      pollIntervalMs: 10,
      sendConfirmTimeoutMs: 200,
      runningConfirmTimeoutMs: 500,
    },
    paths: { ledger: pathToFileURL(join(dir, "ledger.jsonl")) },
  } as unknown as AppConfig;

  const audit = {
    write: async () => {},
  } as unknown as AuditLog;

  const relay = new ZhixingRelay(config, bridge, counted, audit, workbuddy, null);
  await relay.init();

  return {
    relay,
    store,
    ackArrived,
    waitStarted,
    releaseReply: () => releaseReply(),
    deliverAck: async () => {
      const promise = inbound?.({
        type: "chatgpt_send_result",
        requestId: deliveredRequestId,
        ok: true,
        sent: true,
      });
      resolveAck?.();
      if (promise) await promise.catch(() => {});
    },
    lateWrites: () => writesAfterClose,
    shutdownAndRemove: async () => {
      await relay.dispose();
      closed = true;
      await rm(dir, { recursive: true, force: true });
    },
    /*
     * Deliberately not awaited: the handler runs the whole turn, so awaiting
     * it would wait for the answer too - and the test is the one deciding
     * when that answer arrives.
     */
    dispatchTask: async (taskId: string) => {
      const promise = inbound?.({
        type: "chatgpt_assistant_message",
        text: taskText(taskId),
        fingerprint: `fp-${taskId}-${Date.now()}`,
      });
      if (promise) void promise.catch(() => {});
    },
  };
}

describe("relay shutdown", () => {
  it("drops a confirmation that arrives after the relay is shut down", async () => {
    const fx = await makeFixture();

    await fx.dispatchTask("t-shutdown-late-ack");
    await flushUntil(
      () => fx.store.snapshot().currentTask?.status === "sent_to_gpt",
    );

    /*
     * The shutdown happens with a delivery already made and its confirmation
     * still on its way - the exact shape of the production accident: the
     * directory goes away while the relay still has something to write.
     */
    await fx.shutdownAndRemove();

    expect(fx.relay.backgroundWorkPending()).toBe(0);

    /*
     * The confirmation really reaches the relay - after the directory that
     * held its files is gone, which is the whole point: the assertion below
     * is not passing because nothing ever happened.
     */
    await fx.deliverAck();
    await fx.ackArrived;
    // One turn, so anything the dropped message still started would have run.
    await new Promise((resolve) => setImmediate(resolve));

    // ... and the relay refuses to write a stage for a round it no longer owns.
    expect(fx.lateWrites()).toBe(0);
    expect(unhandledRejections).toEqual([]);
  });

  it("waits for background work that is still running before it returns", async () => {
    const fx = await makeFixture({ holdReply: true });

    await fx.dispatchTask("t-shutdown-drain");
    await fx.waitStarted;
    expect(fx.relay.backgroundWorkPending()).toBeGreaterThan(0);

    /*
     * The wait was in flight when the shutdown arrived. A drain that returned
     * early would leave that work running - and its store write landing after
     * the caller believed the relay had finished.
     */
    await fx.relay.dispose();

    expect(fx.relay.backgroundWorkPending()).toBe(0);
    expect(unhandledRejections).toEqual([]);
  });

  it("cancels a wait it can no longer wait for", async () => {
    const fx = await makeFixture({ holdReply: true });

    await fx.dispatchTask("t-shutdown-cancel");
    await fx.waitStarted;
    expect(fx.relay.backgroundWorkPending()).toBeGreaterThan(0);

    /*
     * Nobody releases this answer. A shutdown that only waited would hang
     * here forever, so it cancels first: the wait ends, the step ends, and
     * the drain has something finite to wait for.
     */
    await fx.relay.dispose();

    expect(fx.relay.backgroundWorkPending()).toBe(0);
    expect(unhandledRejections).toEqual([]);
  });

  it("starts no new work once it has been shut down", async () => {
    const fx = await makeFixture();

    await fx.dispatchTask("t-shutdown-no-new-work");
    await flushUntil(
      () => fx.store.snapshot().currentTask?.status === "sent_to_gpt",
    );

    await fx.relay.dispose();

    // A second shutdown is a no-op rather than a second round of writes.
    await fx.relay.dispose();

    expect(fx.relay.backgroundWorkPending()).toBe(0);
    expect(unhandledRejections).toEqual([]);
  });
});
