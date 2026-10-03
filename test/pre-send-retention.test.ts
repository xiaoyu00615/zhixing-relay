/**
 * v0.4.7.3h: a task refused before WorkBuddy ever saw it.
 *
 * The production accident, replayed. `relay-production-smoke-v0473e-002` was
 * requeued after the model selector refused it, and the ledger said
 * `resend_allowed`. One operator resume later the relay answered:
 *
 *   task ... not sent (gpt_not_found): task ... is not on the GPT page with
 *   the same envelope, so there is no proof of what was published
 *
 * and the task was gone: `pending` had been emptied by the flush that took it
 * out, `currentTask` was never written, and nothing anywhere held the work.
 * A refused send turned into a lost task because dequeuing happened before the
 * decision, and because the only proof the retry accepted was the GPT page
 * still showing a message ChatGPT had already unmounted.
 *
 * Two things are asserted here, and they are separate facts:
 *
 *   1. a pre-send refusal returns the queue entry, unchanged - no new id, no
 *      new text, no retry counted, and never a second copy;
 *   2. a task the relay already accepted is proven by the chain it wrote when
 *      it accepted it, not by a bubble that may no longer be mounted.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { AuditLog } from "../src/audit.js";
import type { BridgeServer } from "../src/bridge-server.js";
import { ZhixingRelay } from "../src/relay.js";
import { TaskLedger, taskFingerprint } from "../src/reconciliation/index.js";
import { RelayStore } from "../src/store.js";
import type { ExtensionInbound, PendingItem } from "../src/types.js";
import type { WorkBuddyClient } from "../src/workbuddy.js";

const AT = "2026-10-03T00:00:00.000Z";

/** The task the accident left in the queue. */
const TASK = "relay-production-smoke-v0473e-002";
/** The GPT message the relay first accepted it from. */
const ACCEPTED_MESSAGE = "m-accepted";

const createdDirs: string[] = [];
const openRelays: ZhixingRelay[] = [];
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

  // Disposed first: a background write into a removed directory is the
  // failure mode this suite's predecessors hit.
  for (const relay of openRelays.splice(0)) {
    await relay.dispose();
  }

  for (const dir of createdDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
  }
});

function taskBlock(taskId: string, body = "Run the gate."): string {
  return [
    "[ZHIXING_RELAY]",
    "TYPE: TASK",
    `TASK_ID: ${taskId}`,
    "SOURCE: GPT",
    "",
    body,
  ].join("\n");
}

type Fixture = {
  relay: ZhixingRelay;
  store: RelayStore;
  dir: string;
  ledgerFile: string;
  /** Everything typed into WorkBuddy, in order. */
  sentToWorkBuddy: string[];
  /** The ledger as it stands. */
  rows: () => Promise<Record<string, unknown>[]>;
  /** Runs one scheduling action and waits for everything it started. */
  schedule: () => Promise<void>;
};

/**
 * A real relay on a throwaway state file and ledger.
 *
 * The bridge answers `fetch_recent_assistant_messages` with an empty page on
 * purpose: that is the production shape after ChatGPT unmounts the message,
 * and it is the condition that used to make a durable queue entry unprovable.
 */
