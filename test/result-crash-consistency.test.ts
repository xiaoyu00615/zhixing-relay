/**
 * v0.4.7.3k: result delivery crash consistency.
 *
 * The fifteen cases below are the crash windows the architecture audit named
 * P0-A (persist) and P0-B (delivery). Every one of them is exercised against
 * the REAL durable state and the REAL relay - the "crash" is a real process
 * boundary: the test seeds the state file exactly as it would sit on disk
 * after a crash, builds a second relay on that same state (a restart), and
 * then drives the recovery the way a pm2 restart would. Nothing here is a
 * fixture of a state that cannot happen; the seeds are the durable records the
 * code itself would have written at the moment it died.
 *
 * The one invariant every case protects: the same WorkBuddy answer, watched
 * across any crash or restart, must never become two logical results in
 * ChatGPT, and the relay must never ask WorkBuddy to run the task again to get
 * it there.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { AuditLog } from "../src/audit.js";
import type { BridgeServer } from "../src/bridge-server.js";
import type { WorkBuddyClient } from "../src/workbuddy.js";
import {
  deliveryIdFor,
  planRecovery,
  ResultDeliveryLedger,
  type RecoverableTask,
  type RecoveryPlan,
} from "../src/delivery/recovery.js";
import * as recovery from "../src/delivery/recovery.js";
import { ResultIdentityContradiction, ResultPipeline } from "../src/delivery/result-pipeline.js";
import { ZhixingRelay } from "../src/relay.js";
import { RelayStore } from "../src/store.js";
import type { ExtensionInbound, PendingItem } from "../src/types.js";

const RESULT_BODY = "the gate passed";

function taskBlock(taskId: string): string {
  return [
    "[ZHIXING_RELAY]",
    "TYPE: TASK",
    `TASK_ID: ${taskId}`,
    "SOURCE: GPT",
    "",
    "Run the gate.",
  ].join("\n");
}

function resultBlock(taskId: string, body: string): string {
  return [
    "[ZHIXING_RELAY]",
    "TYPE: RESULT",
    `TASK_ID: ${taskId}`,
    "SOURCE: WORKBUDDY",
    "",
    body,
  ].join("\n");
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function flushUntil(
  predicate: () => boolean,
  timeoutMs = 3000,
  label = "the relay to reach the expected point",
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

let sandboxRoot = "";
let seq = 0;

beforeAll(async () => {
  sandboxRoot = await mkdtemp(join(tmpdir(), "zxr-crash-"));
});

afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  await rm(sandboxRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
}, 60_000);

function fakeAudit(): AuditLog {
  const sink: { event: string; payload: Record<string, unknown> }[] = [];
  const audit = {
    write: async (event: string, payload: Record<string, unknown> = {}) => {
      sink.push({ event, payload });
    },
    events: sink,
  } as unknown as AuditLog & { events: typeof sink };
  return audit;
}

/** Records every bridge send, keyed by the stable delivery id. */
type BridgeCapture = {
  sent: { type?: string; text?: string; requestId?: string; deliveryId?: string }[];
  lastDeliveryId: string | null;
  handler: ((message: ExtensionInbound) => Promise<void>) | null;
};

function makeBridge(autoAck: boolean, capture: BridgeCapture): BridgeServer {
  return {
    hasClient: () => true,
    onMessage: (handler: (message: ExtensionInbound) => Promise<void>) => {
      capture.handler = handler;
    },
    send: async (message: { type?: string; text?: string; requestId?: string; deliveryId?: string }) => {
      capture.sent.push(message);
      if (message.type === "send_to_chatgpt" && message.deliveryId) {
        capture.lastDeliveryId = message.deliveryId;
      }
      if (message.type === "send_to_chatgpt" && autoAck) {
        setTimeout(() => {
          void capture.handler?.({
            type: "chatgpt_send_result",
            requestId: message.requestId ?? null,
            ok: true,
            sent: true,
          });
        }, 0);
      }
    },
    close: async () => {},
  } as unknown as BridgeServer;
}

type FakeWorkbuddy = {
  sentToWorkBuddy: string[];
  resolver: ((text: string) => void) | null;
};

function makeWorkbuddy(share: FakeWorkbuddy): WorkBuddyClient {
  return {
    init: async () => {},
    online: async () => true,
    getCurrentModel: async () => null,
    selectModel: async () => ({ changed: false, previous: null, current: "Hy3" }),
    detectQuota: async () => ({ status: "available", modelLabel: "Hy3" }),
    sendText: async (text: string) => {
      share.sentToWorkBuddy.push(text);
      return {
        outboundId: "wb-1",
        input: { ok: true },
        send: { ok: true, reason: "ok", observedMessageId: "wb-1", beforeTurnCount: 0, afterTurnCount: 1, detail: "ok" },
        clickOk: true,
      };
    },
    waitForRunning: async () => ({ outcome: "running", ok: true, evidence: { running: true, completed: false, cancelled: false } }),
    waitForAssistantReply: () =>
      new Promise((resolve) => {
        share.resolver = (text: string) =>
          resolve({ text, lastMessageId: "wb-1", assistantMessages: [] });
      }),
  } as unknown as WorkBuddyClient;
}

