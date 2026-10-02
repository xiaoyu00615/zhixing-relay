/**
 * v0.4.7.3d: closing a task the relay is still holding.
 *
 * The production smoke task `relay-production-smoke-v0473c-001` really ran:
 * the user bubble is on the page, WorkBuddy completed, and the answer is the
 * smoke token. The relay does not know that - its send confirmation failed on
 * a DOM misread - so it is holding the task as
 * `RECONCILIATION_REQUIRED` and the scheduler is frozen.
 *
 * A historical close writes one ledger row and re-reads the chain, which is
 * not enough here: the hold has a second source, the live record itself. So
 * the canonical `close without resend` has to be able to release *that* record
 * as well - and it has to do it without inventing anything WorkBuddy never
 * reported.
 *
 * These cases drive the real relay through the real control route, on a
 * throwaway state file and ledger.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { BridgeServer } from "../src/bridge-server.js";
import {
  SECRET_HEADER,
  startControlServer,
  type ControlServer,
} from "../src/control.js";
import { createExecutionState, type TaskExecutionStage } from "../src/delivery/stage.js";
import type { AuditLog } from "../src/audit.js";
import { ZhixingRelay } from "../src/relay.js";
import { RelayStore } from "../src/store.js";
import type { WorkBuddyClient } from "../src/workbuddy.js";
import { TaskLedger } from "../src/reconciliation/index.js";
import type { PendingItem } from "../src/types.js";

const SECRET = "live-close-secret";
const SMOKE_TASK = "relay-production-smoke-v0473c-001";
const SMOKE_HASH = "2291c74e";
/** Another chain the relay must not disturb. */
const OTHER_TASK = "relay-reliable-ack-v047-001";
const OTHER_HASH = "b".repeat(64);

let sandboxRoot = "";
let ledgerFile = "";
let store: RelayStore;
let relay: ZhixingRelay;
let server: ControlServer;
let caseSeq = 0;

function fakeAudit(): AuditLog {
  return { write: async () => {} } as unknown as AuditLog;
}

function fakeBridge(): BridgeServer {
  return {
    hasClient: () => true,
    onMessage: () => {},
    send: async () => {},
    close: async () => {},
    start: async () => {},
  } as unknown as BridgeServer;
}

function fakeWorkbuddy(): WorkBuddyClient {
  return { init: async () => {}, online: async () => true } as unknown as WorkBuddyClient;
}

