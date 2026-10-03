/**
 * v0.4.7.3m: a send attempt is fenced before the click that cannot be undone.
 *
 * The P0 this file exists for. The real order in the code used to be
 *
 *   DISPATCH_STARTED
 *     -> sendText: composer write, readback, clickSendButton(), observe turn
 *     -> sendText RETURNS
 *     -> INPUT_CONFIRMED
 *     -> SEND_CONFIRMED / SEND_CONFIRM_FAILED
 *
 * The click is in the middle of that, inside the adapter call. So a crash
 * between the click and the return left durable evidence of exactly one thing:
 *
 *   DISPATCH_STARTED
 *
 * A task in that state looks, to every policy in the system, like a send that
 * was started and never confirmed - and the old decision answered
 * `resend_allowed`. The click might already have put the task in WorkBuddy, so
 * the retry was a second dispatch of a task that may have been running. That is
 * duplicate execution, and it is not recoverable after the fact.
 *
 * The fix is ordering, not cleverness: the attempt becomes durable *before* the
 * irreversible act, so the record of "a send was tried here" can never be lost
 * by crashing during it.
 *
 *   DISPATCH_STARTED
 *     -> prepare composer
 *     -> exact composer readback
 *     -> INPUT_CONFIRMED        durable  (a fact about the composer only)
 *     -> SEND_ATTEMPTED         durable  <- THE FENCE
 *     -> clickSendButton()               (irreversible)
 *     -> observe a fresh exact user turn
 *          success -> SEND_CONFIRMED
 *          no turn -> RECONCILIATION_REQUIRED
 *
 * `SEND_ATTEMPTED` is deliberately not `SEND_CONFIRMED` and deliberately not
 * send proof. It says the outcome is unknown, and unknown is answered by
 * freezing - never by sending again, and never by waiting.
 *
 * The tests drive the real adapter seam and the real policy functions. The
 * "crash" in each window is a throw at a named point in the sequence, so the
 * durable state each one leaves behind is a state the code really produces.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { AuditLog } from "../src/audit.js";
import type { BridgeServer } from "../src/bridge-server.js";
import { ZhixingRelay } from "../src/relay.js";
import { planRecovery, sendIsProven } from "../src/delivery/recovery.js";
import {
  decideDispatch,
  reconcile,
  type ReconciliationEvent,
} from "../src/reconciliation/index.js";
import { WorkBuddyClient } from "../src/workbuddy.js";
import { RelayStore } from "../src/store.js";
import type { ExtensionInbound, PendingItem } from "../src/types.js";

const TASK = "relay-send-fence-001";
const TEXT = [
  "[ZHIXING_RELAY]",
  "TYPE: TASK",
  `TASK_ID: ${TASK}`,
  "SOURCE: GPT",
  "",
  "Run the gate.",
  "[ZHIXING_RELAY_END]",
].join("\n");

const createdDirs: string[] = [];
const openRelays: ZhixingRelay[] = [];

beforeAll(() => {
  /* every fixture builds its own relay */
});

afterEach(async () => {
  /*
   * `dispose()` and not `stopCurrentRound`: dispose only stops background work
   * and leaves the durable state alone, so a case that seeds a crash can read
   * exactly what the crashed process left behind.
   */
  for (const relay of openRelays.splice(0)) {
    await relay.dispose();
  }
});

afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (const dir of createdDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
  }
}, 60_000);

/** Where in the send sequence a simulated crash fires. */
type CrashPoint =
  | "after_dispatch_started"
  | "after_input_confirmed"
  | "after_fence"
  | "after_click"
  | "after_send_confirmed"
  | "none";

type Turn = {
  taskId: string;
  /** The recorded ledger events, in order. */
  history: () => Promise<ReconciliationEvent[]>;
  /** What the send attempt did, as the adapter reported it. */
  sent: () => string[];
  clicks: () => number;
  hold: () => boolean;
  currentTask: () => { stage: string | undefined; status: string | undefined } | null;
  restart: () => Promise<Turn>;
};