type Harness = {
  relay: ZhixingRelay;
  store: RelayStore;
  audit: AuditLog & { events: { event: string; payload: Record<string, unknown> }[] };
  sentToWorkBuddy: string[];
  capture: BridgeCapture;
  /** Seed the durable outbox (the persist crash window's survivor). */
  seedOutbox: (taskId: string, body: string, workbuddyMessageId?: string) => Promise<void>;
  /** Seed the live currentTask exactly as a crash would leave it. */
  seedTask: (taskId: string, partial: Record<string, unknown>) => Promise<void>;
  /** Push any extension-inbound message straight to the live relay. */
  push: (message: unknown) => Promise<void>;
  /** Drive one task end to end up to RESULT_RECEIVED (real pipeline). */
  startTask: (taskId: string) => Promise<void>;
  /** Hand the hanging answer to the relay. */
  answerWith: (text: string) => void;
  waiting: () => boolean;
  /** How many times the answer was delivered to ChatGPT (by delivery id). */
  resultDeliveries: () => { text: string; deliveryId: string | undefined }[];
  /** A fresh relay on the SAME durable state: a restart. */
  restart: (autoAck?: boolean) => Promise<Replay>;
};

type Replay = {
  relay: ZhixingRelay;
  sentToWorkBuddy: string[];
  capture: BridgeCapture;
  push: (message: unknown) => Promise<void>;
  resultDeliveries: () => { text: string; deliveryId: string | undefined }[];
  stop: () => Promise<void>;
};

const liveRelays: ZhixingRelay[] = [];

afterEach(async () => {
  for (const relay of liveRelays) {
    await relay.stopCurrentRound("the case ended");
  }
  liveRelays.length = 0;
});

async function makeHarness(autoAck = false): Promise<Harness> {
  seq += 1;
  const dir = join(sandboxRoot, `case-${seq}`);
  const store = new RelayStore(pathToFileURL(join(dir, "state.json")));
  await store.load();

  const audit = fakeAudit() as AuditLog & { events: { event: string; payload: Record<string, unknown> }[] };
  const capture: BridgeCapture = { sent: [], lastDeliveryId: null, handler: null };
  const sentToWorkBuddy: string[] = [];
  const wb: FakeWorkbuddy = { sentToWorkBuddy, resolver: null };

  const config = {
    relay: {
      pauseOnManualUserMessage: false,
      gptForwardMode: "tagged",
      autoSendToChatGPT: true,
      sendConfirmTimeoutMs: 100,
      runningConfirmTimeoutMs: 200,
      resultLeaseMs: 5_000,
    },
    workbuddy: { pollIntervalMs: 10 },
    paths: { ledger: pathToFileURL(join(dir, "ledger.jsonl")) },
  } as unknown as AppConfig;

  const relay = new ZhixingRelay(config, makeBridge(autoAck, capture), store, audit, makeWorkbuddy(wb), null);
  await relay.init();
  liveRelays.push(relay);

  const h = {
    relay,
    store,
    audit,
    sentToWorkBuddy,
    capture,
  } as Harness;

  h.seedOutbox = async (taskId: string, body: string, workbuddyMessageId = "wb-1") => {
    await store.enqueue({
      kind: "workbuddy_result",
      id: `pending-wb-${taskId}`,
      taskId,
      text: resultBlock(taskId, body),
      workbuddyMessageId,
      createdAt: new Date().toISOString(),
    } as PendingItem);
  };

  h.seedTask = async (taskId: string, partial: Record<string, unknown>) => {
    await store.mutate((state) => {
      state.currentTask = {
        taskId,
        sourceFingerprint: `fp-${taskId}`,
        sourceText: taskBlock(taskId),
        startedAt: new Date().toISOString(),
        status: "waiting_workbuddy",
        ...partial,
      } as never;
      state.state = partial.status === "sent_to_gpt" ? "WAIT_GPT" : "WAIT_WORKBUDDY";
    });
  };

  h.push = async (message: unknown) => {
    if (!capture.handler) throw new Error("bridge handler not registered");
    await capture.handler(message as ExtensionInbound);
  };

  h.startTask = async (taskId: string) => {
    const dispatch = h.push({ type: "chatgpt_assistant_message", text: taskBlock(taskId), fingerprint: `fp-${taskId}` });
    await Promise.race([dispatch, flushUntil(() => sentToWorkBuddy.includes(taskBlock(taskId)), 3000, "payload to reach WorkBuddy")]);
  };

  h.answerWith = (text: string) => wb.resolver?.(text);
  h.waiting = () => wb.resolver !== null;

  h.resultDeliveries = () =>
    capture.sent
      .filter((m) => m.type === "send_to_chatgpt" && typeof m.text === "string" && (m.text as string).includes("TYPE: RESULT"))
      .map((m) => ({ text: m.text as string, deliveryId: m.deliveryId }));

  h.restart = async (replayAutoAck = false): Promise<Replay> => {
    // The original live relay must not keep running against the shared store:
    // its background poll would race the restart's recovery and clear
    // currentTask between the delivery's stage write and its status write.
    // `dispose()` is the non-destructive shutdown: it sets the `disposed`
    // flag (so noteStage / handleExtensionMessage drop late writes), cancels
    // armed waits and clears the lease, but it leaves currentTask and the
    // durable outbox intact for the fresh relay to recover. `stopCurrentRound`
    // must NOT be used here: it nulls currentTask and wipes the outbox, which
    // would leave the restart with nothing to recover.
    await relay.dispose();

    const freshCapture: BridgeCapture = { sent: [], lastDeliveryId: null, handler: null };
    const freshSent: string[] = [];
    const freshWb: FakeWorkbuddy = { sentToWorkBuddy: freshSent, resolver: null };

    const freshRelay = new ZhixingRelay(
      config,
      makeBridge(replayAutoAck, freshCapture),
      store,
      fakeAudit() as AuditLog & { events: { event: string; payload: Record<string, unknown> }[] },
      makeWorkbuddy(freshWb),
      null,
    );
    await freshRelay.init();
    liveRelays.push(freshRelay);

    return {
      relay: freshRelay,
      sentToWorkBuddy: freshSent,
      capture: freshCapture,
      push: async (message: unknown) => {
        if (!freshCapture.handler) throw new Error("bridge handler not registered");
        await freshCapture.handler(message as ExtensionInbound);
      },
      resultDeliveries: () =>
        freshCapture.sent
          .filter((m) => m.type === "send_to_chatgpt" && typeof m.text === "string" && (m.text as string).includes("TYPE: RESULT"))
          .map((m) => ({ text: m.text as string, deliveryId: m.deliveryId })),
      stop: async () => {
        await freshRelay.stopCurrentRound("restart case ended");
      },
    };
  };

  return h;
}