async function makeFixture(options: {
  seed?: (log: TaskLedger) => Promise<void>;
  /** The fingerprint the queued entry claims as its GPT source. */
  sourceFingerprint?: string;
  body?: string;
} = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "zxr-presend-"));
  createdDirs.push(dir);

  const store = new RelayStore(pathToFileURL(join(dir, "state.json")));
  await store.load();

  const ledgerFile = join(dir, "ledger.jsonl");
  const sourceFingerprint = options.sourceFingerprint ?? ACCEPTED_MESSAGE;
  const text = taskBlock(TASK, options.body ?? "Run the gate.");

  if (options.seed) {
    await options.seed(new TaskLedger(pathToFileURL(ledgerFile)));
  }

  /*
   * The queue entry, as a flush would meet it: the task text, and the
   * fingerprint of the GPT message it came from.
   */
  await store.enqueue({
    kind: "gpt_task",
    id: "pending-smoke",
    text,
    fingerprint: sourceFingerprint,
    createdAt: AT,
    taskId: TASK,
    retryCount: 1,
    reason: "no_available_model",
  });

  await store.mutate((state) => {
    state.paused = true;
    state.state = "PAUSED";
  });

  const sentToWorkBuddy: string[] = [];
  let handler: ((message: ExtensionInbound) => Promise<void>) | null = null;

  const bridge = {
    hasClient: () => true,
    onMessage: (onMessage: (message: ExtensionInbound) => Promise<void>) => {
      handler = onMessage;
    },
    send: async (message: {
      type?: string;
      requestId?: string;
      text?: string;
      limit?: number;
    }) => {
      // The page is asked what it currently shows: nothing. A message the
      // browser has unmounted cannot be re-read, which is the whole point.
      if (message.type === "fetch_recent_assistant_messages") {
        void handler?.({
          type: "recent_assistant_messages",
          requestId: message.requestId ?? "",
          limit: message.limit,
          messages: [],
        });
      }
    },
    close: async () => {},
    start: async () => {},
  } as unknown as BridgeServer;

  const workbuddy = {
    init: async () => {},
    online: async () => true,
    getCurrentModel: async () => "Hy4 preview",
    selectModel: async (label: string) => ({ changed: true, previous: null, current: label }),
    sendText: async (sent: string) => {
      sentToWorkBuddy.push(sent);
      return {
        outboundId: "wb-1",
        input: { ok: true, observed: sent },
        send: { ok: true, reason: "confirmed", observedMessageId: "wb-1", beforeTurnCount: 0, afterTurnCount: 1 },
        clickOk: true,
      };
    },
    waitForRunning: async () => ({
      outcome: "running",
      ok: true,
      reason: "processing",
      evidence: { running: true, completed: false, cancelled: false },
    }),
    waitForAssistantReply: async () => ({
      text: "gate passed",
      lastMessageId: "wb-1",
      assistantMessages: [],
    }),
    detectQuota: async () => ({
      status: "available",
      modelLabel: "Hy4 preview",
      resetAt: null,
      reason: null,
      source: "probe",
    }),
  } as unknown as WorkBuddyClient;

  const config = {
    relay: {},
    // Small enough that the confirmation windows never slow a test down.
    workbuddy: {
      pollIntervalMs: 5,
      sendConfirmTimeoutMs: 200,
      runningConfirmTimeoutMs: 500,
    },
    paths: { ledger: pathToFileURL(ledgerFile) },
  } as unknown as AppConfig;

  const relay = new ZhixingRelay(
    config,
    bridge,
    store,
    { write: async () => {} } as unknown as AuditLog,
    workbuddy,
    null,
  );
  await relay.init();
  openRelays.push(relay);

  return {
    relay,
    store,
    dir,
    ledgerFile,
    sentToWorkBuddy,
    rows: async () => {
      const raw = await readFile(ledgerFile, "utf8").catch(() => "");
      return raw
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
    schedule: async () => {
      await relay.resume();
      await relay.drainBackgroundWork();
    },
  };
}

/** The chain production had: published, accepted, dispatched, then requeued. */
async function seedAcceptedChain(
  log: TaskLedger,
  options: { messageFingerprint?: string; taskFingerprint?: string } = {},
): Promise<void> {
  const fp = options.taskFingerprint ?? taskFingerprint(taskBlock(TASK));

  await log.append({
    event: "TASK_PUBLISHED",
    taskId: TASK,
    taskFingerprint: fp,
    source: "gpt",
    messageFingerprint: options.messageFingerprint ?? ACCEPTED_MESSAGE,
  });
  await log.append({
    event: "TASK_ACCEPTED",
    taskId: TASK,
    taskFingerprint: fp,
    source: "relay",
    messageFingerprint: options.messageFingerprint ?? ACCEPTED_MESSAGE,
  });
  await log.append({
    event: "DISPATCH_STARTED",
    taskId: TASK,
    taskFingerprint: fp,
    dispatchId: `${TASK}#0`,
    attempt: 0,
    source: "relay",
  });
  await log.append({
    event: "TASK_REQUEUED",
    taskId: TASK,
    taskFingerprint: "*",
    source: "relay",
    detail: { retryCount: 1, reason: "no_available_model", via: "requeue" },
  });
}

const pendingOf = (fx: Fixture): PendingItem[] => fx.store.snapshot().pending as PendingItem[];