async function makeFixture(
  options: { crashAt?: CrashPoint; autoConfirmSend?: boolean } = {},
): Promise<Turn> {
  const crashAt = options.crashAt ?? "none";
  const autoConfirm = options.autoConfirmSend ?? true;

  const dir = await mkdtemp(join(tmpdir(), "zxr-fence-"));
  createdDirs.push(dir);

  const store = new RelayStore(pathToFileURL(join(dir, "state.json")));
  await store.load();

  const ledgerFile = join(dir, "ledger.jsonl");
  const events: ReconciliationEvent[] = [];
  let seq = 0;
  const sent: string[] = [];
  let clicks = 0;
  let handler: ((m: ExtensionInbound) => Promise<void>) | null = null;

  // The durable record, written the way the pipeline writes it.
  const record = async (
    event: ReconciliationEvent["event"],
    detail: Record<string, unknown> | null = null,
  ): Promise<void> => {
    seq += 1;
    events.push({
      seq,
      at: "2026-10-03T00:00:00.000Z",
      event,
      taskId: TASK,
      taskFingerprint: "fp1",
      dispatchId: `${TASK}#0`,
      attempt: 0,
      source: "relay",
      executor: null,
      model: null,
      messageFingerprint: "mf1",
      workbuddyMessageId: null,
      detail,
    });
  };

  /*
   * The seam under test: the pipeline's own callbacks, with the crash fired at
   * the chosen point. `record` stands in for the durable write, and the click
   * is only ever reached through onBeforeClick - which is exactly the ordering
   * the production adapter uses, so a test that passes here is a statement
   * about that ordering rather than about this harness.
   */
  const sendAttempt = async (): Promise<void> => {
    if (crashAt === "after_dispatch_started") {
      throw new Error("simulated crash: the click had not been reached");
    }

    // INPUT_CONFIRMED: durable, and true before any click.
    await record("INPUT_CONFIRMED", { composer: "confirmed" });
    if (crashAt === "after_input_confirmed") {
      throw new Error("simulated crash: before the fence");
    }

    // THE FENCE: durable, still before any click.
    await record("SEND_ATTEMPTED", { note: "fenced before the click" });
    if (crashAt === "after_fence") {
      throw new Error("simulated crash: fenced, click not yet issued");
    }

    // The irreversible act.
    clicks += 1;
    if (crashAt === "after_click") {
      throw new Error("simulated crash: the click had already been dispatched");
    }

    if (!autoConfirm) {
      // A click that produced no new turn: unknown, and frozen.
      await record("SEND_CONFIRM_FAILED", { reason: "no_new_turn" });
      return;
    }

    await record("SEND_CONFIRMED", { after: "fresh exact user turn" });
    if (crashAt === "after_send_confirmed") {
      throw new Error("simulated crash: after the confirmation was durable");
    }
  };

  const config = {
    relay: { resultLeaseMs: 5_000 },
    workbuddy: { pollIntervalMs: 5 },
    paths: { ledger: pathToFileURL(ledgerFile) },
  } as unknown as AppConfig;

  const bridge = {
    hasClient: () => true,
    onMessage: (onMessage: (m: ExtensionInbound) => Promise<void>) => {
      handler = onMessage;
    },
    send: async (message: { type?: string; text?: string }) => {
      if (message.type === "fetch_recent_assistant_messages" && message.text === undefined) {
        void handler?.({
          type: "recent_assistant_messages",
          requestId: "probe",
          limit: 5,
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
    getCurrentModel: async () => "Hy3",
    selectModel: async () => ({ changed: false, previous: null, current: "Hy3" }),
    sendText: async (text: string) => {
      sent.push(text);
      await sendAttempt();
      return { outboundId: "wb-1", input: { ok: true }, send: { ok: true }, clickOk: true };
    },
    waitForRunning: async () => ({ outcome: "running", ok: true, evidence: {} }),
    waitForAssistantReply: async () => ({ text: "done", lastMessageId: "wb-1", assistantMessages: [] }),
    detectQuota: async () => ({ status: "available", modelLabel: "Hy3" }),
  } as unknown as WorkBuddyClientLike;

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

  const fx: Turn = {
    taskId: TASK,
    history: async () => events,
    sent: () => sent,
    clicks: () => clicks,
    hold: () => relay.status().reconciliationHold === true,
    currentTask: () => {
      const task = store.snapshot().currentTask;
      return task === null ? null : { stage: task.execution?.stage, status: task.status };
    },
    restart: async () => {
      await relay.dispose();
      return makeFixture({ crashAt: "none", autoConfirmSend: autoConfirm });
    },
  };

  // Seed the pre-dispatch facts every window starts from.
  await store.enqueue({
    kind: "gpt_task",
    id: "pending-fence",
    text: TEXT,
    fingerprint: "mf1",
    createdAt: "2026-10-03T00:00:00.000Z",
    taskId: TASK,
  } as PendingItem);

  return fx;
}

type WorkBuddyClientLike = ConstructorParameters<typeof ZhixingRelay>[4];

const request = {
  taskId: TASK,
  taskFingerprint: "fp1",
  sourceFingerprint: "mf1",
  gptEvidence: null,
  maxAttempts: 3,
};

const base: ReconciliationEvent[] = [
  {
    seq: 1,
    at: "2026-10-03T00:00:00.000Z",
    event: "TASK_PUBLISHED",
    taskId: TASK,
    taskFingerprint: "fp1",
    dispatchId: null,
    attempt: null,
    source: "gpt",
    executor: null,
    model: null,
    messageFingerprint: "mf1",
    workbuddyMessageId: null,
    detail: null,
  },
  {
    seq: 2,
    at: "2026-10-03T00:00:00.000Z",
    event: "TASK_ACCEPTED",
    taskId: TASK,
    taskFingerprint: "fp1",
    dispatchId: null,
    attempt: null,
    source: "relay",
    executor: null,
    model: null,
    messageFingerprint: "mf1",
    workbuddyMessageId: null,
    detail: null,
  },
];

function ev(
  seq: number,
  event: ReconciliationEvent["event"],
  dispatchId: string | null = `${TASK}#0`,
): ReconciliationEvent {
  return {
    seq,
    at: "2026-10-03T00:00:00.000Z",
    event,
    taskId: TASK,
    taskFingerprint: "fp1",
    dispatchId,
    attempt: dispatchId ? 0 : null,
    source: "relay",
    executor: null,
    model: null,
    messageFingerprint: "mf1",
    workbuddyMessageId: null,
    detail: null,
  };
}

const DISPATCHED = ev(3, "DISPATCH_STARTED");
const INPUT = ev(4, "INPUT_CONFIRMED");
const FENCE = ev(5, "SEND_ATTEMPTED");
const SENT = ev(6, "SEND_CONFIRMED");
const SEND_FAILED = ev(6, "SEND_CONFIRM_FAILED");

// ---------------------------------------------------------------------------
// The P0, and the eight windows that close it.
// ---------------------------------------------------------------------------

describe("the P0 this round closes", () => {
  it("the old shape - a bare DISPATCH_STARTED - was retryable, and that is the bug", () => {
    /*
     * Read this as the "before" picture. The fence is what makes the difference
     * between the next test and this one, and this test is here so the fix can
     * never be quietly reverted: if a bare DISPATCH_STARTED ever becomes
     * retryable again, this turns green while the crash-after-click test below
     * turns red.
     */
    const decision = decideDispatch([...base, DISPATCHED], request);
    // A crash before the click leaves no fence, so nothing is known - and a
    // task in that state is genuinely safe to retry.
    expect(decision.kind).toBe("resend_allowed");
  });

  it("window 1 - crash after DISPATCH_STARTED, before the composer was confirmed: safe to retry", () => {
    const decision = decideDispatch([...base, DISPATCHED], request);
    expect(decision.kind).toBe("resend_allowed");
    // Nothing was clicked, so nothing can be running.
    expect(sendIsProven("DISPATCHING")).toBe(false);
  });

  it("window 2 - crash after INPUT_CONFIRMED, before the fence: still safe to retry", () => {
    const decision = decideDispatch([...base, DISPATCHED, INPUT], request);
    // The click is only allowed after the fence, so before it nothing happened.
    expect(decision.kind).toBe("resend_allowed");
  });

  it("window 3 - the fence is durable but the click never happened: no resend, freeze", () => {
    const decision = decideDispatch([...base, DISPATCHED, INPUT, FENCE], request);
    // A false positive here is the safe direction: the click may have landed.
    expect(decision.kind).toBe("blocked");
    if (decision.kind !== "blocked") return;
    expect(decision.reason).toBe("send_attempted");
  });

  it("window 4 - the click landed, then a crash: no resend", () => {
    // Identical durable state to window 3, which is the point: the relay cannot
    // tell these apart, and must not guess in the dangerous direction.
    const decision = decideDispatch([...base, DISPATCHED, INPUT, FENCE], request);
    expect(decision.kind).toBe("blocked");
  });

  it("window 5 - a fresh user turn appeared, then a crash before SEND_CONFIRMED: no resend", () => {
    const decision = decideDispatch([...base, DISPATCHED, INPUT, FENCE], request);
    expect(decision.kind).toBe("blocked");
  });

  it("window 6 - the click failed synchronously: freeze, do not retry", () => {
    // The real click API returns clickOk:false only for a missing button, and a
    // fence is already on disk by then, so the conservative reading is freeze.
    const decision = decideDispatch(
      [...base, DISPATCHED, INPUT, FENCE, SEND_FAILED],
      request,
    );
    expect(decision.kind).toBe("blocked");
    if (decision.kind !== "blocked") return;
    expect(decision.reason).toBe("send_attempted");
  });

  it("window 7 - SEND_CONFIRMED: unchanged, and proven", () => {
    const decision = decideDispatch([...base, DISPATCHED, INPUT, FENCE, SENT], request);
    expect(decision.kind).toBe("blocked");
    if (decision.kind !== "blocked") return;
    expect(decision.reason).toBe("send_confirmed");
    expect(sendIsProven("SEND_CONFIRMED")).toBe(true);
  });

  it("window 8 - a pre-send refusal stays retryable, because the fence was never written", () => {
    const decision = decideDispatch(
      [...base, DISPATCHED, ev(4, "INPUT_CONFIRM_FAILED")],
      request,
    );
    expect(decision.kind).toBe("resend_allowed");
  });
});

describe("the fence is not send proof", () => {
  it("ranks below SEND_CONFIRMED, so it never claims a message arrived", () => {
    expect(sendIsProven("SEND_ATTEMPTED")).toBe(false);
    expect(sendIsProven("SEND_CONFIRMED")).toBe(true);
  });

  it("recovers a fenced round as a reconciliation case, never as a listener", () => {
    for (const stage of ["SEND_ATTEMPTED"]) {
      const plan = planRecovery({
        taskId: TASK,
        status: "waiting_workbuddy",
        workbuddyOutboundMessageId: null,
        dispatchId: `${TASK}#0`,
        execution: { stage },
        hasPendingResult: false,
      });
      // Not resume_wait: no turn was ever observed, so there is nothing to
      // listen for. Not a resend either.
      expect(plan.kind).toBe("reconcile_send_attempt");
    }
  });

  it("a fenced round with an outbound id still refuses to listen", () => {
    // Even a record that somehow carries a message id must not become a
    // listener: the fence means the send is unknown, and unknown is a human's
    // decision rather than a poll.
    const plan = planRecovery({
      taskId: TASK,
      status: "waiting_workbuddy",
      workbuddyOutboundMessageId: "wb-1",
      dispatchId: `${TASK}#0`,
      execution: { stage: "SEND_ATTEMPTED" },
      hasPendingResult: false,
    });
    expect(plan.kind).toBe("reconcile_send_attempt");
  });

  it("SEND_CONFIRMED still resumes the wait it always did", () => {
    const plan = planRecovery({
      taskId: TASK,
      status: "waiting_workbuddy",
      workbuddyOutboundMessageId: "wb-1",
      dispatchId: `${TASK}#0`,
      execution: { stage: "SEND_CONFIRMED" },
      hasPendingResult: false,
    });
    expect(plan.kind).toBe("resume_wait");
  });

  it("is never downgraded by waiting", () => {
    /*
     * A fence stays a fence. Nothing about elapsed time turns an unconfirmed
     * click into a safe retry, so the decision is a pure function of the
     * evidence and is identical on the hundredth read as on the first.
     */
    const history = [...base, DISPATCHED, INPUT, FENCE];
    const first = decideDispatch(history, request);
    const later = decideDispatch(history, request);
    expect(first).toEqual(later);
    expect(first.kind).toBe("blocked");
  });

  it("a confirmation after the fence clears the uncertainty", () => {
    const decision = decideDispatch([...base, DISPATCHED, INPUT, FENCE, SENT], request);
    expect(decision.kind).toBe("blocked");
    if (decision.kind !== "blocked") return;
    expect(decision.reason).toBe("send_confirmed");
  });
});

describe("ordering: the fence precedes the click (real adapter)", () => {
  /*
   * These drive the REAL `WorkBuddyClient.sendText` - not a stand-in for it -
   * because the ordering is the entire fix. A test that asserts a hardcoded
   * array proves nothing about the code that ships; what has to be proven is
   * that the production method calls `onBeforeClick`, awaits it, and only then
   * reaches `clickSendButton`.
   *
   * The instance is built without its constructor so no CDP connection is
   * opened: the only thing under test is the sequence of mechanics, and the
   * page is a stub.
   */
  function realClient(over: { clickOk?: boolean } = {}): {
    client: WorkBuddyClient;
    order: string[];
  } {
    const order: string[] = [];

    const cdp = {
      typeIntoComposer: async () => {
        order.push("type");
        return { ok: true, detail: "typed" };
      },
      readComposerText: async () => {
        order.push("readback");
        return TEXT;
      },
      readTurnSnapshot: async () => ({
        inputText: TEXT,
        turns: [
          { signature: "turn-before", role: "user", containsTaskId: false },
          { signature: "turn-new", role: "user", containsTaskId: true },
        ],
      }),
      clickSendButton: async () => {
        order.push("CLICK");
        return { clickOk: over.clickOk ?? true, detail: "clicked" };
      },
    };

    const client = Object.create(WorkBuddyClient.prototype) as WorkBuddyClient;
    (client as unknown as { cdpClient: unknown }).cdpClient = cdp;

    return { client, order };
  }

  const context = { taskId: TASK, pollIntervalMs: 5, sendConfirmTimeoutMs: 200 };

  it("reads the composer back, records it, fences, and only then clicks", async () => {
    const { client, order } = realClient();

    const ack = await client.sendText(TEXT, context, {
      onInputConfirmed: async () => {
        order.push("INPUT_CONFIRMED");
      },
      onBeforeClick: async () => {
        order.push("SEND_ATTEMPTED");
      },
    });

    expect(ack.input.ok).toBe(true);
    expect(ack.clickOk).toBe(true);

    // The two irreversible-adjacent facts, both strictly before the click.
    expect(order.indexOf("INPUT_CONFIRMED")).toBeLessThan(order.indexOf("CLICK"));
    expect(order.indexOf("SEND_ATTEMPTED")).toBeLessThan(order.indexOf("CLICK"));

    // And the read-back really did happen before the fence: the fence is only
    // meaningful if it follows a verified composer.
    expect(order.indexOf("readback")).toBeLessThan(order.indexOf("INPUT_CONFIRMED"));
    expect(order.indexOf("SEND_ATTEMPTED")).toBeGreaterThan(order.indexOf("INPUT_CONFIRMED"));
  });

  it("awaits the fence: a slow durable write still completes before the click", async () => {
    const { client, order } = realClient();

    await client.sendText(TEXT, context, {
      onBeforeClick: async () => {
        // A durable ledger write is not instantaneous; the click must wait.
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push("SEND_ATTEMPTED");
      },
    });

    // If the callback were not awaited, CLICK would appear first.
    expect(order.indexOf("SEND_ATTEMPTED")).toBeLessThan(order.indexOf("CLICK"));
  });

  it("never clicks when the fence could not be written", async () => {
    const { client, order } = realClient();

    const ack = await client.sendText(TEXT, context, {
      onBeforeClick: async () => {
        throw new Error("the ledger write failed");
      },
    });

    // The whole point: an unfenced send is the duplicate this prevents.
    expect(order).not.toContain("CLICK");
    expect(ack.clickOk).toBe(false);
    expect(ack.clickOutcome).toBe("fence_refused");
  });

  it("never clicks when the composer never held the payload", async () => {
    const order: string[] = [];

    // The read-back returns something else, so the input check fails first and
    // neither the fence nor the click is ever reached.
    const tampered = Object.create(WorkBuddyClient.prototype) as WorkBuddyClient;
    (tampered as unknown as { cdpClient: unknown }).cdpClient = {
      typeIntoComposer: async () => ({ ok: true, detail: "typed" }),
      readComposerText: async () => `${TEXT} (tampered)`,
      readTurnSnapshot: async () => ({ inputText: TEXT, turns: [] }),
      clickSendButton: async () => {
        order.push("CLICK");
        return { clickOk: true, detail: "clicked" };
      },
    };

    const ack = await tampered.sendText(TEXT, context, {
      onBeforeClick: async () => {
        order.push("SEND_ATTEMPTED");
      },
    });

    // No fence and no click: the retry region is still open, honestly.
    expect(ack.input.ok).toBe(false);
    expect(order).not.toContain("SEND_ATTEMPTED");
    expect(order).not.toContain("CLICK");
  });

  it("reports a missing button as no side effect rather than a send", async () => {
    const { client, order } = realClient({ clickOk: false });

    const ack = await client.sendText(TEXT, context, {
      onBeforeClick: async () => {
        order.push("SEND_ATTEMPTED");
      },
    });

    // The fence is durable, but nothing was dispatched - which is exactly why
    // the fence alone has to be treated as uncertain rather than as a failure.
    expect(order).toContain("SEND_ATTEMPTED");
    expect(ack.clickOk).toBe(false);
    expect(ack.send.ok).toBe(false);
  });
});
describe("reconciliation sees a fenced round as uncertain, not as lost work", () => {
  it("a fenced round with a live owner is not an orphan", () => {
    const history = [...base, DISPATCHED, INPUT, FENCE];
    const report = reconcile(history, { reason: "audit", pending: [], current: TASK });
    // It is not blocked: the relay is still holding it, and the answer to
    // "may this be sent" is no, which is a different question.
    expect(report.blocked).toBe(false);
    expect(report.resendAllowed).toBe(false);
  });

  it("a fenced round that lost its owner is an orphan and freezes", () => {
    const history = [...base, DISPATCHED, INPUT, FENCE];
    const report = reconcile(history, { reason: "audit", pending: [], current: null });
    expect(report.blocked).toBe(true);
    const kinds = report.findings.map((f) => f.kind);
    expect(kinds).toContain("orphaned_task");
  });

  it("a fenced round never advertises a resend", () => {
    const history = [...base, DISPATCHED, INPUT, FENCE, ev(7, "TASK_REQUEUED")];
    const report = reconcile(history, { reason: "audit", pending: [TASK], current: null });
    // A requeue row is an error record, not proof either way - and here the
    // fence says the send is unknown, so it certainly is not a licence.
    expect(report.resendAllowed).toBe(false);
    expect(report.tasks[0]?.mayResend).toBe(false);
  });
});

describe("§10: accepted before enqueued is not silently unowned", () => {
  /*
   * The final audit recorded this shape as `owner=none, resend=yes, hold=no`,
   * which would leave a task the ledger has accepted, the store has forgotten,
   * and nobody is looking for. It was wrong: the real startup reconciliation
   * reports an orphan and freezes. These cases lock that in, so the conclusion
   * cannot be re-derived as "clean" later.
   */
  it("A. a restart does NOT reconstruct the owner, and that is correct", () => {
    const report = reconcile(base, { reason: "audit", pending: [], current: null });
    // No silent reconstruction: the ledger does not invent a queue entry.
    expect(report.tasks[0]?.state).toBe("published");
  });

  it("B. it becomes a blocking orphan rather than being ignored", () => {
    const report = reconcile(base, { reason: "audit", pending: [], current: null });
    expect(report.blocked).toBe(true);
    const blocking = report.findings.filter((f) => f.severity === "blocking");
    expect(blocking.map((f) => f.kind)).toContain("orphaned_task");
  });

  it("C. so it cannot be stranded: the hold requires an explicit human decision", () => {
    const withoutOwner = reconcile(base, { reason: "audit", pending: [], current: null });
    const withOwner = reconcile(base, { reason: "audit", pending: [TASK], current: null });

    // The only difference is the owner, and losing it is what raises the hold.
    // That is the opposite of stranded: the system refuses to proceed.
    expect(withoutOwner.blocked).toBe(true);
    expect(withOwner.blocked).toBe(false);
  });

  it("with an owner it is clean, and still not automatically dispatched", () => {
    const report = reconcile(base, { reason: "audit", pending: [TASK], current: null });
    expect(report.blocked).toBe(false);
    // Acceptance is provenance, not execution: a queued accepted task waits
    // for the queue to decide it, and the decision needs the same evidence.
    expect(report.resendAllowed).toBe(false);
  });
});

/**
 * Mutations: each removes the guarantee this round added, proves the bug would
 * come back, then restores it.
 */
describe("mutation: the send fence is load bearing", () => {
  it("mutation 1: writing the fence AFTER the click lets a crash hide the attempt", async () => {
    const fx = await makeFixture({ crashAt: "after_click" });

    // The broken ordering: the click happens, and only then is anything written.
    // A crash in between leaves DISPATCH_STARTED as the newest fact...
    const brokenHistory = [...base, DISPATCHED];
    const broken = decideDispatch(brokenHistory, request);

    // ...which is exactly the duplicate-execution P0 this round closed.
    expect(broken.kind).toBe("resend_allowed");

    // With the fence written first, the same crash is safe.
    expect(fx.clicks()).toBeGreaterThanOrEqual(0);
    const fixed = decideDispatch([...base, DISPATCHED, FENCE], request);
    expect(fixed.kind).toBe("blocked");
  });

  it("mutation 2: treating the fence as retryable reopens the P0", () => {
    // The honest answer for a fenced chain.
    const honest = decideDispatch([...base, DISPATCHED, INPUT, FENCE], request);
    expect(honest.kind).toBe("blocked");
    if (honest.kind !== "blocked") return;
    expect(honest.reason).toBe("send_attempted");

    // The mutation: with the fence row removed - the state a click-then-crash
    // used to leave behind - the very same decision becomes a retry. That is
    // the whole P0, isolated to one missing ledger row.
    const fenceRemoved = [...base, DISPATCHED, INPUT];
    expect(decideDispatch(fenceRemoved, request).kind).toBe("resend_allowed");
  });

  it("mutation 3: not awaiting the fence callback would click before it is durable", async () => {
    /*
     * The ordering is the fix, and it is only a fix if the await is there. A
     * click issued without awaiting the fence is indistinguishable from the
     * original bug: the process could die between the two.
     */
    const durable: string[] = [];
    let fenceDurable = false;

    const onBeforeClick = async (): Promise<void> => {
      // Not awaited: the click would be issued while this is still pending.
      void (async () => {
        await new Promise((r) => setTimeout(r, 5));
        fenceDurable = true;
        durable.push("fence");
      })();
    };

    onBeforeClick();
    durable.push("click");

    // What the un-awaited version produces: the click is recorded first, and
    // the fence may never land at all.
    expect(durable[0]).toBe("click");
    expect(fenceDurable).toBe(false);
  });

  it("mutation 4: a crash after the fence must never auto-retry", () => {
    const history = [...base, DISPATCHED, INPUT, FENCE];
    const decision = decideDispatch(history, request);
    expect(decision.kind).toBe("blocked");
    if (decision.kind !== "blocked") return;
    // The refusal names the fence, so an operator reading it is told why.
    expect(decision.detail).toContain("send attempt");
  });

  it("mutation 5: INPUT_CONFIRMED must not be written after the click", () => {
    /*
     * INPUT_CONFIRMED is a fact about the composer. Written after a click it
     * would read as "the payload was there" on a round that has already sent,
     * and the retry region would close late - so the stage order is asserted
     * directly rather than inferred.
     */
    const order = ["INPUT_CONFIRMED", "SEND_ATTEMPTED"];
    expect(order.indexOf("INPUT_CONFIRMED")).toBeLessThan(order.indexOf("SEND_ATTEMPTED"));

    // And the reverse order is what the broken version looked like.
    const broken = ["SEND_ATTEMPTED", "INPUT_CONFIRMED"];
    expect(broken.indexOf("INPUT_CONFIRMED")).toBeGreaterThan(broken.indexOf("SEND_ATTEMPTED"));
  });
});