function pendingResults(store: RelayStore): PendingItem[] {
  return store.snapshot().pending.filter((p) => p.kind === "workbuddy_result");
}

describe("P0 identity contracts (pure)", () => {
  it("deliveryIdFor is stable across crashes and restarts for one answer", () => {
    const a = deliveryIdFor({ taskId: "t1", workbuddyMessageId: "wb-1", dispatchId: "t1#0" });
    const b = deliveryIdFor({ taskId: "t1", workbuddyMessageId: "wb-1", dispatchId: "t1#0" });
    expect(a).toBe(b);
    expect(a).toBe("delivery:t1#t1#0#wb-1");

    // Different task / dispatch / message => different id (never collide).
    expect(deliveryIdFor({ taskId: "t2", workbuddyMessageId: "wb-1", dispatchId: "t1#0" })).not.toBe(a);
    expect(deliveryIdFor({ taskId: "t1", workbuddyMessageId: "wb-2", dispatchId: "t1#0" })).not.toBe(a);
    expect(deliveryIdFor({ taskId: "t1", workbuddyMessageId: "wb-1", dispatchId: "t1#1" })).not.toBe(a);
  });

  it("planRecovery: a persisted-but-undelivered answer never becomes a re-wait", () => {
    const plan: RecoveryPlan = planRecovery({
      taskId: "t1",
      status: "waiting_workbuddy",
      workbuddyOutboundMessageId: "wb-1",
      hasPendingResult: true,
    });
    // The durable outbox outranks the live "waiting" status: recover the
    // answer, do NOT start a new WorkBuddy wait.
    expect(plan.kind).toBe("redeliver_result");
    expect(plan).not.toMatchObject({ kind: "resume_wait" });
  });

  it("planRecovery: a delivered answer is parked on its lease, never re-sent", () => {
    for (const stage of ["RESULT_DELIVERED", "RESULT_ACKED"] as const) {
      const plan = planRecovery({
        taskId: "t1",
        status: "sent_to_gpt",
        workbuddyOutboundMessageId: "wb-1",
        hasPendingResult: true, // a crash may have left the outbox behind
        execution: { stage },
      } as RecoverableTask);
      expect(plan.kind).toBe("wait_ack");
    }
  });

  it("planRecovery: ledger says persisted but the payload is gone fails closed", () => {
    const plan = planRecovery({
      taskId: "t1",
      status: "waiting_workbuddy",
      workbuddyOutboundMessageId: "wb-1",
      hasPendingResult: false, // outbox was lost, yet the ledger claims RESULT_PERSISTED
      execution: { stage: "RESULT_PERSISTED" },
    } as RecoverableTask);
    // Fail closed: no re-wait (which would re-run WorkBuddy), no blind redeliver.
    expect(plan.kind).toBe("flush_queue");
    expect(plan).not.toMatchObject({ kind: "resume_wait" });
    expect(plan).not.toMatchObject({ kind: "redeliver_result" });
  });
});

