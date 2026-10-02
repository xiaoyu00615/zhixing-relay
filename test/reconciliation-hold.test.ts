import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { AuditLog } from "../src/audit.js";
import type { BridgeServer } from "../src/bridge-server.js";
import { createExecutionState } from "../src/delivery/stage.js";
import { ZhixingRelay } from "../src/relay.js";
import { TaskLedger } from "../src/reconciliation/index.js";
import { RelayStore } from "../src/store.js";
import type { CurrentTask } from "../src/types.js";
import type { WorkBuddyClient } from "../src/workbuddy.js";

/*
 * The reconciliation hold, as a fact about now.
 *
 * These tests come from a production incident that the suite could not see:
 * the operator closed the one task that had frozen scheduling, the ledger
 * agreed - `blocked=false`, no blocking finding left - and `/control/status`
 * still answered `reconciliationHold: true`, with an empty queue and nothing
 * in flight. The hold had been assigned `true` only in the blocked branch and
 * never cleared, so it was a latch rather than a reading: once something had
 * gone wrong, the relay said so forever.
 *
 * What is asserted here is therefore the release, and - just as important -
 * the two cases where the hold must NOT be released.
 */

const AT = "2026-10-02T00:00:00.000Z";

/** The task the accident left behind: WorkBuddy ran it, the relay lost it. */
const INCIDENT = "relay-reliable-ack-v047-001";
const INCIDENT_HASH = "a".repeat(64);

/** A second forgotten task, so "closed one" can be told from "closed the only one". */
const OTHER = "relay-reliable-ack-v047-002";
const OTHER_HASH = "b".repeat(64);

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

  // The relay is disposed before its directory goes away: a background write
  // into a removed directory is the failure mode this suite's predecessor hit.
  for (const relay of openRelays.splice(0)) {
    await relay.dispose();
  }

  for (const dir of createdDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
  }
});

function fakeBridge(): BridgeServer {
  return {
    hasClient: () => true,
    onMessage: () => {},
    send: async () => {},
    close: async () => {},
    start: async () => {},
  } as unknown as BridgeServer;
}

function fakeAudit(): AuditLog {
  return { write: async () => {} } as unknown as AuditLog;
}

function fakeWorkbuddy(): WorkBuddyClient {
  return {
    init: async () => {},
    online: async () => true,
  } as unknown as WorkBuddyClient;
}

type Fixture = {
  dir: string;
  relay: ZhixingRelay;
  store: RelayStore;
  ledgerFile: string;
  /** The ledger rows as they stand right now. */
  rows: () => Promise<Record<string, unknown>[]>;
};

/**
 * A real relay on a throwaway state file and ledger.
 *
 * `seed` runs before `init()`, so the start-up reconciliation - the very pass
 * that produced the production hold - reads the accident the way production
 * did, rather than a ledger the test patched afterwards.
 */
async function makeFixture(options: {
  seed?: (log: TaskLedger) => Promise<void>;
  currentTask?: CurrentTask | null;
} = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "zxr-hold-"));
  createdDirs.push(dir);

  const store = new RelayStore(pathToFileURL(join(dir, "state.json")));
  await store.load();

  const ledgerFile = join(dir, "ledger.jsonl");

  if (options.seed) {
    await options.seed(new TaskLedger(pathToFileURL(ledgerFile)));
  }

  if (options.currentTask) {
    const task = options.currentTask;
    await store.mutate((state) => {
      state.currentTask = task;
    });
  }

  const config = {
    relay: {},
    paths: { ledger: pathToFileURL(ledgerFile) },
  } as unknown as AppConfig;

  const relay = new ZhixingRelay(config, fakeBridge(), store, fakeAudit(), fakeWorkbuddy(), null);
  await relay.init();
  openRelays.push(relay);

  return {
    dir,
    relay,
    store,
    ledgerFile,
    rows: async () => {
      const raw = await readFile(ledgerFile, "utf8").catch(() => "");
      return raw
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
  };
}

/** The accident chain: published, dispatched, proven sent, requeued by an older release. */
async function seedForgotten(log: TaskLedger, taskId: string, hash: string): Promise<void> {
  await log.append({ event: "TASK_PUBLISHED", taskId, taskFingerprint: hash, source: "gpt" });
  await log.append({
    event: "DISPATCH_STARTED",
    taskId,
    taskFingerprint: hash,
    dispatchId: `${taskId}#0`,
    attempt: 0,
    source: "relay",
  });
  await log.append({
    event: "SEND_CONFIRMED",
    taskId,
    taskFingerprint: hash,
    dispatchId: `${taskId}#0`,
    attempt: 0,
    source: "relay",
  });
  await log.append({ event: "TASK_REQUEUED", taskId, taskFingerprint: "*", source: "relay" });
}

