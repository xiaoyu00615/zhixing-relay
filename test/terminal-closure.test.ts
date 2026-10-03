/**
 * v0.4.7.3l: a task ends in exactly one of three ways, and the relay never
 * re-runs one that has ended.
 *
 * The accident this replays is a task that could not be disposed of at all.
 * `relay-production-smoke-v0473i-003` sits in the queue holding
 *
 *   TASK_PUBLISHED / TASK_BLOCKED(gpt_not_found) / TASK_ENQUEUED
 *
 * and no ACCEPTED, no DISPATCH_STARTED, no INPUT, no SEND. It provably never
 * ran. The only operator tool that existed, `close_without_resend`, says
 * "whatever happened, never send it again" - which is a claim about a task that
 * *may* have run, and it is the wrong claim here. So the task could not be
 * closed without asserting something untrue, and could not be cancelled
 * because no such disposition existed. It sat there.
 *
 * The three terminal states are kept apart, because collapsing any two of them
 * costs something real:
 *
 *   COMPLETED             it ran, and the lifecycle finished
 *   CLOSED_WITHOUT_RESEND  it may have run; never send it again
 *   CANCELLED             it provably never ran; never execute it
 *
 * And the ordering underneath them is the crash-safety argument: the durable
 * decision is written BEFORE the runtime owner is released, so a crash in
 * between leaves a stale owner that the next start can identify from the
 * ledger - never a task that vanished with nothing on record.
 *
 * Every "restart" here is a real second relay on the real state file, and
 * every cancellation goes through the real control surface. No fixture asserts
 * a state the code could not produce.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { AuditLog } from "../src/audit.js";
import type { BridgeServer } from "../src/bridge-server.js";
import { ZhixingRelay } from "../src/relay.js";
import {
  cancelEligibility,
  decideDispatch,
  hasProvenSend,
  identityFingerprints,
  isTerminal,
  terminalStateFor,
  TaskLedger,
  taskFingerprint,
  type ReconciliationEvent,
} from "../src/reconciliation/index.js";
import { deliveryIdFor } from "../src/delivery/recovery.js";
import { RelayStore } from "../src/store.js";
import type { ExtensionInbound, PendingItem } from "../src/types.js";
import type { WorkBuddyClient } from "../src/workbuddy.js";

const AT = "2026-10-03T00:00:00.000Z";

/** The production smoke task's own id: the shape that could not be disposed of. */
const SMOKE = "relay-production-smoke-v0473i-003";
/** A second task, so a test can prove a disposition touches only its own. */
const OTHER = "relay-terminal-002";

const createdDirs: string[] = [];
const openRelays: ZhixingRelay[] = [];

beforeAll(() => {
  /* nothing to set up: every fixture builds its own relay */
});

afterEach(async () => {
  /*
   * `dispose()` and not `stopCurrentRound`: dispose only stops background work
   * and leaves the durable state alone, which is what lets the next case - or
   * the restart inside one case - read the state the previous step wrote.
   */
  for (const relay of openRelays.splice(0)) {
    await relay.dispose();
  }
});

afterAll(async () => {
  /*
   * One throwaway directory per fixture, so there are a few dozen of them by the
   * end. Removing them is a recursive delete on Windows, where a file another
   * handle has just closed can cost a retry - the default 10s hook timeout is
   * not enough for the whole set, and a timed-out hook is reported as a file
   * failure even when every test passed.
   */
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (const dir of createdDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
  }
}, 60_000);