describe("P0-A persist crash window (pipeline unit)", () => {
  function makePipeline(store: RelayStore) {
    const audit = fakeAudit();
    const sent: { type?: string; deliveryId?: string }[] = [];
    const bridge = {
      hasClient: () => true,
      onMessage: () => {},
      send: async (m: { type?: string; deliveryId?: string }) => {
        sent.push(m);
      },
      close: async () => {},
    } as unknown as BridgeServer;
    const config = {
      relay: { autoSendToChatGPT: true, resultLeaseMs: 5_000 },
    } as unknown as AppConfig;
    const pipeline = new ResultPipeline({
      store,
      audit,
      bridge,
      config,
      hooks: {
        noteStage: async () => {},
        onRoundCompleted: async () => true,
        onLeaseExpired: async () => {},
      },
    });
    return { pipeline, sent };
  }

  it("persisting the same answer twice yields exactly one logical result", async () => {
    const dir = join(sandboxRoot, `unit-${seq++}`);
    const store = new RelayStore(pathToFileURL(join(dir, "state.json")));
    await store.load();
    const { pipeline } = makePipeline(store);

    await pipeline.persist({ taskId: "t1", workbuddyMessageId: "wb-1", text: resultBlock("t1", RESULT_BODY) });
    await pipeline.persist({ taskId: "t1", workbuddyMessageId: "wb-1", text: resultBlock("t1", RESULT_BODY) });

    expect(pendingResults(store)).toHaveLength(1);
  });

  it("the same result id with a different payload fails closed", async () => {
    const dir = join(sandboxRoot, `unit-${seq++}`);
    const store = new RelayStore(pathToFileURL(join(dir, "state.json")));
    await store.load();
    const { pipeline } = makePipeline(store);

    await pipeline.persist({ taskId: "t1", workbuddyMessageId: "wb-1", text: resultBlock("t1", "first") });
    await expect(
      pipeline.persist({ taskId: "t1", workbuddyMessageId: "wb-1", text: resultBlock("t1", "second") }),
    ).rejects.toBeInstanceOf(ResultIdentityContradiction);

    // The durable copy is untouched: still exactly one entry, the first payload.
    const results = pendingResults(store);
    expect(results).toHaveLength(1);
    expect(results[0]?.text ?? "").toContain("first");
  });
});