function liveFrozenTask(taskId: string): CurrentTask {
  return {
    taskId,
    sourceFingerprint: `fp-${taskId}`,
    sourceText: `TASK_ID: ${taskId}`,
    startedAt: AT,
    status: "waiting_workbuddy",
    execution: createExecutionState({ stage: "RECONCILIATION_REQUIRED", at: AT }),
  };
}

describe("the reconciliation hold is released when nothing holds it", () => {
  /*
   * The production accident, replayed: the frozen task is closed, the ledger
   * comes back clean, and the hold has to go away with it.
   */
  it("releases the hold after the operator closed the task that froze it", async () => {
    const fx = await makeFixture({
      seed: (log) => seedForgotten(log, INCIDENT, INCIDENT_HASH),
    });

    // Start-up read the ledger, found the orphan and froze scheduling.
    expect(fx.relay.status().reconciliationHold).toBe(true);

    const closed = await fx.relay.closeReconciledTaskWithoutResend({
      taskId: INCIDENT,
      reason: "WorkBuddy already ran it",
    });

    expect(closed.ok).toBe(true);
    expect(closed.blocked).toBe(false);

    /*
     * The two answers an operator reads side by side must agree: the close
     * response and /control/status are the same fact, not two of them.
     */
    expect(fx.relay.status().reconciliationHold).toBe(false);

    // Nothing was queued, nothing was sent, nothing was invented.
    expect(fx.relay.status().pending).toEqual([]);
    expect(fx.relay.status().currentTask).toBeNull();

    const rows = await fx.rows();
    expect(rows.filter((row) => row.event === "DISPATCH_STARTED")).toHaveLength(1);
    expect(rows.filter((row) => row.event === "TASK_REQUEUED")).toHaveLength(1);
    expect(rows.filter((row) => row.event === "TASK_COMPLETED")).toHaveLength(0);
    expect(rows.filter((row) => row.event === "TASK_ENQUEUED")).toHaveLength(0);
    expect(rows.filter((row) => row.event === "RESULT_RECEIVED")).toHaveLength(0);
    expect(rows.filter((row) => row.event === "RESULT_DELIVERED")).toHaveLength(0);
    expect(rows.filter((row) => row.event === "RESULT_ACKED")).toHaveLength(0);

    // The closure itself: one task-scoped row, never a completion.
    const closure = rows.find((row) => row.event === "RECONCILIATION_RESOLVED");
    expect(closure).toMatchObject({ taskId: INCIDENT, taskFingerprint: "*" });
    expect((closure?.detail as { disposition?: unknown } | undefined)?.disposition).toBe(
      "close_without_resend",
    );

    expect(unhandledRejections).toEqual([]);
  });
});

describe("the hold is not released while something still holds it", () => {
  /*
   * A clean ledger is not a clearance. The relay itself froze a task mid-
   * flight and nobody has said what became of it, so scheduling stays held
   * even though no chain anywhere is blocking.
   */
  it("keeps the hold while the live task still needs a human decision", async () => {
    const fx = await makeFixture({ currentTask: liveFrozenTask("t-live-frozen") });

    expect(fx.relay.status().reconciliationHold).toBe(true);

    /*
     * Closing a task on a ledger that was never blocking must not be read as
     * "everything is fine now": the live hold is a separate fact.
     */
    const closed = await fx.relay.closeReconciledTaskWithoutResend({
      taskId: INCIDENT,
      reason: "an unrelated historical close",
    });

    expect(closed.ok).toBe(true);
    expect(closed.blocked).toBe(true);
    expect(fx.relay.status().reconciliationHold).toBe(true);
    expect(closed.blocked).toBe(fx.relay.status().reconciliationHold);

    expect(unhandledRejections).toEqual([]);
  });

  /*
   * Closing one forgotten task settles one chain. Another forgotten task is
   * still unexplained, and an unexplained chain is still a blocker.
   */
  it("keeps the hold when a second forgotten task is still unexplained", async () => {
    const fx = await makeFixture({
      seed: async (log) => {
        await seedForgotten(log, INCIDENT, INCIDENT_HASH);
        await seedForgotten(log, OTHER, OTHER_HASH);
      },
    });

    expect(fx.relay.status().reconciliationHold).toBe(true);

    const closed = await fx.relay.closeReconciledTaskWithoutResend({
      taskId: INCIDENT,
      reason: "WorkBuddy already ran it",
    });

    expect(closed.ok).toBe(true);
    expect(closed.blocked).toBe(true);
    expect(closed.findings).toContain(`orphaned_task:${OTHER}`);
    expect(fx.relay.status().reconciliationHold).toBe(true);
    expect(closed.blocked).toBe(fx.relay.status().reconciliationHold);

    // The other task is untouched by the decision made about this one.
    const rows = await fx.rows();
    expect(rows.filter((row) => row.event === "DISPATCH_STARTED")).toHaveLength(2);
    expect(rows.filter((row) => row.event === "TASK_REQUEUED")).toHaveLength(2);

    expect(unhandledRejections).toEqual([]);
  });
});