describe("a task refused before WorkBuddy saw it", () => {
  it("keeps the queue entry when the source can no longer be proven", async () => {
    // Accepted under one GPT message, queued under another: nothing ties this
    // entry to a message the relay ever verified, so the send is refused.
    const fx = await makeFixture({
      seed: (log) => seedAcceptedChain(log),
      sourceFingerprint: "m-never-verified",
    });

    await fx.schedule();

    expect(fx.sentToWorkBuddy).toEqual([]);
    expect(fx.store.snapshot().currentTask).toBeNull();

    // The canonical owner is the queue, and the entry is the same entry.
    const pending = pendingOf(fx);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      kind: "gpt_task",
      id: "pending-smoke",
      text: taskBlock(TASK),
      fingerprint: "m-never-verified",
      taskId: TASK,
      // A refusal for want of proof is not an attempt: the budget is intact.
      retryCount: 1,
    });

    const rows = await fx.rows();
    expect(rows.filter((row) => row.event === "TASK_BLOCKED")).toHaveLength(1);
    expect(rows.filter((row) => row.event === "DISPATCH_STARTED")).toHaveLength(1);
    expect(rows.filter((row) => row.event === "SEND_CONFIRMED")).toHaveLength(0);

    expect(unhandledRejections).toEqual([]);
  });

  it("produces one rejection per scheduling action, and never schedules its own retry", async () => {
    const fx = await makeFixture({
      seed: (log) => seedAcceptedChain(log),
      sourceFingerprint: "m-never-verified",
    });

    await fx.schedule();

    // One action, one refusal: nothing was dispatched, nothing was sent.
    let rows = await fx.rows();
    expect(rows.filter((row) => row.event === "TASK_BLOCKED")).toHaveLength(1);
    expect(fx.sentToWorkBuddy).toEqual([]);
    expect(fx.relay.backgroundWorkPending()).toBe(0);

    // A second, explicit action gets a second refusal - proof that the count
    // follows scheduling and not a loop that feeds itself.
    await fx.schedule();

    rows = await fx.rows();
    expect(rows.filter((row) => row.event === "TASK_BLOCKED")).toHaveLength(2);
    expect(rows.filter((row) => row.event === "DISPATCH_STARTED")).toHaveLength(1);
    expect(pendingOf(fx)).toHaveLength(1);
    expect(fx.sentToWorkBuddy).toEqual([]);
    expect(fx.relay.backgroundWorkPending()).toBe(0);

    expect(unhandledRejections).toEqual([]);
  });

  it("never lets a refused retry manufacture the provenance the next retry needs", async () => {
    const fx = await makeFixture({
      seed: (log) => seedAcceptedChain(log),
      sourceFingerprint: "m-never-verified",
    });

    await fx.schedule();
    await fx.schedule();
    await fx.schedule();

    const rows = await fx.rows();

    /*
     * Publishing is written before the decision, so a refused attempt could
     * have left one "the relay saw this task" row per try - and a reader (or a
     * later release) would call three rows three observations. One envelope is
     * one published row, whatever happens afterwards.
     */
    expect(rows.filter((row) => row.event === "TASK_PUBLISHED")).toHaveLength(1);
    expect(rows.filter((row) => row.event === "TASK_ACCEPTED")).toHaveLength(1);
    expect(fx.sentToWorkBuddy).toEqual([]);
    expect(pendingOf(fx)).toHaveLength(1);

    expect(unhandledRejections).toEqual([]);
  });

  it("keeps a first-ever queue entry that nothing can prove, instead of sending it", async () => {
    // No chain at all: the entry is waiting, and the page is not carrying it.
    const fx = await makeFixture({ sourceFingerprint: "m-first" });

    await fx.schedule();

    expect(fx.sentToWorkBuddy).toEqual([]);
    expect(fx.store.snapshot().currentTask).toBeNull();
    expect(pendingOf(fx)).toHaveLength(1);
    expect(pendingOf(fx)[0]?.id).toBe("pending-smoke");

    const rows = await fx.rows();
    expect(rows.filter((row) => row.event === "TASK_BLOCKED")).toHaveLength(1);
    expect(rows.filter((row) => row.event === "DISPATCH_STARTED")).toHaveLength(0);

    expect(unhandledRejections).toEqual([]);
  });
});