async function rows(): Promise<Record<string, unknown>[]> {
  try {
    const raw = await readFile(ledgerFile, "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function count(event: string): Promise<number> {
  return rows().then((all) => all.filter((row) => row.event === event).length);
}

/** The chain the production smoke really produced. */
async function seedSmokeChain(): Promise<void> {
  const log = new TaskLedger(pathToFileURL(ledgerFile));

  await log.append({ event: "TASK_PUBLISHED", taskId: SMOKE_TASK, taskFingerprint: SMOKE_HASH, source: "gpt" });
  await log.append({ event: "TASK_ACCEPTED", taskId: SMOKE_TASK, taskFingerprint: SMOKE_HASH, source: "relay" });
  await log.append({
    event: "DISPATCH_STARTED",
    taskId: SMOKE_TASK,
    taskFingerprint: SMOKE_HASH,
    dispatchId: `${SMOKE_TASK}#0`,
    attempt: 0,
    source: "relay",
  });
  await log.append({
    event: "INPUT_CONFIRMED",
    taskId: SMOKE_TASK,
    taskFingerprint: SMOKE_HASH,
    dispatchId: `${SMOKE_TASK}#0`,
    attempt: 0,
    source: "relay",
    detail: { expectedFingerprint: SMOKE_HASH, observedFingerprint: SMOKE_HASH, exactMatch: true },
  });
  await log.append({
    event: "SEND_CONFIRM_FAILED",
    taskId: SMOKE_TASK,
    taskFingerprint: SMOKE_HASH,
    dispatchId: `${SMOKE_TASK}#0`,
    attempt: 0,
    source: "relay",
    detail: { reason: "new_turn_wrong_task", observedMessageId: "20|WorkBuddy ... 已处理 ... 思考中" },
  });
}

/** A second chain that is genuinely orphaned, so blocking survives a close. */
async function seedOtherOrphan(): Promise<void> {
  const log = new TaskLedger(pathToFileURL(ledgerFile));

  await log.append({ event: "TASK_PUBLISHED", taskId: OTHER_TASK, taskFingerprint: OTHER_HASH, source: "gpt" });
  await log.append({
    event: "DISPATCH_STARTED",
    taskId: OTHER_TASK,
    taskFingerprint: OTHER_HASH,
    dispatchId: `${OTHER_TASK}#0`,
    attempt: 0,
    source: "relay",
  });
  await log.append({
    event: "SEND_CONFIRMED",
    taskId: OTHER_TASK,
    taskFingerprint: OTHER_HASH,
    dispatchId: `${OTHER_TASK}#0`,
    attempt: 0,
    source: "relay",
  });
}

/** Puts the relay in the production shape: holding the frozen smoke task. */
async function holdSmokeTask(stage: TaskExecutionStage = "RECONCILIATION_REQUIRED"): Promise<void> {
  await store.mutate((state) => {
    state.currentTask = {
      taskId: SMOKE_TASK,
      sourceFingerprint: SMOKE_HASH,
      taskFingerprint: SMOKE_HASH,
      dispatchId: `${SMOKE_TASK}#0`,
      attempt: 0,
      sourceText: "Production smoke test only.",
      startedAt: new Date().toISOString(),
      status: "sending",
      execution: createExecutionState({ stage, at: new Date().toISOString() }),
    };
    state.state = "WAIT_WORKBUDDY";
  });
}

async function post(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${server.url}${path}`, {
    method: "POST",
    headers: { [SECRET_HEADER]: SECRET },
  });

  return { status: response.status, body: await response.json() };
}

function close(taskId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return post(
    `/control/reconciliation/close?taskId=${taskId}` +
      `&disposition=close_without_resend&reason=WorkBuddy%20really%20ran%20it`,
  );
}

beforeAll(async () => {
  sandboxRoot = await mkdtemp(join(tmpdir(), "zxr-live-close-"));
});

beforeEach(async () => {
  caseSeq += 1;
  const dir = join(sandboxRoot, `case-${process.pid}-${caseSeq}`);

  store = new RelayStore(pathToFileURL(join(dir, "state.json")));
  await store.load();
  ledgerFile = join(dir, "ledger.jsonl");

  relay = new ZhixingRelay(
    { relay: {}, paths: { ledger: pathToFileURL(ledgerFile) } } as unknown as AppConfig,
    fakeBridge(),
    store,
    fakeAudit(),
    fakeWorkbuddy(),
    null,
  );
  await relay.init();

  server = await startControlServer({ control: relay, secret: SECRET, port: 0 });
});

afterAll(async () => {
  await server.close();
  await relay.dispose();
  await rm(sandboxRoot, { recursive: true, force: true });
});

describe("closing the live task the relay froze", () => {
  it("releases the frozen smoke task, records one closure, and sends nothing", async () => {
    await seedSmokeChain();
    await holdSmokeTask();
    // Something the close must leave exactly where it was.
    await store.enqueue({
      kind: "gpt_task",
      id: "p-next",
      text: "Next task in line.",
      fingerprint: "fp-next",
      createdAt: new Date().toISOString(),
    });

    const before = await rows();

    const { status, body } = await close(SMOKE_TASK);

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.blocked).toBe(false);

    const after = await rows();

    // One closure, task-scoped, and not a completion the relay never saw.
    expect(after.filter((row) => row.event === "RECONCILIATION_RESOLVED")).toHaveLength(1);
    const closure = after.find((row) => row.event === "RECONCILIATION_RESOLVED");
    expect(closure?.taskId).toBe(SMOKE_TASK);
    expect(closure?.taskFingerprint).toBe("*");
    expect((closure?.detail as { disposition?: unknown } | undefined)?.disposition).toBe(
      "close_without_resend",
    );

    /*
     * The whole point, written out: the task went out once, it did not go out
     * again, and nothing was fabricated to explain it away.
     */
    expect(await count("DISPATCH_STARTED")).toBe(1);
    expect(await count("TASK_REQUEUED")).toBe(0);
    expect(await count("SEND_CONFIRMED")).toBe(0);
    expect(await count("TASK_COMPLETED")).toBe(0);
    expect(await count("RESULT_RECEIVED")).toBe(0);
    expect(await count("RESULT_DELIVERED")).toBe(0);
    expect(await count("RESULT_ACKED")).toBe(0);
    expect(await count("TASK_ENQUEUED")).toBe(0);

    // The live record is gone, and the queue it was blocking is untouched.
    expect(relay.status().currentTask).toBeNull();
    expect(store.snapshot().pending.map((item: PendingItem) => item.id)).toEqual(["p-next"]);
    expect(relay.status().reconciliationHold).toBe(false);
    // The answer and `/control/status` must say the same thing.
    expect(body.blocked).toBe(relay.status().reconciliationHold);
    expect(after.length).toBeGreaterThan(before.length);
  });

  it("refuses to close a live task that is past the send", async () => {
    await seedSmokeChain();
    await holdSmokeTask("RUNNING_CONFIRMED");

    const { body } = await close(SMOKE_TASK);

    expect(body.ok).toBe(false);
    // Nothing was written for a task the relay refuses to decide about.
    expect(await count("RECONCILIATION_RESOLVED")).toBe(0);
    // And the live record was not touched.
    expect(store.snapshot().currentTask?.taskId).toBe(SMOKE_TASK);
    expect(store.snapshot().currentTask?.execution?.stage).toBe("RUNNING_CONFIRMED");
  });

  /*
   * The live record belongs to a different task, so this stays a historical
   * close: the named chain is closed, the live record is not ours to touch,
   * and the hold it is holding survives.
   */
  it("closes another chain without touching the live record", async () => {
    await seedSmokeChain();
    await seedOtherOrphan();
    await holdSmokeTask();

    const { status, body } = await close(OTHER_TASK);

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(await count("RECONCILIATION_RESOLVED")).toBe(1);

    // The live task the relay is holding was not closed by a decision about
    // some other chain.
    expect(store.snapshot().currentTask?.taskId).toBe(SMOKE_TASK);
    expect(store.snapshot().currentTask?.execution?.stage).toBe("RECONCILIATION_REQUIRED");
    expect(relay.status().reconciliationHold).toBe(true);
    expect(body.blocked).toBe(true);
  });

  it("closes one task and keeps the hold while another chain still blocks", async () => {
    await seedSmokeChain();
    await seedOtherOrphan();
    await holdSmokeTask();

    const { status, body } = await close(SMOKE_TASK);

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    // The named task is closed and released...
    expect(relay.status().currentTask).toBeNull();
    // ...but the other forgotten chain is still a blocker.
    expect(body.blocked).toBe(true);
    expect(relay.status().reconciliationHold).toBe(true);
    expect(body.findings as unknown[]).toContain(`orphaned_task:${OTHER_TASK}`);
  });
});
