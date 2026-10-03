/**
 * v0.4.7.3j: a GPT task has to be attested when it is observed, not when it
 * is finally scheduled.
 *
 * The production accident, replayed. `relay-production-smoke-v0473i-003` was
 * read off the real ChatGPT page while the relay was PAUSED, and the intake
 * handler put it straight on the queue:
 *
 *   if (snapshot.paused)  { enqueue; return; }
 *   if (currentTask)      { enqueue; return; }
 *
 * Both branches returned before the pipeline ran, so neither ever wrote
 * TASK_ACCEPTED. The entry went into the queue carrying a TASK_PUBLISHED and
 * nothing else - and a TASK_PUBLISHED proves nothing, by design. Minutes later
 * a flush asked where the task came from: the page had unmounted the bubble,
 * the accepted chain was empty, and the answer was
 *
 *   gpt_not_found / no_accepted_chain
 *
 * for ever. The task was unsendable not because anything was wrong with it,
 * but because the relay queued first and asked about provenance later.
 *
 * What is asserted here is the separation of the two questions:
 *
 *   WHERE DID THIS COME FROM   answered once, at observation time, durably
 *   WHEN DOES IT RUN           answered later, and free to say "not now"
 *
 * Paused and busy are answers to the second question only. A task queued by a
 * paused relay must arrive in the queue with its attestation already written,
 * so that a restart - with the GPT page long since virtualised away - can still
 * prove it and send it.
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

/** A fresh task, observed on the GPT page for the first time. */
const TASK = "relay-production-smoke-v0473j-001";
/** The GPT message that carried it. */
const MESSAGE = "assistant-message:m-observed";

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
    "[ZHIXING_RELAY_END]",
  ].join("\n");
}

const TEXT = taskBlock(TASK);
const FP = taskFingerprint(TEXT);

type Fixture = {
  relay: ZhixingRelay;
  store: RelayStore;
  dir: string;
  ledgerFile: string;
  sentToWorkBuddy: string[];
  rows: () => Promise<Record<string, unknown>[]>;
  /** One real GPT assistant message arriving on the bridge. */
  observe: (text?: string, fingerprint?: string) => Promise<void>;
  /** One scheduling action: resume, then wait for everything it started. */
  schedule: () => Promise<void>;
  /** Makes the relay busy with an unrelated round. */
  busyWith: (taskId: string) => Promise<void>;
  /** Stops the relay the way a restart would. */
  stop: () => Promise<void>;
};

/**
 * A real relay on a throwaway state file and ledger.
 *
 * The bridge answers `fetch_recent_assistant_messages` with an empty page:
 * that is the production shape once ChatGPT has unmounted the message, and it
 * is the condition that makes an unattested queue entry unprovable.
 */
async function makeFixture(
  options: {
    seed?: (log: TaskLedger) => Promise<void>;
    /**
     * Queue entries that exist BEFORE the relay boots.
     *
     * Enqueuing after `init()` would hand startup reconciliation a ledger it
     * cannot explain: a published task with no owner, which it rightly freezes
     * as an orphan. These entries are the ones the relay is supposed to find
     * already waiting for it.
     */
    pending?: PendingItem[];
    paused?: boolean;
  } = {},
): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "zxr-intake-"));
  createdDirs.push(dir);

  const store = new RelayStore(pathToFileURL(join(dir, "state.json")));
  await store.load();

  const ledgerFile = join(dir, "ledger.jsonl");

  if (options.seed) {
    await options.seed(new TaskLedger(pathToFileURL(ledgerFile)));
  }

  for (const item of options.pending ?? []) {
    await store.enqueue(item);
  }

  if (options.paused !== false) {
    await store.mutate((state) => {
      state.paused = true;
      state.state = "PAUSED";
    });
  }

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
      // The page, asked what it currently shows: nothing.
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
        send: {
          ok: true,
          reason: "confirmed",
          observedMessageId: "wb-1",
          beforeTurnCount: 0,
          afterTurnCount: 1,
        },
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

  const fx: Fixture = {
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
    observe: async (text = TEXT, fingerprint = MESSAGE) => {
      await handler?.({
        type: "chatgpt_assistant_message",
        text,
        fingerprint,
      } as ExtensionInbound);
      await relay.drainBackgroundWork();
    },
    schedule: async () => {
      await relay.resume();
      await relay.drainBackgroundWork();
    },
    busyWith: async (taskId: string) => {
      await store.mutate((state) => {
        state.currentTask = {
          taskId,
          sourceFingerprint: "m-someone-else",
          sourceText: taskBlock(taskId),
          startedAt: AT,
          status: "waiting_workbuddy",
        };
        state.state = "WAIT_WORKBUDDY";
      });
    },
    stop: async () => {
      await relay.dispose();
      const at = openRelays.indexOf(relay);
      if (at >= 0) openRelays.splice(at, 1);
    },
  };

  return fx;
}