describe("a task the relay already accepted", () => {
  it("retries on the durable chain when the page let go of the message", async () => {
    const fx = await makeFixture({
      seed: (log) => seedAcceptedChain(log),
      sourceFingerprint: ACCEPTED_MESSAGE,
    });

    await fx.schedule();

    // Accepted under this exact message and envelope, so the unmounted bubble
    // is not an obstacle: the relay wrote its own proof when it accepted.
    expect(fx.sentToWorkBuddy).toEqual([taskBlock(TASK)]);
    expect(pendingOf(fx)).toHaveLength(0);
    expect(fx.store.snapshot().currentTask?.taskId).toBe(TASK);

    const rows = await fx.rows();
    expect(rows.filter((row) => row.event === "TASK_BLOCKED")).toHaveLength(0);
    expect(rows.filter((row) => row.event === "DISPATCH_STARTED")).toHaveLength(2);

    expect(unhandledRejections).toEqual([]);
  });

  it("refuses when the queue entry was accepted under another envelope", async () => {
    const fx = await makeFixture({
      seed: (log) => seedAcceptedChain(log, { taskFingerprint: "fp-some-other-envelope" }),
      sourceFingerprint: ACCEPTED_MESSAGE,
    });

    await fx.schedule();

    expect(fx.sentToWorkBuddy).toEqual([]);
    expect(pendingOf(fx)).toHaveLength(1);

    const rows = await fx.rows();
    expect(rows.filter((row) => row.event === "TASK_BLOCKED")).toHaveLength(1);

    expect(unhandledRejections).toEqual([]);
  });

  it("refuses when the queue entry claims another GPT message behind the same envelope", async () => {
    const fx = await makeFixture({
      seed: (log) => seedAcceptedChain(log, { messageFingerprint: "m-somebody-else" }),
      sourceFingerprint: ACCEPTED_MESSAGE,
    });

    await fx.schedule();

    expect(fx.sentToWorkBuddy).toEqual([]);
    expect(pendingOf(fx)).toHaveLength(1);

    const rows = await fx.rows();
    expect(rows.filter((row) => row.event === "TASK_BLOCKED")).toHaveLength(1);

    expect(unhandledRejections).toEqual([]);
  });

  it("refuses when the queued text no longer hashes to the accepted envelope", async () => {
    // Same taskId, same claimed message - but the payload changed after the
    // relay accepted it, so the recomputed fingerprint cannot match.
    const fx = await makeFixture({
      seed: (log) => seedAcceptedChain(log),
      sourceFingerprint: ACCEPTED_MESSAGE,
      body: "Run the gate, and also delete the build directory.",
    });

    await fx.schedule();

    expect(fx.sentToWorkBuddy).toEqual([]);
    expect(pendingOf(fx)).toHaveLength(1);

    const rows = await fx.rows();
    expect(rows.filter((row) => row.event === "TASK_BLOCKED")).toHaveLength(1);

    expect(unhandledRejections).toEqual([]);
  });
});

describe("a retained task survives a restart", () => {
  it("still owns the task, and the durable chain is still enough", async () => {
    const fx = await makeFixture({
      seed: (log) => seedAcceptedChain(log),
      sourceFingerprint: ACCEPTED_MESSAGE,
    });

    /*
     * A restart is the case the durable proof exists for: a new process has no
     * memory of the page, and the page is not showing the message any more.
     */
    await fx.relay.dispose();
    openRelays.splice(openRelays.indexOf(fx.relay), 1);

    const restarted = new ZhixingRelay(
      {
        relay: {},
        paths: { ledger: pathToFileURL(fx.ledgerFile) },
      } as unknown as AppConfig,
      {
        hasClient: () => true,
        onMessage: () => {},
        send: async () => {},
        close: async () => {},
        start: async () => {},
      } as unknown as BridgeServer,
      fx.store,
      { write: async () => {} } as unknown as AuditLog,
      {
        init: async () => {},
        online: async () => true,
      } as unknown as WorkBuddyClient,
      null,
    );
    await restarted.init();
    openRelays.push(restarted);

    // The queue still owns it, so nothing reads as an orphan and scheduling
    // is not frozen by a task that is simply waiting.
    expect(pendingOf(fx)).toHaveLength(1);
    expect(restarted.status().reconciliationHold).toBe(false);

    await restarted.dispose();
    openRelays.splice(openRelays.indexOf(restarted), 1);

    expect(unhandledRejections).toEqual([]);
  });
});