describe("P0-A / P0-B recovery through a real restart", () => {
  /*
   * 1. Outbox written, crash before RESULT_PERSISTED, restart: do not re-wait
   *    WorkBuddy, recover THE same answer, exactly one logical result.
   */
  it("recovers the persisted answer after a crash before RESULT_PERSISTED", async () => {
    const h = await makeHarness();
    await h.seedOutbox("t1", RESULT_BODY);
    await h.seedTask("t1", { status: "waiting_workbuddy", sentToGptAt: new Date().toISOString() });

    const replay = await h.restart();
    await replay.relay.resume();
    // Wait for the WHOLE recovery to land: the delivery is sent, the round is
    // marked sent_to_gpt, AND the outbox is consumed. The delivery's bridge.send
    // returns before its status write and before removePending, so observing
    // only the send would race the assertions below.
    await flushUntil(
      () =>
        replay.resultDeliveries().length === 1 &&
        h.store.snapshot().currentTask?.status === "sent_to_gpt" &&
        pendingResults(h.store).length === 0,
      3000,
      "the RESULT to be re-delivered, the round marked sent_to_gpt, and the outbox consumed",
    );

    expect(replay.resultDeliveries()).toHaveLength(1);
    expect(replay.sentToWorkBuddy).toHaveLength(0); // WorkBuddy was never asked to run it again
    // The round is alive and recovered the answer (it is waiting for the
    // acknowledgement), not re-waiting WorkBuddy and not gone.
    expect(h.store.snapshot().currentTask?.taskId).toBe("t1");
    expect(h.store.snapshot().currentTask?.status).toBe("sent_to_gpt");
    expect(pendingResults(h.store)).toHaveLength(0); // the outbox was consumed by the delivery
  });

  /*
   * 4. RESULT_PERSISTED, crash before delivery: the delivery id is stable and
   *    the answer is delivered exactly once after restart.
   */
  it("re-delivers with the same stable delivery id after a crash before delivery", async () => {
    const h = await makeHarness();
    await h.seedOutbox("t1", RESULT_BODY);
    await h.seedTask("t1", {
      status: "result_pending",
      dispatchId: "t1#0",
      workbuddyOutboundMessageId: "wb-1",
      execution: { stage: "RESULT_PERSISTED" },
    } as never);

    const expected = deliveryIdFor({ taskId: "t1", workbuddyMessageId: "wb-1", dispatchId: "t1#0" });

    const replay = await h.restart();
    await replay.relay.resume();
    await flushUntil(() => replay.resultDeliveries().length === 1, 3000, "the RESULT to be delivered");

    expect(replay.resultDeliveries()).toHaveLength(1);
    expect(replay.resultDeliveries()[0]?.deliveryId).toBe(expected);
  });

  /*
   * 6. Pending result + ledger RESULT_DELIVERED: recovery does NOT blindly
   *    re-deliver (the sink idempotency gate is a backstop, not a license).
   */
  it("does not re-deliver an answer the ledger already proves delivered", async () => {
    const h = await makeHarness();
    await h.seedOutbox("t1", RESULT_BODY); // a crash may leave this behind
    await h.seedTask("t1", {
      status: "sent_to_gpt",
      dispatchId: "t1#0",
      workbuddyOutboundMessageId: "wb-1",
      deliveryId: deliveryIdFor({ taskId: "t1", workbuddyMessageId: "wb-1", dispatchId: "t1#0" }),
      sentToGptAt: new Date().toISOString(),
      execution: { stage: "RESULT_DELIVERED" },
    } as never);

    const replay = await h.restart();
    await replay.relay.resume();
    await sleep(200); // give any bogus delivery a chance to fire

    expect(replay.resultDeliveries()).toHaveLength(0);
    expect(replay.sentToWorkBuddy).toHaveLength(0);
    // The round is parked, not closed: the lease owns it until the ack lands.
    expect(h.store.snapshot().currentTask?.taskId).toBe("t1");
  });

  /*
   * 7. Pending result + ledger RESULT_ACKED: same as 6, parked on the lease.
   */
  it("does not re-deliver an answer the ledger already proves acknowledged", async () => {
    const h = await makeHarness();
    await h.seedOutbox("t1", RESULT_BODY);
    await h.seedTask("t1", {
      status: "sent_to_gpt",
      dispatchId: "t1#0",
      workbuddyOutboundMessageId: "wb-1",
      deliveryId: deliveryIdFor({ taskId: "t1", workbuddyMessageId: "wb-1", dispatchId: "t1#0" }),
      sentToGptAt: new Date().toISOString(),
      execution: { stage: "RESULT_ACKED" },
    } as never);

    const replay = await h.restart();
    await replay.relay.resume();
    await sleep(200);

    expect(replay.resultDeliveries()).toHaveLength(0);
    expect(h.store.snapshot().currentTask?.taskId).toBe("t1");
  });

  /*
   * 8. Store says waiting_workbuddy but a durable result exists: do NOT take it
   *    as a re-wait; recover the answer instead.
   */
  it("recovers the answer when the live status still says waiting_workbuddy", async () => {
    const h = await makeHarness();
    await h.seedOutbox("t1", RESULT_BODY);
    await h.seedTask("t1", {
      status: "waiting_workbuddy",
      dispatchId: "t1#0",
      workbuddyOutboundMessageId: "wb-1",
      execution: { stage: "RESULT_RECEIVED" },
    } as never);

    const replay = await h.restart();
    await replay.relay.resume();
    await flushUntil(() => replay.resultDeliveries().length === 1, 3000, "the RESULT to be re-delivered");

    expect(replay.resultDeliveries()).toHaveLength(1);
    expect(replay.sentToWorkBuddy).toHaveLength(0);
  });

  /*
   * 9. Ledger says RESULT_PERSISTED but the payload is gone: fail closed.
   *    The relay must not re-wait WorkBuddy (which would re-run the task).
   */
  it("fails closed when the ledger claims persisted but the outbox is lost", async () => {
    const h = await makeHarness();
    // No outbox seeded on purpose.
    await h.seedTask("t1", {
      status: "waiting_workbuddy",
      dispatchId: "t1#0",
      workbuddyOutboundMessageId: "wb-1",
      execution: { stage: "RESULT_PERSISTED" },
    } as never);

    const replay = await h.restart();
    await replay.relay.resume();
    await sleep(200);

    expect(replay.resultDeliveries()).toHaveLength(0);
    expect(replay.sentToWorkBuddy).toHaveLength(0);
    // The contradictory task is left for a human; it is not silently run.
    expect(h.store.snapshot().currentTask?.taskId).toBe("t1");
  });

  /*
   * 15. After RESULT_PERSISTED, a restart must not execute or wait WorkBuddy
   *     a second time.
   */
  it("never runs WorkBuddy again after a restart post-persist", async () => {
    const h = await makeHarness();
    await h.seedOutbox("t1", RESULT_BODY);
    await h.seedTask("t1", {
      status: "result_pending",
      dispatchId: "t1#0",
      workbuddyOutboundMessageId: "wb-1",
      execution: { stage: "RESULT_PERSISTED" },
    } as never);

    const replay = await h.restart();
    await replay.relay.resume();
    await flushUntil(() => replay.resultDeliveries().length === 1, 3000, "the RESULT to be re-delivered");

    expect(replay.sentToWorkBuddy.filter((t) => t.includes("t1"))).toHaveLength(0);
    expect(replay.resultDeliveries()).toHaveLength(1);
  });
});