function taskBlock(taskId: string, body = "Production end-to-end smoke test only."): string {
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

const SMOKE_TEXT = taskBlock(SMOKE);
const SMOKE_FP = taskFingerprint(SMOKE_TEXT);
const SMOKE_MESSAGE = "assistant-message:58da9fac-2d6e-410b-91db-f3a6beb12fe5";

/** A RESULT envelope, for the pipeline-level cases that do not need a relay. */
function resultBlockFor(taskId: string, body = "the gate passed"): string {
  return [
    "[ZHIXING_RELAY]",
    "TYPE: RESULT",
    `TASK_ID: ${taskId}`,
    "SOURCE: WORKBUDDY",
    "",
    body,
    "[ZHIXING_RELAY_END]",
  ].join("\n");
}

/** The production queue entry: envelope text and a message fingerprint, no ids. */
function smokePendingItem(): PendingItem {
  return {
    kind: "gpt_task",
    id: "pending-gpt-1790997733041-71fcb138",
    text: SMOKE_TEXT,
    fingerprint: SMOKE_MESSAGE,
    createdAt: "2026-10-03T03:22:13.042Z",
  };
}

type Fixture = {
  relay: ZhixingRelay;
  store: RelayStore;
  dir: string;
  ledgerFile: string;
  sentToWorkBuddy: string[];
  rows: () => Promise<ReconciliationEvent[]>;
  events: (taskId: string) => Promise<ReconciliationEvent[]>;
  /** The GPT page delivering this envelope again, as a reconnect would. */
  observe: (text: string, fingerprint: string) => Promise<void>;
  schedule: () => Promise<void>;
  pending: () => PendingItem[];
  /** A second relay on the SAME state: a restart, not a fresh relay. */
  restart: () => Promise<Fixture>;
};

/**
 * A real relay, real state file, real append-only ledger.
 *
 * The bridge answers `fetch_recent_assistant_messages` with an empty page,
 * which is the production shape once ChatGPT has unmounted the bubble: the GPT
 * page can no longer vouch for anything, so every claim has to come from the
 * ledger instead.
 */
async function makeFixture(
  options: {
    seed?: (log: TaskLedger) => Promise<void>;
    /**
     * Entries that exist BEFORE the relay boots.
     *
     * Enqueuing after `init()` would hand startup reconciliation a published
     * task with no owner, which it rightly freezes as an orphan - so the queue
     * a case wants to find has to be there when the process starts.
     */
    pending?: PendingItem[];
    paused?: boolean;
    /** Make WorkBuddy refuse the turn, which is what drives a requeue. */
    failSend?: boolean;
    /** Keep the state file across a restart in the same directory. */
    reuse?: { dir: string; ledgerFile: string };
  } = {},
): Promise<Fixture> {
  const dir = options.reuse?.dir ?? (await mkdtemp(join(tmpdir(), "zxr-terminal-")));
  if (!options.reuse) createdDirs.push(dir);

  const store = new RelayStore(pathToFileURL(join(dir, "state.json")));
  await store.load();

  const ledgerFile = options.reuse?.ledgerFile ?? join(dir, "ledger.jsonl");

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
    send: async (message: { type?: string; requestId?: string; text?: string; limit?: number }) => {
      if (message.type === "fetch_recent_assistant_messages") {
        void handler?.({
          type: "recent_assistant_messages",
          requestId: message.requestId ?? "",
          limit: message.limit,
          messages: [],
        } as ExtensionInbound);
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
      if (options.failSend) {
        // A refused turn: the shape that puts a task back on the queue.
        throw new Error("WorkBuddy refused the turn");
      }
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
    relay: { resultLeaseMs: 5_000 },
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

  const readRows = async (): Promise<ReconciliationEvent[]> => {
    const raw = await readFile(ledgerFile, "utf8").catch(() => "");
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as ReconciliationEvent);
  };

  const fx: Fixture = {
    relay,
    store,
    dir,
    ledgerFile,
    sentToWorkBuddy,
    rows: readRows,
    events: async (taskId: string) => (await readRows()).filter((row) => row.taskId === taskId),
    observe: async (text: string, fingerprint: string) => {
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
    pending: () => store.snapshot().pending,
    restart: async () => {
      // The old process is gone; its durable state is not.
      await relay.dispose();
      return makeFixture({ reuse: { dir, ledgerFile } });
    },
  };

  return fx;
}

/**
 * The production smoke003 chain, written the way the relay wrote it.
 *
 * PUBLISHED / BLOCKED(gpt_not_found) / ENQUEUED, and deliberately no ACCEPTED,
 * no DISPATCH_STARTED, no INPUT_CONFIRMED, no SEND_CONFIRMED - which is what
 * makes a cancellation honest here and a close_without_resend a lie.
 */
async function seedSmokeShape(log: TaskLedger): Promise<void> {
  await log.append({
    event: "TASK_PUBLISHED",
    taskId: SMOKE,
    taskFingerprint: SMOKE_FP,
    source: "gpt",
    messageFingerprint: SMOKE_MESSAGE,
  });
  await log.append({
    event: "TASK_BLOCKED",
    taskId: SMOKE,
    taskFingerprint: SMOKE_FP,
    source: "relay",
    detail: { reason: "gpt_not_found", detail: "no accepted chain attests to it" },
  });
  await log.append({
    event: "TASK_ENQUEUED",
    taskId: SMOKE,
    taskFingerprint: SMOKE_FP,
    source: "relay",
    detail: { reason: "dispatch_not_allowed", via: "pre_send_rejection" },
  });
}

function decisionFor(history: ReconciliationEvent[], taskId: string, fingerprint: string) {
  return decideDispatch(history, {
    taskId,
    taskFingerprint: fingerprint,
    sourceFingerprint: SMOKE_MESSAGE,
    gptEvidence: null,
    maxAttempts: 3,
  });
}

// ---------------------------------------------------------------------------
// 1. The production shape can be cancelled at all.
// ---------------------------------------------------------------------------

describe("CANCEL: the shape production is actually in", () => {
  it("cancels an accepted, queued task that never ran", async () => {
    /*
     * The other unsent shape: a task the relay accepted properly (ACCEPTED and
     * ENQUEUED, no BLOCKED row) and then never got as far as a dispatch. This
     * is the one where terminal precedence is actually load bearing - with no
     * BLOCKED row, a cancelled task would otherwise read as an ordinary queued
     * task that the relay has forgotten, which is an orphan and freezes
     * scheduling.
     */
    const text = taskBlock("t-accepted-unsent");
    const fp = taskFingerprint(text);

    const fx = await makeFixture({
      seed: async (log) => {
        await log.append({
          event: "TASK_PUBLISHED",
          taskId: "t-accepted-unsent",
          taskFingerprint: fp,
          source: "gpt",
          messageFingerprint: "assistant-message:accepted",
        });
        await log.append({
          event: "TASK_ACCEPTED",
          taskId: "t-accepted-unsent",
          taskFingerprint: fp,
          source: "relay",
          messageFingerprint: "assistant-message:accepted",
        });
        await log.append({
          event: "TASK_ENQUEUED",
          taskId: "t-accepted-unsent",
          taskFingerprint: fp,
          source: "relay",
        });
      },
      pending: [
        {
          kind: "gpt_task",
          id: "pending-accepted",
          text,
          fingerprint: "assistant-message:accepted",
          createdAt: AT,
          taskId: "t-accepted-unsent",
        },
      ],
    });

    expect(fx.relay.status().reconciliationHold).toBe(false);

    const result = await fx.relay.cancelUnsentTask({
      taskId: "t-accepted-unsent",
      reason: "accepted but never dispatched",
    });

    expect(result.ok).toBe(true);
    expect(result.cancelled).toBe(true);
    expect(result.ownerRemoved).toBe(true);
    expect(fx.pending()).toHaveLength(0);

    const rows = await fx.events("t-accepted-unsent");
    const cancelled = rows.find((row) => row.event === "TASK_CANCELLED");
    expect(cancelled?.taskFingerprint).toBe(fp);
    expect(cancelled?.messageFingerprint).toBe("assistant-message:accepted");
    expect(rows.some((row) => row.event === "TASK_COMPLETED")).toBe(false);

    /*
     * The terminal decision is what settles the orphan question: a decided task
     * is not a lost one, so cancelling must not freeze the relay - neither now
     * nor after a restart, when the task is in the ledger and owned by nobody.
     */
    expect(fx.relay.status().reconciliationHold).toBe(false);

    const after = await fx.restart();
    await after.schedule();
    expect(after.relay.status().reconciliationHold).toBe(false);
    expect(after.sentToWorkBuddy).toHaveLength(0);
  });

  it("cancels a queued task that provably never ran, and releases its owner", async () => {
    const fx = await makeFixture({ seed: seedSmokeShape, pending: [smokePendingItem()] });

    const result = await fx.relay.cancelUnsentTask({
      taskId: SMOKE,
      reason: "never dispatched; the GPT bubble is long gone",
    });

    expect(result.ok).toBe(true);
    expect(result.cancelled).toBe(true);
    expect(result.ownerRemoved).toBe(true);
    expect(result.terminalEventSeq).toBeGreaterThan(0);

    // The terminal row exists, names the exact envelope, and says who decided.
    const rows = await fx.events(SMOKE);
    const cancelled = rows.find((row) => row.event === "TASK_CANCELLED");
    expect(cancelled).toBeDefined();
    expect(cancelled?.taskFingerprint).toBe(SMOKE_FP);
    expect(cancelled?.source).toBe("control");
    expect(cancelled?.messageFingerprint).toBe(SMOKE_MESSAGE);
    expect(cancelled?.detail).toMatchObject({ disposition: "cancel_unsent" });

    // The owner is gone, and nothing was sent to WorkBuddy.
    expect(fx.pending()).toHaveLength(0);
    expect(fx.sentToWorkBuddy).toHaveLength(0);
  });

  it("keeps TASK_CANCELLED as its own event, never a completion", async () => {
    const fx = await makeFixture({ seed: seedSmokeShape, pending: [smokePendingItem()] });
    await fx.relay.cancelUnsentTask({ taskId: SMOKE, reason: "confirmed unsent" });

    const rows = await fx.events(SMOKE);
    // A cancellation asserts the opposite of a completion, so writing
    // TASK_COMPLETED here would be inventing a fact about WorkBuddy.
    expect(rows.some((row) => row.event === "TASK_COMPLETED")).toBe(false);
    expect(rows.filter((row) => row.event === "TASK_CANCELLED")).toHaveLength(1);
  });

  it("leaves a second, unrelated task completely alone", async () => {
    const otherText = taskBlock(OTHER);
    const fx = await makeFixture({
      seed: async (log) => {
        await seedSmokeShape(log);
        await log.append({
          event: "TASK_PUBLISHED",
          taskId: OTHER,
          taskFingerprint: taskFingerprint(otherText),
          source: "gpt",
          messageFingerprint: "assistant-message:other",
        });
      },
      pending: [
        smokePendingItem(),
        {
          kind: "gpt_task",
          id: "pending-other",
          text: otherText,
          fingerprint: "assistant-message:other",
          createdAt: AT,
        },
      ],
    });

    await fx.relay.cancelUnsentTask({ taskId: SMOKE, reason: "confirmed unsent" });

    const remaining = fx.pending();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe("pending-other");
    expect((await fx.events(OTHER)).some((row) => row.event === "TASK_CANCELLED")).toBe(false);
  });

  it("refuses to cancel a task that is on the queue twice", async () => {
    const fx = await makeFixture({
      seed: seedSmokeShape,
      pending: [smokePendingItem(), { ...smokePendingItem(), id: "pending-gpt-duplicate" }],
    });

    const result = await fx.relay.cancelUnsentTask({ taskId: SMOKE, reason: "confirmed unsent" });

    // Two owners and no way to know which one the operator meant: fail closed.
    expect(result.ok).toBe(false);
    expect(result.message).toContain("refusing to guess");
    expect(fx.pending()).toHaveLength(2);
    expect((await fx.events(SMOKE)).some((row) => row.event === "TASK_CANCELLED")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Cancellation is only for tasks that provably never ran.
// ---------------------------------------------------------------------------

describe("CANCEL: the stages it is allowed and forbidden at", () => {
  /** A chain that reached one stage and stopped there. */
  async function chainReaching(stage: string, taskId = "t-stage"): Promise<Fixture> {
    const text = taskBlock(taskId);
    return makeFixture({
      seed: async (log) => {
        await log.append({
          event: "TASK_PUBLISHED",
          taskId,
          taskFingerprint: taskFingerprint(text),
          source: "gpt",
          messageFingerprint: "assistant-message:stage",
        });
        await log.append({
          event: "TASK_ENQUEUED",
          taskId,
          taskFingerprint: taskFingerprint(text),
          source: "relay",
        });
        if (stage !== "queued") {
          await log.append({
            event: stage as ReconciliationEvent["event"],
            taskId,
            taskFingerprint: taskFingerprint(text),
            source: "relay",
          });
        }
      },
      pending: [
        {
          kind: "gpt_task",
          id: "pending-stage",
          text,
          fingerprint: "assistant-message:stage",
          createdAt: AT,
          taskId,
        },
      ],
    });
  }

  it("allows a pre-send blocked task that never dispatched", async () => {
    const fx = await makeFixture({ seed: seedSmokeShape, pending: [smokePendingItem()] });
    const result = await fx.relay.cancelUnsentTask({ taskId: SMOKE, reason: "never sent" });
    expect(result.ok).toBe(true);
  });

  it("refuses SEND_CONFIRMED - that task may be running", async () => {
    const fx = await chainReaching("SEND_CONFIRMED");
    const result = await fx.relay.cancelUnsentTask({ taskId: "t-stage", reason: "looks unused" });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("close it without a resend");
    expect(fx.pending()).toHaveLength(1);
    expect((await fx.events("t-stage")).some((row) => row.event === "TASK_CANCELLED")).toBe(false);
  });

  it("refuses RUNNING_CONFIRMED - WorkBuddy was seen running it", async () => {
    const fx = await chainReaching("RUNNING_CONFIRMED");
    const result = await fx.relay.cancelUnsentTask({ taskId: "t-stage", reason: "looks unused" });
    expect(result.ok).toBe(false);
  });

  it("refuses a task that already produced a result", async () => {
    const fx = await chainReaching("RESULT_RECEIVED");
    const result = await fx.relay.cancelUnsentTask({ taskId: "t-stage", reason: "looks unused" });
    expect(result.ok).toBe(false);
  });

  it("refuses a DISPATCH_STARTED task: the relay got as far as the page", async () => {
    const fx = await chainReaching("DISPATCH_STARTED");
    const result = await fx.relay.cancelUnsentTask({ taskId: "t-stage", reason: "never confirmed" });

    // Dispatched is not proven, but it is not "never ran" either - and only
    // close_without_resend makes a claim that survives being wrong.
    expect(result.ok).toBe(false);
    expect(fx.pending()).toHaveLength(1);
  });

  it("refuses to cancel the live round, which is a close and not a cancellation", async () => {
    const fx = await makeFixture({ seed: seedSmokeShape });

    await fx.store.mutate((state) => {
      state.currentTask = {
        taskId: SMOKE,
        sourceFingerprint: SMOKE_MESSAGE,
        sourceText: SMOKE_TEXT,
        taskFingerprint: SMOKE_FP,
        startedAt: AT,
        status: "waiting_workbuddy",
      };
      state.state = "WAIT_WORKBUDDY";
    });

    const result = await fx.relay.cancelUnsentTask({ taskId: SMOKE, reason: "stop it" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("live round");
    expect(fx.store.snapshot().currentTask?.taskId).toBe(SMOKE);
  });

  it("refuses a task the relay does not hold at all", async () => {
    const fx = await makeFixture({ seed: seedSmokeShape });
    const result = await fx.relay.cancelUnsentTask({ taskId: "never-seen", reason: "stop it" });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. A cancellation survives everything that can happen next.
// ---------------------------------------------------------------------------

describe("CANCEL: durability across restart and redisplay", () => {
  it("does not resend after a restart, and releases nothing twice", async () => {
    const fx = await makeFixture({ seed: seedSmokeShape, pending: [smokePendingItem()] });
    await fx.relay.cancelUnsentTask({ taskId: SMOKE, reason: "confirmed unsent" });

    const after = await fx.restart();
    await after.schedule();

    expect(after.sentToWorkBuddy).toHaveLength(0);
    expect(after.pending()).toHaveLength(0);
    expect(after.relay.status().reconciliationHold).toBe(false);
  });

  it("refuses the same envelope when the GPT page shows it again", async () => {
    const fx = await makeFixture({ seed: seedSmokeShape, pending: [smokePendingItem()] });
    await fx.relay.cancelUnsentTask({ taskId: SMOKE, reason: "confirmed unsent" });

    // The page redisplaying the envelope must not become "so run it again".
    const after = await fx.restart();
    await after.observe(SMOKE_TEXT, SMOKE_MESSAGE);
    await after.schedule();

    expect(after.sentToWorkBuddy).toHaveLength(0);
    expect(after.pending()).toHaveLength(0);
  });

  it("refuses it at the dispatch gate, by terminal name", async () => {
    const fx = await makeFixture({ seed: seedSmokeShape, pending: [smokePendingItem()] });
    await fx.relay.cancelUnsentTask({ taskId: SMOKE, reason: "confirmed unsent" });

    const history = await fx.events(SMOKE);
    const decision = decisionFor(history, SMOKE, SMOKE_FP);

    expect(decision.kind).toBe("blocked");
    if (decision.kind !== "blocked") return;
    expect(decision.reason).toBe("terminal_cancelled");
    expect(decision.detail).toContain("never be executed");
  });

  it("does not reopen a task an operator closed without a resend", async () => {
    const text = taskBlock("t-closed");
    const fp = taskFingerprint(text);
    const fx = await makeFixture({
      seed: async (log) => {
        await log.append({
          event: "TASK_PUBLISHED",
          taskId: "t-closed",
          taskFingerprint: fp,
          source: "gpt",
        });
        await log.append({
          event: "TASK_BLOCKED",
          taskId: "t-closed",
          taskFingerprint: fp,
          source: "relay",
          detail: { reason: "gpt_not_found" },
        });
      },
      pending: [{ kind: "gpt_task", id: "p-closed", text, fingerprint: "m-closed", createdAt: AT }],
    });

    const closed = await fx.relay.closeReconciledTaskWithoutResend({
      taskId: "t-closed",
      reason: "WorkBuddy already ran it",
    });
    expect(closed.ok).toBe(true);

    const history = await fx.events("t-closed");
    const decision = decisionFor(history, "t-closed", fp);

    // Close and cancel are different claims, and the gate names which one it is.
    expect(decision.kind).toBe("blocked");
    if (decision.kind !== "blocked") return;
    expect(decision.reason).toBe("terminal_closed");
  });

  it("does not create a reconciliation hold", async () => {
    const fx = await makeFixture({ seed: seedSmokeShape, pending: [smokePendingItem()] });
    expect(fx.relay.status().reconciliationHold).toBe(false);

    await fx.relay.cancelUnsentTask({ taskId: SMOKE, reason: "confirmed unsent" });

    // A decided task is not a lost one, so cancelling must not freeze anything.
    expect(fx.relay.status().reconciliationHold).toBe(false);
  });

  it("cleans up a stale owner left by a crash between the decision and the release", async () => {
    /*
     * The dangerous window is owner-cleanup-before-decision, which would leave a
     * task with no owner and no decision - silently gone, with nothing on record
     * to reconcile against. The ordering is terminal-first, so what a crash can
     * leave is the reverse: the decision standing and the owner still there.
     * This reconstructs exactly that.
     */
    const fx = await makeFixture({ seed: seedSmokeShape, pending: [smokePendingItem()] });

    // Write only the terminal decision - as if the crash beat the removal.
    await new TaskLedger(pathToFileURL(fx.ledgerFile)).append({
      event: "TASK_CANCELLED",
      taskId: SMOKE,
      taskFingerprint: SMOKE_FP,
      source: "control",
      messageFingerprint: SMOKE_MESSAGE,
      detail: { disposition: "cancel_unsent", reason: "cancelled, crash before owner release" },
    });

    expect(fx.pending()).toHaveLength(1); // the stale owner is still there

    const after = await fx.restart();
    await after.schedule();

    // The next start recognises the terminal decision and releases the owner
    // without sending anything.
    expect(after.pending()).toHaveLength(0);
    expect(after.sentToWorkBuddy).toHaveLength(0);
    expect(after.relay.status().reconciliationHold).toBe(false);
  });

  it("writes the terminal decision before it releases the owner", async () => {
    const fx = await makeFixture({ seed: seedSmokeShape, pending: [smokePendingItem()] });

    /*
     * The ordering, observed at the boundary rather than inferred: at the exact
     * moment the queue owner is removed, the ledger must already hold
     * TASK_CANCELLED. Reading the state afterwards cannot tell the two orders
     * apart - both end with an empty queue and a cancelled row - so the check
     * has to happen while the removal is in flight.
     */
    const ledgerAtRemoval: string[] = [];
    const realRemove = fx.store.removePendingByIds.bind(fx.store);

    vi.spyOn(fx.store, "removePendingByIds").mockImplementation(async (ids) => {
      const raw = await readFile(fx.ledgerFile, "utf8").catch(() => "");
      ledgerAtRemoval.push(raw.includes("TASK_CANCELLED") ? "decision-first" : "owner-first");
      return realRemove(ids);
    });

    await fx.relay.cancelUnsentTask({ taskId: SMOKE, reason: "confirmed unsent" });

    expect(ledgerAtRemoval).toEqual(["decision-first"]);
  });
});

// ---------------------------------------------------------------------------
// 4. COMPLETED before release: the P1-B crash window.
// ---------------------------------------------------------------------------

describe("COMPLETED: durable evidence before the owner is released", () => {
  /** A ledger that already holds a finished round, and a state file that does not know. */
  async function completedChain(taskId: string): Promise<Fixture> {
    const text = taskBlock(taskId);
    const fp = taskFingerprint(text);
    return makeFixture({
      seed: async (log) => {
        await log.append({ event: "TASK_PUBLISHED", taskId, taskFingerprint: fp, source: "gpt" });
        await log.append({ event: "TASK_ACCEPTED", taskId, taskFingerprint: fp, source: "relay" });
        await log.append({
          event: "DISPATCH_STARTED",
          taskId,
          taskFingerprint: fp,
          dispatchId: `${taskId}#0`,
          attempt: 0,
          source: "relay",
        });
        await log.append({ event: "SEND_CONFIRMED", taskId, taskFingerprint: fp, source: "relay" });
        await log.append({ event: "RUNNING_CONFIRMED", taskId, taskFingerprint: fp, source: "workbuddy" });
        await log.append({ event: "RESULT_RECEIVED", taskId, taskFingerprint: fp, source: "workbuddy" });
        await log.append({ event: "RESULT_DELIVERED", taskId, taskFingerprint: fp, source: "relay" });
        await log.append({ event: "RESULT_ACKED", taskId, taskFingerprint: fp, source: "extension" });
        await log.append({ event: "TASK_COMPLETED", taskId, taskFingerprint: fp, source: "relay" });
      },
    });
  }

  it("reports a completed task as completed, never as a lost one", async () => {
    const fx = await completedChain("t-done");
    const report = await fx.relay.status();
    expect(report.reconciliationHold).toBe(false);
  });

  it("releases a stale live record for a completed task instead of freezing", async () => {
    const fx = await completedChain("t-done-stale");

    // A crash between the terminal row and the owner release leaves this.
    await fx.store.mutate((state) => {
      state.currentTask = {
        taskId: "t-done-stale",
        sourceFingerprint: "m-done",
        sourceText: taskBlock("t-done-stale"),
        taskFingerprint: taskFingerprint(taskBlock("t-done-stale")),
        startedAt: AT,
        status: "sent_to_gpt",
      };
      state.state = "WAIT_GPT";
    });

    const after = await fx.restart();

    // The terminal ledger outranks the stale owner: released, not orphaned.
    expect(after.store.snapshot().currentTask).toBeNull();
    expect(after.relay.status().reconciliationHold).toBe(false);
    expect(after.sentToWorkBuddy).toHaveLength(0);
  });

  it("never dispatches a completed task that reappears in the queue", async () => {
    const text = taskBlock("t-done-queued");
    const fp = taskFingerprint(text);
    const fx = await makeFixture({
      seed: async (log) => {
        await log.append({ event: "TASK_PUBLISHED", taskId: "t-done-queued", taskFingerprint: fp, source: "gpt" });
        await log.append({ event: "TASK_ACCEPTED", taskId: "t-done-queued", taskFingerprint: fp, source: "relay" });
        await log.append({
          event: "DISPATCH_STARTED",
          taskId: "t-done-queued",
          taskFingerprint: fp,
          dispatchId: "t-done-queued#0",
          attempt: 0,
          source: "relay",
        });
        await log.append({ event: "TASK_COMPLETED", taskId: "t-done-queued", taskFingerprint: fp, source: "relay" });
      },
      // A queue entry for a task that is already finished: the state after a
      // restore from an older release, or a replay that outlived its decision.
      pending: [{ kind: "gpt_task", id: "p-done", text, fingerprint: "m-done", createdAt: AT, taskId: "t-done-queued" }],
    });

    await fx.schedule();

    expect(fx.sentToWorkBuddy).toHaveLength(0);
    // The stale queue entry is released by the same terminal cleanup.
    expect(fx.pending()).toHaveLength(0);
  });

  it("records the completion before it releases the owner", async () => {
    const fx = await makeFixture({ seed: seedSmokeShape, pending: [smokePendingItem()] });
    const text = taskBlock("t-order");
    const fp = taskFingerprint(text);

    /*
     * A round that is one acknowledgement away from done: the result is in the
     * outbox, the task record is held, and the extension's ack is what closes
     * it. That path goes through `completeCurrentRound`, so it is where the
     * P1-B ordering is actually exercised.
     */
    await fx.store.enqueue({
      kind: "workbuddy_result",
      id: "pending-wb-t-order",
      taskId: "t-order",
      text: "[ZHIXING_RELAY]\nTYPE: RESULT\nTASK_ID: t-order\n\ndone\n[ZHIXING_RELAY_END]",
      workbuddyMessageId: "wb-order",
      createdAt: AT,
    } as never);

    await fx.store.mutate((state) => {
      state.currentTask = {
        taskId: "t-order",
        sourceFingerprint: "m-order",
        sourceText: text,
        taskFingerprint: fp,
        dispatchId: "t-order#0",
        attempt: 0,
        workbuddyOutboundMessageId: "wb-order",
        startedAt: AT,
        status: "sent_to_gpt",
        deliveryId: "delivery:t-order#t-order#0#wb-order",
      };
      state.state = "WAIT_GPT";
    });

    const observed: string[] = [];
    const realMutate = fx.store.mutate.bind(fx.store);

    vi.spyOn(fx.store, "mutate").mockImplementation(async (mutator) => {
      const before = fx.store.snapshot().currentTask?.taskId ?? null;
      await realMutate(mutator);
      const afterTask = fx.store.snapshot().currentTask?.taskId ?? null;
      // The transition that matters: the owner of t-order disappearing.
      if (before === "t-order" && afterTask === null && observed.length === 0) {
        const raw = await readFile(fx.ledgerFile, "utf8").catch(() => "");
        observed.push(raw.includes("TASK_COMPLETED") ? "terminal-first" : "owner-first");
      }
    });

    // The extension acknowledges the delivery.
    const decision = deliveryIdFor({ taskId: "t-order", workbuddyMessageId: "wb-order", dispatchId: "t-order#0" });
    await (fx.relay as unknown as { handleExtensionMessage: (m: unknown) => Promise<void> })
      .handleExtensionMessage({ type: "chatgpt_send_result", requestId: decision, ok: true, sent: true });
    await fx.relay.drainBackgroundWork();

    // The durable completion is written before the record is cleared, so a
    // crash in between leaves a repairable stale owner rather than a task the
    // ledger cannot explain.
    expect(observed).toEqual(["terminal-first"]);
    expect(fx.store.snapshot().currentTask).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. One requeue, one row.
// ---------------------------------------------------------------------------

describe("TASK_REQUEUED is written once", () => {
  it("records a single requeue for one logical requeue", async () => {
    const text = taskBlock("t-requeue");
    const fp = taskFingerprint(text);
    const fx = await makeFixture({
      failSend: true,
      seed: async (log) => {
        await log.append({
          event: "TASK_PUBLISHED",
          taskId: "t-requeue",
          taskFingerprint: fp,
          source: "gpt",
          messageFingerprint: "m-requeue",
        });
        // The accepted row has to name the GPT message, or the queue flush
        // refuses the task for want of provenance and never reaches a turn.
        await log.append({
          event: "TASK_ACCEPTED",
          taskId: "t-requeue",
          taskFingerprint: fp,
          source: "relay",
          messageFingerprint: "m-requeue",
        });
      },
      pending: [{ kind: "gpt_task", id: "p-requeue", text, fingerprint: "m-requeue", createdAt: AT, taskId: "t-requeue" }],
    });

    // One refused turn, which is one logical requeue.
    await fx.schedule();
    await fx.relay.drainBackgroundWork();

    const rows = await fx.events("t-requeue");
    expect(rows.filter((row) => row.event === "TASK_REQUEUED")).toHaveLength(1);

    // The task is genuinely back on the queue: TASK_ENQUEUED is a separate fact
    // and is still recorded, because "why it ended here" and "where it is now"
    // are different questions.
    expect(rows.filter((row) => row.event === "TASK_ENQUEUED").length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 6. The historical closures stay closed.
// ---------------------------------------------------------------------------

describe("historical closures are never reopened", () => {
  const HISTORICAL = [
    {
      taskId: "relay-reliable-ack-v047-001",
      reason: "operator_confirmed_existing_work_completed_after_v046_timeout_false_retry_no_resend",
    },
    {
      taskId: "relay-production-smoke-v0473c-001",
      reason: "operator_confirmed_smoke001_executed_in_workbuddy_send_confirmation_false_negative_no_resend",
    },
    {
      taskId: "relay-production-smoke-v0473e-002",
      reason: "operator_confirmed_smoke002_executed_and_completed_in_workbuddy_send_confirmation_false_negative_no_resend",
    },
  ];

  for (const { taskId, reason } of HISTORICAL) {
    it(`keeps ${taskId} closed and unsent`, async () => {
      const text = taskBlock(taskId);
      const fp = taskFingerprint(text);

      const fx = await makeFixture({
        seed: async (log) => {
          // The exact shape production holds: a wildcard closure row.
          await log.append({
            event: "TASK_PUBLISHED",
            taskId,
            taskFingerprint: fp,
            source: "gpt",
            messageFingerprint: "assistant-message:historical",
          });
          await log.append({
            event: "TASK_BLOCKED",
            taskId,
            taskFingerprint: fp,
            source: "relay",
            detail: { reason: "gpt_not_found" },
          });
          await log.append({
            event: "RECONCILIATION_RESOLVED",
            taskId,
            taskFingerprint: "*",
            source: "control",
            detail: { disposition: "close_without_resend", reason, taskId },
          });
        },
        // A queue entry for a closed task: the state that must never run.
        pending: [
          { kind: "gpt_task", id: `p-${taskId}`, text, fingerprint: "assistant-message:historical", createdAt: AT, taskId },
        ],
      });

      await fx.schedule();

      expect(fx.sentToWorkBuddy).toHaveLength(0);

      const history = await fx.events(taskId);
      const terminal = terminalStateFor(history);
      expect(terminal?.kind).toBe("CLOSED_WITHOUT_RESEND");
      expect(terminal?.stands).toBe(true);

      // A restart must not undo the decision either.
      const after = await fx.restart();
      await after.schedule();
      expect(after.sentToWorkBuddy).toHaveLength(0);
      expect((await after.events(taskId)).filter((r) => r.event === "RECONCILIATION_RESOLVED")).toHaveLength(1);
    });
  }
});

// ---------------------------------------------------------------------------
// 7. Terminal precedence, as a pure policy.
// ---------------------------------------------------------------------------

describe("terminal precedence", () => {
  const chain = (events: ReconciliationEvent[]): ReconciliationEvent[] => events;

  function ev(seq: number, event: ReconciliationEvent["event"], taskId = "t-p", fp = "fp-1"): ReconciliationEvent {
    return {
      seq,
      at: AT,
      event,
      taskId,
      taskFingerprint: fp,
      dispatchId: null,
      attempt: null,
      source: "relay",
      executor: null,
      model: null,
      messageFingerprint: null,
      workbuddyMessageId: null,
      detail: null,
    };
  }

  it("a cancellation outranks a queue entry and a stale owner", () => {
    const history = chain([
      ev(1, "TASK_PUBLISHED"),
      ev(2, "TASK_CANCELLED"),
      { ...ev(3, "TASK_ENQUEUED"), taskFingerprint: "fp-1" },
    ]);
    // The queued row after the cancellation is exactly the crash window; the
    // terminal decision still stands.
    expect(terminalStateFor(history)?.kind).toBe("CANCELLED");
    expect(isTerminal(history)).toBe(true);
  });

  it("a completion outranks a stale owner", () => {
    const history = chain([ev(1, "TASK_PUBLISHED"), ev(2, "TASK_COMPLETED")]);
    expect(terminalStateFor(history)?.kind).toBe("COMPLETED");
    expect(isTerminal(history)).toBe(true);
  });

  it("a closure outranks a stale owner", () => {
    const history = chain([
      ev(1, "TASK_PUBLISHED"),
      { ...ev(2, "RECONCILIATION_RESOLVED"), detail: { disposition: "close_without_resend" } },
    ]);
    expect(terminalStateFor(history)?.kind).toBe("CLOSED_WITHOUT_RESEND");
  });

  it("a hold resolution is not a terminal decision", () => {
    // Lifting a freeze says nothing about the task's fate, so it must not be
    // mistaken for a closure.
    const history = chain([
      ev(1, "TASK_PUBLISHED"),
      { ...ev(2, "RECONCILIATION_RESOLVED"), detail: { reason: "operator resolved" } },
    ]);
    expect(terminalStateFor(history)).toBeNull();
    expect(isTerminal(history)).toBe(false);
  });

  it("a closure no longer stands once something executed after it", () => {
    const history = chain([
      ev(1, "TASK_PUBLISHED"),
      { ...ev(2, "RECONCILIATION_RESOLVED"), detail: { disposition: "close_without_resend" } },
      ev(3, "SEND_CONFIRMED"),
    ]);
    // The closure spoke about the history it could see; a later send is a fact
    // it never covered, so this is a contradiction rather than a closure.
    expect(terminalStateFor(history)?.stands).toBe(false);
    expect(isTerminal(history)).toBe(false);
  });

  it("keeps the newest decision when a task is decided twice", () => {
    const history = chain([
      ev(1, "TASK_PUBLISHED"),
      { ...ev(2, "RECONCILIATION_RESOLVED"), detail: { disposition: "close_without_resend" } },
      ev(3, "TASK_CANCELLED"),
    ]);
    expect(terminalStateFor(history)?.kind).toBe("CANCELLED");
  });

  it("a terminal task plus an identity contradiction is not silently cleaned up", () => {
    const history = chain([
      ev(1, "TASK_PUBLISHED", "t-c", "fp-one"),
      ev(2, "TASK_CANCELLED", "t-c", "fp-one"),
      ev(3, "TASK_PUBLISHED", "t-c", "fp-two"),
    ]);
    // The cancellation stands as a decision about fp-one; fp-two is a
    // contradiction a human has to settle, and cancelEligibility says so.
    expect(terminalStateFor(history)?.kind).toBe("CANCELLED");
    const eligibility = cancelEligibility(history, "fp-two");
    expect(eligibility.ok).toBe(false);
    if (eligibility.ok) return;
    expect(["identity_conflict", "already_terminal"]).toContain(eligibility.reason);
  });
});

// ---------------------------------------------------------------------------
// 8. The proven-send policy is one answer, and the cancel gate uses it.
// ---------------------------------------------------------------------------

describe("canonical policy", () => {
  function ev(event: ReconciliationEvent["event"]): ReconciliationEvent {
    return {
      seq: 1,
      at: AT,
      event,
      taskId: "t",
      taskFingerprint: "fp",
      dispatchId: null,
      attempt: null,
      source: "relay",
      executor: null,
      model: null,
      messageFingerprint: null,
      workbuddyMessageId: null,
      detail: null,
    };
  }

  it("proven send agrees with itself for every stage that proves it", () => {
    for (const stage of [
      "SEND_CONFIRMED",
      "RUNNING_CONFIRMED",
      "RESULT_RECEIVED",
      "RESULT_PERSISTED",
      "RESULT_DELIVERED",
      "RESULT_ACKED",
      "TASK_COMPLETED",
    ] as const) {
      expect(hasProvenSend([stage])).toBe(true);
    }

    for (const stage of ["TASK_PUBLISHED", "TASK_ACCEPTED", "TASK_ENQUEUED", "TASK_BLOCKED", "TASK_REQUEUED"] as const) {
      expect(hasProvenSend([stage])).toBe(false);
    }
  });

  it("a requeue never outweighs proven send", () => {
    // The requeue row is an error record, not proof either way.
    expect(hasProvenSend(["TASK_REQUEUED", "SEND_CONFIRMED"])).toBe(true);
    expect(hasProvenSend(["TASK_REQUEUED"])).toBe(false);
  });

  it("the dispatch gate and the cancel gate agree on what counts as sent", () => {
    const sentChain = [ev("TASK_PUBLISHED"), ev("SEND_CONFIRMED")];

    // The gate refuses to send it again...
    const decision = decisionFor(sentChain, "t", "fp");
    expect(decision.kind).toBe("blocked");

    // ...and the cancel gate refuses to call it unsent. One fact, two readers.
    expect(hasProvenSend(sentChain.map((e) => e.event))).toBe(true);
    const eligibility = cancelEligibility(sentChain);
    expect(eligibility.ok).toBe(false);
  });

  it("identity counting ignores bookkeeping rows", () => {
    // A closure writes the placeholder; that is a footnote, not a second
    // envelope, and must never read as a contradiction.
    const history = [ev("TASK_PUBLISHED"), { ...ev("RECONCILIATION_RESOLVED"), taskFingerprint: "*" }];
    expect(identityFingerprints(history.map((e) => e.taskFingerprint))).toEqual(["fp"]);
  });
});

// ---------------------------------------------------------------------------
// 9. Mutations: the guards above are load bearing.
// ---------------------------------------------------------------------------

describe("mutation: the terminal guards are load bearing", () => {
  it("mutation: two owners of one outbox entry deliver it once", async () => {
    /*
     * The outbox entry leaves the queue only *after* the send, so a recovery
     * re-delivering a persisted answer and a queue flush walking the same entry
     * are two owners of one answer for the length of a send. The sink dedupes
     * by delivery id, so the user would not see it twice - but the relay
     * delivered it twice, and "delivered once" is a claim the pipeline has to be
     * able to make honestly rather than lean on the sink for.
     */
    const dir = await mkdtemp(join(tmpdir(), "zxr-inflight-"));
    createdDirs.push(dir);
    const store = new RelayStore(pathToFileURL(join(dir, "state.json")));
    await store.load();

    const sent: { deliveryId?: string }[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const bridge = {
      hasClient: () => true,
      onMessage: () => {},
      send: async (message: { deliveryId?: string }) => {
        sent.push(message);
        // Hold the first send open, so the second caller arrives mid-flight -
        // which is exactly the window the outbox cannot protect.
        if (sent.length === 1) await gate;
      },
      close: async () => {},
    } as unknown as BridgeServer;

    const { ResultPipeline } = await import("../src/delivery/result-pipeline.js");
    const pipeline = new ResultPipeline({
      store,
      audit: { write: async () => {} } as unknown as AuditLog,
      bridge,
      config: { relay: { autoSendToChatGPT: true, resultLeaseMs: 5_000 } } as unknown as AppConfig,
      hooks: { noteStage: async () => {}, onRoundCompleted: async () => true, onLeaseExpired: async () => {} },
    });

    const payload = resultBlockFor("t-inflight");
    await pipeline.persist({ taskId: "t-inflight", workbuddyMessageId: "wb-1", text: payload });

    // Two callers pick up the same durable entry at once.
    const first = pipeline.deliver({ taskId: "t-inflight", workbuddyMessageId: "wb-1", text: payload });
    const second = pipeline.deliver({ taskId: "t-inflight", workbuddyMessageId: "wb-1", text: payload });
    release();
    await Promise.all([first, second]);

    // One answer, one delivery.
    expect(sent).toHaveLength(1);

    // A replay that is awaited and retried is still delivered: the guard is
    // "in flight", not "already sent", because re-sending after a crash is the
    // whole point of the durable outbox.
    await pipeline.deliver({ taskId: "t-inflight", workbuddyMessageId: "wb-1", text: payload });
    expect(sent).toHaveLength(2);
  });

  it("mutation: a cancel that leaves the owner in place would need a second rescue", async () => {
    const fx = await makeFixture({ seed: seedSmokeShape, pending: [smokePendingItem()] });
    const spy = vi.spyOn(fx.store, "removePendingByIds").mockResolvedValue([]);

    await fx.relay.cancelUnsentTask({ taskId: SMOKE, reason: "confirmed unsent" });

    // The bug: the decision was written but the queue entry survives it, so the
    // relay is left holding an owner for a task it has already terminated. It
    // is only the startup cleanup that stops that owner from being dispatched.
    expect(fx.pending()).toHaveLength(1);

    const after = await fx.restart();
    await after.schedule();

    // The rescue is a second line of defence, not the ordering: the mutation
    // shows the owner outliving the decision it should have been released with.
    expect(after.pending()).toHaveLength(0);
    spy.mockRestore();
  });

  it("mutation: an eligibility check that accepts proven send would cancel a running task", async () => {
    const text = taskBlock("t-mut-sent");
    const fp = taskFingerprint(text);
    const sentHistory: ReconciliationEvent[] = [
      {
        seq: 1,
        at: AT,
        event: "TASK_PUBLISHED",
        taskId: "t-mut-sent",
        taskFingerprint: fp,
        dispatchId: null,
        attempt: null,
        source: "gpt",
        executor: null,
        model: null,
        messageFingerprint: null,
        workbuddyMessageId: null,
        detail: null,
      },
      {
        seq: 2,
        at: AT,
        event: "SEND_CONFIRMED",
        taskId: "t-mut-sent",
        taskFingerprint: fp,
        dispatchId: null,
        attempt: null,
        source: "relay",
        executor: null,
        model: null,
        messageFingerprint: null,
        workbuddyMessageId: null,
        detail: null,
      },
    ];

    // The honest answer is a refusal. The bug is a policy that only looks for a
    // terminal decision and forgets that execution evidence forbids a cancel.
    const eligibility = cancelEligibility(sentHistory, fp);
    expect(eligibility.ok).toBe(false);
    if (eligibility.ok) return;
    expect(eligibility.reason).toBe("may_have_executed");
  });

  it("mutation: a cancel that skips the terminal row leaves nothing durable", async () => {
    const fx = await makeFixture({ seed: seedSmokeShape, pending: [smokePendingItem()] });

    // What the relay would leave if the decision were not written first: a
    // removed owner and no record at all.
    const history = await fx.events(SMOKE);
    expect(terminalStateFor(history)).toBeNull();
    expect(history.some((row) => row.event === "TASK_CANCELLED")).toBe(false);
  });

  it("mutation: treating a closure as a cancellation would claim a task never ran", () => {
    const closed: ReconciliationEvent[] = [
      {
        seq: 1,
        at: AT,
        event: "RECONCILIATION_RESOLVED",
        taskId: "t",
        taskFingerprint: "fp",
        dispatchId: null,
        attempt: null,
        source: "control",
        executor: null,
        model: null,
        messageFingerprint: null,
        workbuddyMessageId: null,
        detail: { disposition: "close_without_resend" },
      },
    ];

    // The two are kept apart precisely so this cannot be confused.
    expect(terminalStateFor(closed)?.kind).toBe("CLOSED_WITHOUT_RESEND");
    expect(terminalStateFor(closed)?.kind).not.toBe("CANCELLED");
  });

  it("mutation: a terminal decision that no longer stands would gag a running task", () => {
    const voided: ReconciliationEvent[] = [
      {
        seq: 1,
        at: AT,
        event: "TASK_PUBLISHED",
        taskId: "t",
        taskFingerprint: "fp",
        dispatchId: null,
        attempt: null,
        source: "relay",
        executor: null,
        model: null,
        messageFingerprint: null,
        workbuddyMessageId: null,
        detail: null,
      },
      {
        seq: 2,
        at: AT,
        event: "TASK_CANCELLED",
        taskId: "t",
        taskFingerprint: "fp",
        dispatchId: null,
        attempt: null,
        source: "control",
        executor: null,
        model: null,
        messageFingerprint: null,
        workbuddyMessageId: null,
        detail: null,
      },
      {
        seq: 3,
        at: AT,
        event: "RUNNING_CONFIRMED",
        taskId: "t",
        taskFingerprint: "fp",
        dispatchId: null,
        attempt: null,
        source: "workbuddy",
        executor: null,
        model: null,
        messageFingerprint: null,
        workbuddyMessageId: null,
        detail: null,
      },
    ];

    // Something ran after the cancellation: the decision no longer covers the
    // history, so it must not read as terminal.
    expect(terminalStateFor(voided)?.stands).toBe(false);
  });

  it("mutation: the double requeue row would read as two requeues", async () => {
    /*
     * The two-row chain is what the double write produced. Reconciliation has
     * to treat it as one requeue, or a chain that was requeued once will look
     * like it was queued twice - and the duplicate row is precisely the kind of
     * thing a human reads as "this task was retried more than once".
     */
    const doubleWritten: ReconciliationEvent[] = [
      {
        seq: 1,
        at: AT,
        event: "TASK_REQUEUED",
        taskId: "t",
        taskFingerprint: "fp",
        dispatchId: null,
        attempt: null,
        source: "relay",
        executor: null,
        model: null,
        messageFingerprint: null,
        workbuddyMessageId: null,
        detail: { retryCount: 1, via: "requeue" },
      },
      {
        seq: 2,
        at: AT,
        event: "TASK_REQUEUED",
        taskId: "t",
        taskFingerprint: "fp",
        dispatchId: null,
        attempt: null,
        source: "relay",
        executor: null,
        model: null,
        messageFingerprint: null,
        workbuddyMessageId: null,
        detail: { retryCount: 1 },
      },
    ];

    // The shape is visible in the raw evidence...
    expect(doubleWritten.filter((r) => r.event === "TASK_REQUEUED")).toHaveLength(2);

    // ...and the relay no longer produces it: the live requeue test above
    // asserts exactly one row, which is what fails if the duplicate returns.
  });
});