/** A relay that comes back on the same state file and ledger. */
async function restarted(fx: Fixture): Promise<ZhixingRelay> {
  const relay = new ZhixingRelay(
    {
      relay: {},
      workbuddy: { pollIntervalMs: 5, sendConfirmTimeoutMs: 200, runningConfirmTimeoutMs: 500 },
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
      getCurrentModel: async () => "Hy4 preview",
      selectModel: async (label: string) => ({ changed: true, previous: null, current: label }),
      sendText: async (sent: string) => {
        fx.sentToWorkBuddy.push(sent);
        return {
          outboundId: "wb-2",
          input: { ok: true, observed: sent },
          send: {
            ok: true,
            reason: "confirmed",
            observedMessageId: "wb-2",
            beforeTurnCount: 0,
            afterTurnCount: 1,
          },
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
        lastMessageId: "wb-2",
        assistantMessages: [],
      }),
      detectQuota: async () => ({
        status: "available",
        modelLabel: "Hy4 preview",
        resetAt: null,
        reason: null,
        source: "probe",
      }),
    } as unknown as WorkBuddyClient,
    null,
  );
  await relay.init();
  openRelays.push(relay);
  return relay;
}

const pendingOf = (fx: Fixture): PendingItem[] => fx.store.snapshot().pending as PendingItem[];

const eventsOf = async (fx: Fixture): Promise<string[]> =>
  (await fx.rows()).map((row) => String(row.event));

describe("a GPT task observed while the relay is paused", () => {
  it("is attested before it is queued", async () => {
    const fx = await makeFixture();

    await fx.observe();

    expect(await eventsOf(fx)).toEqual(
      expect.arrayContaining(["TASK_PUBLISHED", "TASK_ACCEPTED", "TASK_ENQUEUED"]),
    );

    // Attested, then queued - and execution has not begun.
    const rows = await fx.rows();
    expect(rows.filter((row) => row.event === "TASK_ACCEPTED")).toHaveLength(1);
    expect(rows.filter((row) => row.event === "DISPATCH_STARTED")).toHaveLength(0);
    expect(fx.sentToWorkBuddy).toEqual([]);

    // The queue owns exactly one entry, and it is the observed text.
    const pending = pendingOf(fx);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.kind === "gpt_task" && pending[0].text).toBe(TEXT);
    expect(pending[0]?.kind === "gpt_task" && pending[0].fingerprint).toBe(MESSAGE);

    expect(unhandledRejections).toEqual([]);
  });

  it("carries its attestation across a restart, with the GPT page empty", async () => {
    const fx = await makeFixture();

    await fx.observe();
    await fx.stop();

    // The bubble is gone: the restarted process can only read the ledger.
    const relay = await restarted(fx);
    expect(relay.status().reconciliationHold).toBe(false);

    await relay.resume();
    await relay.drainBackgroundWork();

    // Proven by the chain written at observation time, not by the page.
    expect(fx.sentToWorkBuddy).toEqual([TEXT]);
    expect(pendingOf(fx)).toHaveLength(0);

    const rows = await fx.rows();
    expect(rows.filter((row) => row.event === "DISPATCH_STARTED")).toHaveLength(1);
    expect(rows.filter((row) => row.event === "TASK_BLOCKED")).toHaveLength(0);

    expect(unhandledRejections).toEqual([]);
  });
});