describe("P0-B delivery crash window and the sink idempotency gate", () => {
  /*
   * 5. The delivery side effect succeeded, but the local cleanup lost the race
   *    (crash before the round was marked delivered). The relay replays the
   *    SAME delivery id, and a sink that idempotency-keys on it injects the
   *    answer into ChatGPT exactly once.
   */
  it("a replayed delivery with a stable id is de-duplicated by the sink", async () => {
    const dir = join(sandboxRoot, `unit-${seq++}`);
    const store = new RelayStore(pathToFileURL(join(dir, "state.json")));
    await store.load();
    await store.mutate((state) => {
      state.currentTask = {
        taskId: "t1",
        sourceFingerprint: "fp-t1",
        sourceText: taskBlock("t1"),
        startedAt: new Date().toISOString(),
        status: "result_pending",
        dispatchId: "t1#0",
        workbuddyOutboundMessageId: "wb-1",
      } as never;
      state.state = "IDLE";
    });

    // The sink's idempotency gate: keyed on deliveryId, injects once.
    const sinkSeen = new Set<string>();
    let sinkInjections = 0;
    const sent: { deliveryId?: string }[] = [];
    const sinkDeliver = (deliveryId: string | undefined) => {
      if (!deliveryId) return;
      if (sinkSeen.has(deliveryId)) return; // already injected -> no second UI count
      sinkSeen.add(deliveryId);
      sinkInjections += 1;
    };

    const audit = fakeAudit();
    const bridge = {
      hasClient: () => true,
      onMessage: () => {},
      send: async (m: { type?: string; deliveryId?: string }) => {
        sent.push(m);
        sinkDeliver(m.deliveryId); // the extension records every delivery it forwards
      },
      close: async () => {},
    } as unknown as BridgeServer;
    const config = { relay: { autoSendToChatGPT: true, resultLeaseMs: 50_000 } } as unknown as AppConfig;
    const pipeline = new ResultPipeline({
      store,
      audit,
      bridge,
      config,
      hooks: { noteStage: async () => {}, onRoundCompleted: async () => true, onLeaseExpired: async () => {} },
    });

    const payload = resultBlock("t1", RESULT_BODY);
    await pipeline.persist({ taskId: "t1", workbuddyMessageId: "wb-1", text: payload });
    // First delivery.
    await pipeline.deliver({ taskId: "t1", workbuddyMessageId: "wb-1", text: payload, pendingId: pendingResults(store)[0]?.id ?? null });
    const firstId = sent.at(-1)?.deliveryId;
    sinkDeliver(firstId);

    // Crash before the local delivery record is durable: the round is replayed.
    await pipeline.deliver({ taskId: "t1", workbuddyMessageId: "wb-1", text: payload });
    const secondId = sent.at(-1)?.deliveryId;
    sinkDeliver(secondId);

    expect(firstId).toBe(secondId); // the relay sent the same logical delivery
    expect(sinkInjections).toBe(1); // the sink never double-injected
  });

  /*
   * 10. A stale acknowledgement for a round that is already gone must not
   *     resurrect or complete anything.
   */
  it("ignores a late acknowledgement for an already-finished round", async () => {
    const h = await makeHarness();
    const deliveryId = deliveryIdFor({ taskId: "t-ack", workbuddyMessageId: "wb-1", dispatchId: "t-ack#0" });
    await h.seedOutbox("t-ack", RESULT_BODY);
    await h.seedTask("t-ack", {
      status: "sent_to_gpt",
      dispatchId: "t-ack#0",
      workbuddyOutboundMessageId: "wb-1",
      deliveryId,
      sentToGptAt: new Date().toISOString(),
    } as never);

    // The extension confirms it; the round closes.
    await h.push({ type: "chatgpt_send_result", requestId: deliveryId, ok: true, sent: true });
    await flushUntil(() => h.store.snapshot().currentTask === null, 3000, "the round to close");

    const completed = h.audit.events.filter((e) => e.event === "round_completed").length;
    expect(completed).toBe(1);

    // A stale echo from an unrelated round shows up later.
    await h.push({ type: "chatgpt_send_result", requestId: "delivery:t-ghost#*#wb-9", ok: true, sent: true });

    expect(h.store.snapshot().currentTask).toBeNull();
    expect(h.audit.events.filter((e) => e.event === "round_completed").length).toBe(completed);
  });

  /*
   * 11. A wrong-delivery acknowledgement (belongs to another send) cannot close
   *     the live round.
   */
  it("rejects an acknowledgement that names a different delivery", async () => {
    const h = await makeHarness();
    const deliveryId = deliveryIdFor({ taskId: "t-wrong", workbuddyMessageId: "wb-1", dispatchId: "t-wrong#0" });
    await h.seedOutbox("t-wrong", RESULT_BODY);
    await h.seedTask("t-wrong", {
      status: "sent_to_gpt",
      dispatchId: "t-wrong#0",
      workbuddyOutboundMessageId: "wb-1",
      deliveryId,
      sentToGptAt: new Date().toISOString(),
    } as never);

    // A stray ack from a foreign delivery shows up.
    await h.push({ type: "chatgpt_send_result", requestId: "delivery:other#*#wb-x", ok: true, sent: true });

    expect(h.store.snapshot().currentTask?.taskId).toBe("t-wrong");
    expect(h.audit.events.some((e) => e.event === "chatgpt_send_result_wrong_delivery")).toBe(true);
    expect(h.audit.events.filter((e) => e.event === "round_completed").length).toBe(0);
  });

  /*
   * 12. A duplicate exact acknowledgement is idempotent.
   */
  it("treats a second identical acknowledgement as a no-op", async () => {
    const h = await makeHarness();
    const deliveryId = deliveryIdFor({ taskId: "t-dup", workbuddyMessageId: "wb-1", dispatchId: "t-dup#0" });
    await h.seedOutbox("t-dup", RESULT_BODY);
    await h.seedTask("t-dup", {
      status: "sent_to_gpt",
      dispatchId: "t-dup#0",
      workbuddyOutboundMessageId: "wb-1",
      deliveryId,
      sentToGptAt: new Date().toISOString(),
    } as never);

    await h.push({ type: "chatgpt_send_result", requestId: deliveryId, ok: true, sent: true });
    await flushUntil(() => h.store.snapshot().currentTask === null, 3000, "the round to close");
    const completedAfterFirst = h.audit.events.filter((e) => e.event === "round_completed").length;
    expect(completedAfterFirst).toBe(1);

    await h.push({ type: "chatgpt_send_result", requestId: deliveryId, ok: true, sent: true });
    expect(h.audit.events.filter((e) => e.event === "round_completed").length).toBe(completedAfterFirst);
  });

  /*
   * 13. An acknowledgement that arrives after a restart still closes the round,
   *     because the delivery id is derived only from durable facts.
   */
  it("accepts the acknowledgement after a restart because the delivery id is durable", async () => {
    const h = await makeHarness();
    const deliveryId = deliveryIdFor({ taskId: "t-rack", workbuddyMessageId: "wb-1", dispatchId: "t-rack#0" });
    await h.seedOutbox("t-rack", RESULT_BODY);
    await h.seedTask("t-rack", {
      status: "sent_to_gpt",
      dispatchId: "t-rack#0",
      workbuddyOutboundMessageId: "wb-1",
      deliveryId,
      sentToGptAt: new Date().toISOString(),
    } as never);

    // Crash before the ack; restart recovers the delivered round.
    const replay = await h.restart();
    await replay.relay.resume();
    await flushUntil(() => replay.resultDeliveries().length === 1, 3000, "the answer to be re-delivered after restart");

    // The extension's acknowledgement, bound to the same durable delivery id.
    await replay.push({ type: "chatgpt_send_result", requestId: deliveryId, ok: true, sent: true });
    await flushUntil(() => h.store.snapshot().currentTask === null, 3000, "the round to close after restart");

    expect(h.store.snapshot().currentTask).toBeNull();
    expect(pendingResults(h.store)).toHaveLength(0); // outbox cleared on ack
  });

  /*
   * 14. A fast result observed by two paths (a thread observation and the normal
   *     wait) must still become exactly one logical result.
   */
  it("keeps exactly one logical result when the answer is observed twice", async () => {
    const dir = join(sandboxRoot, `unit-${seq++}`);
    const store = new RelayStore(pathToFileURL(join(dir, "state.json")));
    await store.load();
    const { pipeline } = (() => {
      const audit = fakeAudit();
      const bridge = { hasClient: () => true, onMessage: () => {}, send: async () => {}, close: async () => {} } as unknown as BridgeServer;
      const config = { relay: { autoSendToChatGPT: true, resultLeaseMs: 5_000 } } as unknown as AppConfig;
      const p = new ResultPipeline({
        store,
        audit,
        bridge,
        config,
        hooks: { noteStage: async () => {}, onRoundCompleted: async () => true, onLeaseExpired: async () => {} },
      });
      return { pipeline: p };
    })();

    // The same answer reaches the pipeline from two observations.
    await pipeline.persist({ taskId: "t1", workbuddyMessageId: "wb-1", text: resultBlock("t1", RESULT_BODY) });
    await pipeline.persist({ taskId: "t1", workbuddyMessageId: "wb-1", text: resultBlock("t1", RESULT_BODY) });

    expect(pendingResults(store)).toHaveLength(1);

    // In-process double acceptance is also guarded by the delivery ledger.
    const ledger = new ResultDeliveryLedger();
    expect(ledger.claim(deliveryIdFor({ taskId: "t1", workbuddyMessageId: "wb-1", dispatchId: "t1#0" }))).toBe(true);
    expect(ledger.claim(deliveryIdFor({ taskId: "t1", workbuddyMessageId: "wb-1", dispatchId: "t1#0" }))).toBe(false);
  });
});

/**
 * Mutation tests: each one removes a guard the crash-consistency work added,
 * proves the bug would reappear (the system now behaves wrongly), then restores
 * the guard. Together with the regression cases above they show the new tests
 * would actually go red if the fix regressed.
 */
describe("mutation: the crash-consistency guards are load bearing", () => {
  it("mutation: a non-stable delivery id would let a replay double-inject", () => {
    const spy = vi.spyOn(recovery, "deliveryIdFor").mockImplementation(
      (input: { taskId: string; workbuddyMessageId: string; dispatchId?: string | null }) =>
        `delivery:${input.taskId}#${input.dispatchId ?? "*"}#${input.workbuddyMessageId}#${Math.random()}`,
    );
    const a = deliveryIdFor({ taskId: "t1", workbuddyMessageId: "wb-1", dispatchId: "t1#0" });
    const b = deliveryIdFor({ taskId: "t1", workbuddyMessageId: "wb-1", dispatchId: "t1#0" });
    expect(a).not.toBe(b); // the bug: the same answer gets two ids -> the sink cannot dedup
    spy.mockRestore();
  });

  it("mutation: ignoring delivery proof would re-deliver an already-delivered answer", () => {
    const spy = vi.spyOn(recovery, "planRecovery").mockImplementation((task) => {
      if (task?.hasPendingResult) return { kind: "redeliver_result", taskId: task.taskId };
      return { kind: "flush_queue" };
    });
    const plan = planRecovery({
      taskId: "t1",
      status: "sent_to_gpt",
      hasPendingResult: true,
      execution: { stage: "RESULT_DELIVERED" },
    } as RecoverableTask);
    expect(plan.kind).toBe("redeliver_result"); // the bug: a delivered answer would be re-sent
    spy.mockRestore();
  });

  it("mutation: a non-idempotent persist would create two logical results", async () => {
    const dir = join(sandboxRoot, `mut-${seq++}`);
    const store = new RelayStore(pathToFileURL(join(dir, "state.json")));
    await store.load();
    const findSpy = vi
      .spyOn(store, "findPendingResult")
      .mockResolvedValue(null); // pretend nothing was ever persisted
    const audit = fakeAudit();
    const bridge = { hasClient: () => true, onMessage: () => {}, send: async () => {}, close: async () => {} } as unknown as BridgeServer;
    const config = { relay: { autoSendToChatGPT: true, resultLeaseMs: 5_000 } } as unknown as AppConfig;
    const pipeline = new ResultPipeline({
      store,
      audit,
      bridge,
      config,
      hooks: { noteStage: async () => {}, onRoundCompleted: async () => true, onLeaseExpired: async () => {} },
    });
    await pipeline.persist({ taskId: "t1", workbuddyMessageId: "wb-1", text: resultBlock("t1", RESULT_BODY) });
    await pipeline.persist({ taskId: "t1", workbuddyMessageId: "wb-1", text: resultBlock("t1", RESULT_BODY) });
    expect(pendingResults(store)).toHaveLength(2); // the bug: two logical results
    findSpy.mockRestore();
  });

  it("mutation: swallowing the identity contradiction would hide a second payload", async () => {
    const dir = join(sandboxRoot, `mut-${seq++}`);
    const store = new RelayStore(pathToFileURL(join(dir, "state.json")));
    await store.load();
    const audit = fakeAudit();
    const bridge = { hasClient: () => true, onMessage: () => {}, send: async () => {}, close: async () => {} } as unknown as BridgeServer;
    const config = { relay: { autoSendToChatGPT: true, resultLeaseMs: 5_000 } } as unknown as AppConfig;
    const pipeline = new ResultPipeline({
      store,
      audit,
      bridge,
      config,
      hooks: { noteStage: async () => {}, onRoundCompleted: async () => true, onLeaseExpired: async () => {} },
    });
    const spy = vi.spyOn(pipeline, "persist").mockImplementation(async (input) => {
      const item = {
        kind: "workbuddy_result",
        id: `pending-wb-${Math.random()}`,
        taskId: input.taskId,
        text: input.text,
        workbuddyMessageId: input.workbuddyMessageId,
        createdAt: new Date().toISOString(),
      } as PendingItem;
      await store.enqueue(item); // buggy: never fail closed on a differing payload
      return item;
    });
    await pipeline.persist({ taskId: "t1", workbuddyMessageId: "wb-1", text: resultBlock("t1", "first") });
    await pipeline.persist({ taskId: "t1", workbuddyMessageId: "wb-1", text: resultBlock("t1", "second") });
    expect(pendingResults(store).length).toBeGreaterThan(1); // the bug: two payloads for one identity
    spy.mockRestore();
  });

  it("mutation: not clearing the outbox on ack would re-deliver after completion", async () => {
    const h = await makeHarness();
    await h.seedOutbox("t1", RESULT_BODY);
    await h.seedTask("t1", {
      status: "sent_to_gpt",
      dispatchId: "t1#0",
      workbuddyOutboundMessageId: "wb-1",
      deliveryId: deliveryIdFor({ taskId: "t1", workbuddyMessageId: "wb-1", dispatchId: "t1#0" }),
      sentToGptAt: new Date().toISOString(),
      execution: { stage: "RESULT_DELIVERED" },
    } as never);

    // The bug: the outbox is never cleared when the round completes.
    const removeSpy = vi.spyOn(h.store, "removePendingResultForTask").mockResolvedValue(undefined);

    const replay = await h.restart();
    await replay.relay.resume();
    await sleep(150);
    const deliveryId = h.capture.lastDeliveryId ?? deliveryIdFor({ taskId: "t1", workbuddyMessageId: "wb-1", dispatchId: "t1#0" });
    await replay.push({ type: "chatgpt_send_result", requestId: deliveryId, ok: true, sent: true });
    await flushUntil(() => h.store.snapshot().currentTask === null, 3000, "the round to close");

    // With the guard gone, the lingering outbox is flushed again: the answer is
    // sent to ChatGPT a second time. The honest path delivers it zero times here.
    await flushUntil(() => replay.resultDeliveries().length >= 1, 3000, "the stale outbox to be re-sent");
    expect(replay.resultDeliveries().length).toBeGreaterThanOrEqual(1);
    removeSpy.mockRestore();
  });

  it("mutation: a delivery id that ignores the task would accept a wrong-task ack", () => {
    const spy = vi.spyOn(recovery, "deliveryIdFor").mockImplementation(() => "delivery:CONSTANT");
    // After delivery, the live task's deliveryId and a foreign ack's requestId
    // both collapse to the constant, so a wrong-task ack would be accepted.
    const liveId = deliveryIdFor({ taskId: "t-live", workbuddyMessageId: "wb-1", dispatchId: "t-live#0" });
    const foreignAckId = deliveryIdFor({ taskId: "t-other", workbuddyMessageId: "wb-9", dispatchId: "t-other#0" });
    expect(liveId).toBe(foreignAckId); // the bug: identities collide
    spy.mockRestore();
  });
});