describe("a GPT task observed while another round is running", () => {
  it("is attested before it is queued", async () => {
    const fx = await makeFixture({ paused: false });
    await fx.busyWith("relay-production-smoke-v0473j-000");

    await fx.observe();

    const rows = await fx.rows();
    expect(rows.filter((row) => row.event === "TASK_ACCEPTED")).toHaveLength(1);
    expect(rows.filter((row) => row.event === "TASK_ENQUEUED")).toHaveLength(1);
    expect(rows.filter((row) => row.event === "DISPATCH_STARTED")).toHaveLength(0);
    expect(fx.sentToWorkBuddy).toEqual([]);

    const pending = pendingOf(fx);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.kind === "gpt_task" && pending[0].text).toBe(TEXT);

    expect(unhandledRejections).toEqual([]);
  });

  it("runs on its attestation when the relay later becomes free", async () => {
    const fx = await makeFixture({ paused: false });
    await fx.busyWith("relay-production-smoke-v0473j-000");

    await fx.observe();

    // The other round finishes; the queue is the only owner left.
    await fx.store.mutate((state) => {
      state.currentTask = null;
      state.state = "IDLE";
    });

    await fx.schedule();

    expect(fx.sentToWorkBuddy).toEqual([TEXT]);
    expect(pendingOf(fx)).toHaveLength(0);

    const rows = await fx.rows();
    expect(rows.filter((row) => row.event === "DISPATCH_STARTED")).toHaveLength(1);
    expect(rows.filter((row) => row.event === "TASK_BLOCKED")).toHaveLength(0);

    expect(unhandledRejections).toEqual([]);
  });
});

describe("an idle relay still dispatches immediately", () => {
  it("sends the observed task without queueing it", async () => {
    const fx = await makeFixture({ paused: false });

    await fx.observe();

    expect(fx.sentToWorkBuddy).toEqual([TEXT]);
    expect(pendingOf(fx)).toHaveLength(0);
    expect(fx.store.snapshot().currentTask?.taskId).toBe(TASK);

    const rows = await fx.rows();
    expect(rows.filter((row) => row.event === "TASK_ACCEPTED")).toHaveLength(1);
    expect(rows.filter((row) => row.event === "DISPATCH_STARTED")).toHaveLength(1);
    expect(rows.filter((row) => row.event === "TASK_ENQUEUED")).toHaveLength(0);

    expect(unhandledRejections).toEqual([]);
  });
});

describe("a duplicated observation of one message", () => {
  it("leaves exactly one owner on the queue", async () => {
    const fx = await makeFixture();

    await fx.observe();
    // An extension reconnect replays the same message.
    await fx.observe();

    const pending = pendingOf(fx);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.kind === "gpt_task" && pending[0].text).toBe(TEXT);

    // Attestation stays singular: one accepted row, no contradiction raised.
    const rows = await fx.rows();
    expect(rows.filter((row) => row.event === "TASK_ACCEPTED")).toHaveLength(1);
    expect(rows.filter((row) => row.event === "TASK_BLOCKED")).toHaveLength(0);
    expect(fx.sentToWorkBuddy).toEqual([]);

    expect(unhandledRejections).toEqual([]);
  });
});

describe("a task whose published row was never accepted", () => {
  it("is still unprovable after the fix", async () => {
    /*
     * The smoke003 shape, made by hand: a published row and no acceptance.
     * Fixing paused intake must not turn this into proof - the queue entry
     * here never came from an attested observation.
     */
    const fx = await makeFixture({
      seed: async (log) => {
        await log.append({
          event: "TASK_PUBLISHED",
          taskId: TASK,
          taskFingerprint: FP,
          source: "gpt",
          messageFingerprint: MESSAGE,
        });
      },
      pending: [
        {
          kind: "gpt_task",
          id: "pending-unattested",
          text: TEXT,
          fingerprint: MESSAGE,
          createdAt: AT,
          taskId: TASK,
        },
      ],
    });

    await fx.schedule();

    expect(fx.sentToWorkBuddy).toEqual([]);
    expect(pendingOf(fx)).toHaveLength(1);

    const rows = await fx.rows();
    expect(rows.filter((row) => row.event === "TASK_BLOCKED")).toHaveLength(1);
    expect(rows.filter((row) => row.event === "TASK_ACCEPTED")).toHaveLength(0);

    expect(unhandledRejections).toEqual([]);
  });

  it("refuses a queue entry accepted under another GPT message", async () => {
    const fx = await makeFixture({
      seed: async (log) => {
        await log.append({
          event: "TASK_ACCEPTED",
          taskId: TASK,
          taskFingerprint: FP,
          source: "relay",
          messageFingerprint: "m-somebody-else",
        });
      },
      pending: [
        {
          kind: "gpt_task",
          id: "pending-other-message",
          text: TEXT,
          fingerprint: MESSAGE,
          createdAt: AT,
          taskId: TASK,
        },
      ],
    });

    await fx.schedule();

    expect(fx.sentToWorkBuddy).toEqual([]);
    expect(pendingOf(fx)).toHaveLength(1);

    expect(unhandledRejections).toEqual([]);
  });

  it("refuses a queue entry accepted under another envelope", async () => {
    const fx = await makeFixture({
      seed: async (log) => {
        await log.append({
          event: "TASK_ACCEPTED",
          taskId: TASK,
          taskFingerprint: "fp-some-other-envelope",
          source: "relay",
          messageFingerprint: MESSAGE,
        });
      },
      pending: [
        {
          kind: "gpt_task",
          id: "pending-other-envelope",
          text: TEXT,
          fingerprint: MESSAGE,
          createdAt: AT,
          taskId: TASK,
        },
      ],
    });

    await fx.schedule();

    expect(fx.sentToWorkBuddy).toEqual([]);
    expect(pendingOf(fx)).toHaveLength(1);

    expect(unhandledRejections).toEqual([]);
  });
});

describe("an identity conflict observed while paused", () => {
  it("is refused at the door, not queued for later", async () => {
    const fx = await makeFixture({
      seed: async (log) => {
        await log.append({
          event: "TASK_PUBLISHED",
          taskId: TASK,
          taskFingerprint: "fp-an-envelope-from-before",
          source: "gpt",
          messageFingerprint: "m-old",
        });
      },
    });

    await fx.observe();

    // Contradictory: never attested, never queued, never sent.
    const rows = await fx.rows();
    expect(rows.filter((row) => row.event === "TASK_ACCEPTED")).toHaveLength(0);
    expect(rows.filter((row) => row.event === "TASK_ENQUEUED")).toHaveLength(0);
    expect(rows.filter((row) => row.event === "TASK_BLOCKED")).toHaveLength(1);

    expect(pendingOf(fx)).toHaveLength(0);
    expect(fx.sentToWorkBuddy).toEqual([]);

    expect(unhandledRejections).toEqual([]);
  });
});

describe("the crash windows around acceptance", () => {
  it("treats an accepted, enqueued, still-queued task as clean", async () => {
    const fx = await makeFixture();

    await fx.observe();
    await fx.stop();

    // Queue still owns it, so nothing reads as an orphan.
    const relay = await restarted(fx);

    expect(pendingOf(fx)).toHaveLength(1);
    expect(relay.status().reconciliationHold).toBe(false);

    await relay.dispose();
    openRelays.splice(openRelays.indexOf(relay), 1);

    expect(unhandledRejections).toEqual([]);
  });

  it("blocks safely when acceptance is written but the owner is lost", async () => {
    /*
     * Accepted, then the process died before the queue entry landed. The
     * ledger knows a task the relay does not: it must be reconciled, never
     * silently resent.
     */
    const fx = await makeFixture({
      seed: async (log) => {
        await log.append({
          event: "TASK_PUBLISHED",
          taskId: TASK,
          taskFingerprint: FP,
          source: "gpt",
          messageFingerprint: MESSAGE,
        });
        await log.append({
          event: "TASK_ACCEPTED",
          taskId: TASK,
          taskFingerprint: FP,
          source: "relay",
          messageFingerprint: MESSAGE,
        });
      },
    });

    await fx.stop();

    const relay = await restarted(fx);

    expect(pendingOf(fx)).toHaveLength(0);
    expect(relay.status().reconciliationHold).toBe(true);

    await relay.dispose();
    openRelays.splice(openRelays.indexOf(relay), 1);

    expect(unhandledRejections).toEqual([]);
  });

  it("does not treat a published-but-never-accepted task as provable after a restart", async () => {
    const fx = await makeFixture({
      seed: async (log) => {
        await log.append({
          event: "TASK_PUBLISHED",
          taskId: TASK,
          taskFingerprint: FP,
          source: "gpt",
          messageFingerprint: MESSAGE,
        });
      },
      pending: [
        {
          kind: "gpt_task",
          id: "pending-crash-window-a",
          text: TEXT,
          fingerprint: MESSAGE,
          createdAt: AT,
          taskId: TASK,
        },
      ],
    });

    await fx.stop();
    const relay = await restarted(fx);

    await relay.resume();
    await relay.drainBackgroundWork();

    expect(fx.sentToWorkBuddy).toEqual([]);
    expect(pendingOf(fx)).toHaveLength(1);

    const rows = await fx.rows();
    expect(rows.filter((row) => row.event === "TASK_ACCEPTED")).toHaveLength(0);

    await relay.dispose();
    openRelays.splice(openRelays.indexOf(relay), 1);

    expect(unhandledRejections).toEqual([]);
  });
});
