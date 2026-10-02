/**
 * v0.4.7: the delivery acknowledgements, end to end through the relay.
 *
 * The pure rules live in `delivery-ack.test.ts`. What is checked here is that
 * the relay asks for the right proof at the right moment and refuses to treat
 * a weaker fact as a stronger one:
 *
 *   a composer that held the payload   is not   a click
 *   a successful click                 is not   a send
 *   a message on the page              is not   WorkBuddy running
 *   a websocket that took the text     is not   ChatGPT answering
 *
 * Every case below is one of those four sentences, or the honest handling of
 * the unknown that sits behind them.
 */

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { AuditLog } from "../src/audit.js";
import type { BridgeServer } from "../src/bridge-server.js";
import { SECRET_HEADER, startControlServer } from "../src/control.js";
import { ReconciliationService, TaskLedger } from "../src/reconciliation/index.js";
import { ZhixingRelay } from "../src/relay.js";
import { RelayStore } from "../src/store.js";
import type { ExtensionInbound, PendingItem } from "../src/types.js";
import type { WorkBuddyClient } from "../src/workbuddy.js";
import {
  confirmInputReadback,
  confirmSend,
  type RunningConfirmation,
  type TurnSnapshot,
} from "../src/workbuddy/turn-ack.js";

/** How the fake page answers the send confirmations. */
type Delivery = "confirmed" | "input_mismatch" | "click_only" | "wrong_task";
/** What the fake page says about the turn it was handed. */
type Running = "running" | "result_ready" | "cancelled" | "timeout";
/**
 * The wait window, and how long the fake waits before it runs out.
 *
 * A real two hour window cannot be waited out in a test, so the fake fails the
 * wait after this many milliseconds with the very error the real adapter
 * produces at the end of `WORKBUDDY_MAX_WAIT_MS` - the message has to match,
 * because that string is what classifies the failure.
 */
type WaitWindow = { budgetMs: number; failsAfterMs: number };

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
  sandboxRoot = await mkdtemp(join(tmpdir(), "zxr-ack-"));
});

afterAll(async () => {
  // A late write from a settled turn must not race the removal.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await rm(sandboxRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 10,
  });
  // One directory per case, and recursive removal is slow on this machine.
}, 60_000);

function fakeAudit(sink: { event: string; payload: Record<string, unknown> }[]): AuditLog {
  return {
    write: async (event: string, payload: Record<string, unknown> = {}) => {
      sink.push({ event, payload });
    },
  } as unknown as AuditLog;
}

/** The bridge messages the fake sends, whatever they claim to be. */
type SentMessage = { text?: string; type?: string; requestId?: string };

/** The knobs the fake page answers from. Shared with the harness. */
type Knobs = {
  delivery: Delivery;
  running: Running;
  /** Held before the running verdict, so a stage can be observed. */
  runningDelayMs: number;
  /** False for a Chrome bridge that is not on the other end. */
  connected: boolean;
  /** Set for a turn that is still working when the wait window runs out. */
  waitWindow: WaitWindow | null;
};

/** The bookkeeping one fake WorkBuddy keeps for the relay talking to it. */
type FakeWorkbuddy = {
  sentToWorkBuddy: string[];
  waitCalls: number;
  /** How many times the send button was really clicked. */
  clicks: number;
  /** Set while a turn is hanging on the answer. */
  resolver: ((text: string) => void) | null;
  /** Set to make the answer wait run out while WorkBuddy is still working. */
  waitWindow: WaitWindow | null;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function buildWorkbuddy(share: FakeWorkbuddy, knobs: Knobs): {
  client: unknown;
  answer: (text: string) => void;
} {
  const state = share;

  return {
    client: {
      init: async () => {},
      online: async () => true,
      getCurrentModel: async () => null,
      selectModel: async () => ({ changed: false, previous: null, current: "Hy3" }),
      detectQuota: async () => ({ status: "available", modelLabel: "Hy3" }),
      sendText: async (text: string, context: { taskId: string }) => {
        state.sentToWorkBuddy.push(text);

        const input = confirmInputReadback({
          expected: text,
          observed: knobs.delivery === "input_mismatch" ? `${text} (tampered)` : text,
        });

        if (!input.ok) {
          return {
            outboundId: "wb-1",
            input,
            send: {
              ok: false,
              reason: "input_not_confirmed",
              observedMessageId: null,
              beforeTurnCount: 0,
              afterTurnCount: 0,
              detail: "the payload never reached the composer",
            },
            clickOk: false,
          };
        }

        const snapshot = (turns: TurnSnapshot["turns"]): TurnSnapshot => ({
          inputText: text,
          turns,
        });

        const before = snapshot([{ signature: "turn-before", containsTaskId: false }]);
        let after: TurnSnapshot;

        switch (knobs.delivery) {
          // The button was clicked and no new turn appeared at all.
          case "click_only":
            after = snapshot([{ signature: "turn-before", containsTaskId: false }]);
            break;
          // A new turn appeared, but it belongs to a different task.
          case "wrong_task":
            after = snapshot([{ signature: "turn-other", containsTaskId: false }]);
            break;
          default:
            after = snapshot([
              { signature: "turn-before", containsTaskId: false },
              { signature: `turn-${context.taskId}`, containsTaskId: true },
            ]);
        }

        state.clicks += 1;

        return {
          outboundId: "wb-1",
          input,
          send: confirmSend({ before, after, expectedTaskId: context.taskId }),
          clickOk: true,
        };
      },
      waitForRunning: async (): Promise<RunningConfirmation> => {
        if (knobs.runningDelayMs > 0) await sleep(knobs.runningDelayMs);

        switch (knobs.running) {
          case "result_ready":
            return {
              outcome: "result_ready",
              ok: false,
              reason: "already finished",
              evidence: { running: false, completed: true, cancelled: false },
            };
          case "cancelled":
            return {
              outcome: "cancelled",
              ok: false,
              reason: "the turn was cancelled",
              evidence: { running: false, completed: false, cancelled: true },
            };
          case "timeout":
            return {
              outcome: "timeout",
              ok: false,
              reason: "nothing moved",
              evidence: { running: false, completed: false, cancelled: false },
            };
          default:
            return {
              outcome: "running",
              ok: true,
              reason: "processing",
              evidence: { running: true, completed: false, cancelled: false },
            };
        }
      },
      waitForAssistantReply: () => {
        state.waitCalls += 1;

        /*
         * The two hour accident: WorkBuddy is already running the task and
         * never answers inside the window. The failure has to look like the
         * real one, because the whole point is what the relay does with the
         * error, not with a stand-in for it.
         */
        if (state.waitWindow !== null) {
          return new Promise((_resolve, reject) => {
            setTimeout(
              () =>
                reject(
                  new Error(
                    `Timed out waiting WorkBuddy after ${state.waitWindow?.budgetMs}ms`,
                  ),
                ),
              state.waitWindow?.failsAfterMs ?? 1,
            );
          });
        }

        return new Promise((resolve) => {
          // Whatever the page answers has to come back verbatim: an answer that
          // is silently replaced by a canned one cannot be told apart from one
          // that was really there.
          state.resolver = (text: string) =>
            resolve({ text, lastMessageId: "wb-1", assistantMessages: [] });
        });
      },
    },
    answer: (text: string) => state.resolver?.(text),
  };
}

type Replay = {
  relay: ZhixingRelay;
  sentToChatGpt: string[];
  sentToWorkBuddy: string[];
  /** True once the recovered round is listening for the answer. */
  waiting?: () => boolean;
  answerWith: (text: string) => void;
  push: (message: unknown) => Promise<void>;
};

type Harness = {
  relay: ZhixingRelay;
  store: RelayStore;
  auditEvents: { event: string; payload: Record<string, unknown> }[];
  sentToWorkBuddy: string[];
  sentToChatGpt: string[];
  /** How many times the send button was really clicked. */
  clicks: number;
  delivery: Delivery;
  running: Running;
  /** Held before the running verdict, so a stage can be observed. */
  runningDelayMs: number;
  /** Off keeps a delivered answer in RESULT_DELIVERED, so an ACK is observable. */
  autoAck: boolean;
  /** Off is a Chrome bridge that is not there. */
  connected: boolean;
  /** Makes the answer wait run out while WorkBuddy is still working. */
  waitWindow: WaitWindow | null;
  waitCalls: number;
  /** True once the relay is hanging on the answer of this task. */
  waiting: () => boolean;
  /** Hands the hanging answer to the relay. */
  answerWith: (text: string) => void;
  /** Pushes any bridge message straight to the relay this round talks to. */
  raw: (message: unknown) => Promise<void>;
  /** Starts a task and returns once the payload was handed to WorkBuddy. */
  startTask: (taskId: string) => Promise<void>;
  /** Lets the round run, waiting for the answer it will be given. */
  finish: () => Promise<void>;
  /** The ledger events one task left behind, in order. */
  history: (taskId: string) => Promise<string[]>;
  /** Every ledger event, in order; some are not filed under one task. */
  ledger: () => Promise<string[]>;
  /** The directory this case's durable state lives in. */
  dir: string;
  /** A second relay on the same durable state, the way a restart would see it. */
  restart: () => Promise<Replay>;
};

let bridgeHandler: ((message: ExtensionInbound) => Promise<void>) | null = null;

/**
 * Every timer a still-running relay owns, so a finished case cannot write
 * into a directory that is already gone.
 */
const liveIntervals = new Set<ReturnType<typeof setInterval>>();
/** Every relay built in the current case, so all of them can be stood down. */
let liveRelays: ZhixingRelay[] = [];

afterEach(async () => {
  for (const relay of liveRelays) {
    // Clears the round and the result lease, so nothing is written after the
    // case has been asserted.
    await relay.stopCurrentRound("the case ended");
  }

  liveRelays = [];
  for (const waiter of liveIntervals) clearInterval(waiter);
  liveIntervals.clear();
});

async function makeHarness(): Promise<Harness> {
  seq += 1;
  const dir = join(sandboxRoot, `case-${seq}`);
  await mkdir(dir, { recursive: true });

  const store = new RelayStore(pathToFileURL(join(dir, "state.json")));
  await store.load();

  const ledgerFile = join(dir, "ledger.jsonl");
  const ledgerUrl = pathToFileURL(ledgerFile);

  const auditEvents: { event: string; payload: Record<string, unknown> }[] = [];
  const sentToChatGpt: string[] = [];
  const sentToWorkBuddy: string[] = [];

  const knobs: Knobs = {
    delivery: "confirmed",
    running: "running",
    runningDelayMs: 0,
    connected: true,
    waitWindow: null,
  };
  const h = {
    auditEvents,
    sentToChatGpt,
    sentToWorkBuddy,
    autoAck: true,
  } as Harness;

  // The fake workbuddy counts into these; the harness reads them back.
  const main: FakeWorkbuddy = {
    sentToWorkBuddy,
    waitCalls: 0,
    clicks: 0,
    resolver: null,
    waitWindow: knobs.waitWindow,
  };

  Object.defineProperty(h, "clicks", { get: () => main.clicks });
  Object.defineProperty(h, "waitCalls", { get: () => main.waitCalls });
  Object.defineProperty(h, "delivery", {
    get: () => knobs.delivery,
    set: (value: Delivery) => {
      knobs.delivery = value;
    },
  });
  Object.defineProperty(h, "running", {
    get: () => knobs.running,
    set: (value: Running) => {
      knobs.running = value;
    },
  });
  Object.defineProperty(h, "runningDelayMs", {
    get: () => knobs.runningDelayMs,
    set: (value: number) => {
      knobs.runningDelayMs = value;
    },
  });
  Object.defineProperty(h, "connected", {
    get: () => knobs.connected,
    set: (value: boolean) => {
      knobs.connected = value;
    },
  });
  Object.defineProperty(h, "waitWindow", {
    get: () => knobs.waitWindow,
    set: (value: WaitWindow | null) => {
      knobs.waitWindow = value;
      // Both fakes read the window, so a restart sees the same one.
      main.waitWindow = value;
    },
  });

  /**
   * Acknowledges a RESULT the way the Chrome extension does.
   *
   * On a macrotask, and only once the record says `sent_to_gpt`: the relay has
   * to have recorded the delivery before an acknowledgement can mean
   * anything, and an ack fired inside the same tick would always lose that
   * race - the round would sit in RESULT_DELIVERED for ever.
   */
  function ackResult(
    handler: ((message: ExtensionInbound) => Promise<void>) | null,
    requestId?: string,
  ): void {
    const waiter = setInterval(() => {
      if (store.snapshot().currentTask?.status !== "sent_to_gpt") return;
      clearInterval(waiter);
      liveIntervals.delete(waiter);
      setTimeout(() => {
        void handler?.({
          type: "chatgpt_send_result",
          requestId: requestId ?? null,
          ok: true,
          sent: true,
        });
      }, 0);
    }, 2);

    liveIntervals.add(waiter);
  }

  const bridge = {
    // The bridge and the page answer from the same knobs, so a case can take
    // the relay offline without rebuilding it.
    hasClient: () => knobs.connected,
    onMessage: (handler: (message: ExtensionInbound) => Promise<void>) => {
      bridgeHandler = handler;
    },
    send: async (message: SentMessage) => {
      if (typeof message.text === "string") sentToChatGpt.push(message.text);

      if (message.type === "send_to_chatgpt" && h.autoAck) {
        ackResult(bridgeHandler, message.requestId);
      }

      if (message.type === "fetch_recent_assistant_messages") {
        const requestId = message.requestId;
        setTimeout(() => {
          void bridgeHandler?.({
            type: "recent_assistant_messages",
            requestId: requestId ?? "",
            messages: lastAssistant
              ? [{ id: "m-1", fingerprint: lastAssistant.fingerprint, text: lastAssistant.text }]
              : [],
          });
        }, 0);
      }
    },
    close: async () => {},
  } as unknown as BridgeServer;

  const config = {
    relay: {
      pauseOnManualUserMessage: false,
      gptForwardMode: "tagged",
      autoSendToChatGPT: true,
      // Short enough that the confirmation windows never slow a test down.
      sendConfirmTimeoutMs: 100,
      runningConfirmTimeoutMs: 200,
      resultLeaseMs: 5_000,
    },
    workbuddy: { pollIntervalMs: 10 },
    paths: { ledger: ledgerUrl },
  } as unknown as AppConfig;

  const workbuddy = buildWorkbuddy(main, knobs);

  const relay = new ZhixingRelay(
    config,
    bridge,
    store,
    fakeAudit(auditEvents),
    workbuddy.client as unknown as WorkBuddyClient,
    // No router: this harness is about delivery, not about model choice.
    null,
  );

  await relay.init();
  liveRelays.push(relay);

  h.relay = relay;
  h.store = store;

  /** The last assistant message the GPT side sent, for the ledger's evidence. */
  let lastAssistant: { fingerprint: string; text: string } | null = null;
  let fingerprintSeq = 0;

  const push = async (message: unknown): Promise<void> => {
    if (!bridgeHandler) throw new Error("the bridge handler was never registered");
    await bridgeHandler(message as ExtensionInbound);
  };

  /**
   * Starts one task and comes back at the moment the payload was handed over.
   *
   * The answer is not given yet, so the turn is hanging: that is the only
   * point at which the intermediate stages exist.
   */
  h.startTask = async (taskId: string) => {
    fingerprintSeq += 1;
    const fingerprint = `fp-${taskId}-${fingerprintSeq}`;

    const handed = (): boolean => sentToWorkBuddy.includes(taskBlock(taskId));
    const dispatch = push({
      type: "chatgpt_assistant_message",
      text: taskBlock(taskId),
      fingerprint,
    });

    await Promise.race([
      dispatch,
      flushUntil(handed, 3000, "the payload to reach WorkBuddy"),
    ]);

    lastAssistant = { fingerprint, text: taskBlock(taskId) };
  };

  h.waiting = () => main.resolver !== null;
  h.answerWith = (text: string) => workbuddy.answer(text);
  h.raw = push;

  /** Hands the answer over and waits for it to be received. */
  h.finish = async () => {
    await flushUntil(() => main.resolver !== null, 3000, "the relay to wait for the answer");
    h.answerWith(RESULT_BODY);
    await flushUntil(
      () => store.snapshot().currentTask?.execution?.stage === "RESULT_RECEIVED",
      3000,
      "the answer to be received",
    );
  };

  h.history = async (taskId: string): Promise<string[]> => {
    const service = new ReconciliationService(new TaskLedger(ledgerUrl));
    const events = await service.getTaskHistory(taskId);
    return events.map((event) => event.event);
  };

  /** Every ledger event, in order; some are not filed under one task. */
  h.ledger = async (): Promise<string[]> => {
    const lines = await ledgerLines(dir);
    return lines.map((line) => {
      const parsed = JSON.parse(line) as { event?: string };
      return parsed.event ?? "unreadable";
    });
  };

  h.dir = dir;

  /** A second relay on the same durable state, the way a restart would see it. */
  h.restart = async (): Promise<Replay> => {
    const freshSent: string[] = [];
    const freshWorkbuddySent: string[] = [];
    const fresh: FakeWorkbuddy = {
      sentToWorkBuddy: freshWorkbuddySent,
      waitCalls: 0,
      clicks: 0,
      resolver: null,
      waitWindow: knobs.waitWindow,
    };
    const freshWorkbuddy = buildWorkbuddy(fresh, knobs);

    const freshRelay = new ZhixingRelay(
      config,
      {
        hasClient: () => true,
        onMessage: (handler: (message: ExtensionInbound) => Promise<void>) => {
          bridgeHandler = handler;
        },
        send: async (message: SentMessage) => {
          if (typeof message.text === "string") freshSent.push(message.text);
          if (message.type === "send_to_chatgpt" && h.autoAck) {
            ackResult(bridgeHandler, message.requestId);
          }
        },
        close: async () => {},
      } as unknown as BridgeServer,
      store,
      fakeAudit(auditEvents),
      freshWorkbuddy.client as unknown as WorkBuddyClient,
      null,
    );

    await freshRelay.init();
    liveRelays.push(freshRelay);

    return {
      relay: freshRelay,
      sentToChatGpt: freshSent,
      sentToWorkBuddy: freshWorkbuddySent,
      waiting: () => fresh.resolver !== null,
      answerWith: (text: string) => freshWorkbuddy.answer(text),
      push,
    };
  };

  return h;
}

/** The stage one task is sitting in right now. */
function stageOf(h: Awaited<ReturnType<typeof makeHarness>>): string | null {
  return h.store.snapshot().currentTask?.execution?.stage ?? null;
}

/** The raw ledger lines, so append-only can be asserted byte for byte. */
async function ledgerLines(dir: string): Promise<string[]> {
  const raw = await readFile(pathToFileURL(join(dir, "ledger.jsonl")), "utf8");
  return raw.split("\n").filter((line) => line.trim().length > 0);
}

const CONTROL_SECRET = "a test only secret";

/**
 * Asks the control channel for a relay's status, over the loopback route the
 * operator uses: the shape of the answer is what has to be checked, and the
 * shape is decided by `control.statusPayload`, not by the relay.
 */
async function controlStatus(
  h: Awaited<ReturnType<typeof makeHarness>>,
): Promise<Record<string, unknown>> {
  const server = await startControlServer({
    /*
     * The relay itself, not a cast of it: `src/index.ts` passes the relay
     * object, so this assembly is what production does and the compiler is
     * what proves the relay still answers every method the transport calls.
     * An `as unknown as RuntimeControl` here would have hidden the rename
     * that turned the historical close into a runtime 501.
     */
    control: h.relay,
    secret: CONTROL_SECRET,
    // Port 0: the OS picks, so two cases can never collide on 8788.
    port: 0,
  });

  try {
    const response = await fetch(`${server.url}/control/status`, {
      method: "POST",
      headers: { [SECRET_HEADER]: CONTROL_SECRET },
    });

    return (await response.json()) as Record<string, unknown>;
  } finally {
    await server.close();
  }
}

/**
 * Waits for an event to reach the ledger.
 *
 * The record and the ledger are written by two different paths and the record
 * is written first: a test that reads the ledger straight after watching a
 * stage would be reading the past.
 */
async function waitForLedgerEvent(
  h: Awaited<ReturnType<typeof makeHarness>>,
  taskId: string,
  event: string,
  read: (taskId: string) => Promise<string[]> = (theId: string) => h.history(theId),
  timeoutMs = 3000,
): Promise<void> {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const events = await read(taskId);
    if (events.includes(event)) return;
    await sleep(5);
  }

  throw new Error(`timed out waiting for ${event} in the ledger of ${taskId}`);
}

describe("input confirmation", () => {
  /*
   * The one send failure the task may walk away from: nothing was clicked, so
   * the task is provably unsent and going back to the queue cannot duplicate
   * anything.
   */
  it("does not click when the composer never held the payload", async () => {
    const h = await makeHarness();
    h.delivery = "input_mismatch";

    await h.startTask("t-input");

    // The text reached the adapter and stopped there.
    expect(h.sentToWorkBuddy).toEqual([taskBlock("t-input")]);
    expect(h.clicks).toBe(0);

    const held = h.store.snapshot().currentTask;
    expect(held?.taskId).toBe("t-input");
    expect(held?.execution?.stage).toBe("BLOCKED");

    await flushUntil(() => (h.store.snapshot().pending as PendingItem[]).length === 1);
    expect(h.sentToChatGpt).toHaveLength(0);
    expect(h.waitCalls).toBe(0);
  });
});

describe("send confirmation", () => {
  /*
   * The click is the start of the unknown, not the end of it. A swallowed
   * click and a half-finished send look identical from the log, and both are
   * a reconciliation case - never an implicit success.
   */
  it("never calls a successful click a confirmed send", async () => {
    const h = await makeHarness();
    h.delivery = "click_only";

    await h.startTask("t-click");
    // Let the failed confirmation settle.
    await flushUntil(() =>
      h.auditEvents.some((e) => e.event === "dispatch_unconfirmed"),
    );

    // The button really was clicked...
    expect(h.clicks).toBe(1);
    // ...and that is all that happened.
    expect(stageOf(h)).toBe("RECONCILIATION_REQUIRED");
    expect(h.store.snapshot().currentTask?.status).toBe("sending");
    expect(h.store.snapshot().pending).toHaveLength(0);
    expect(h.sentToChatGpt).toHaveLength(0);
    expect(h.waitCalls).toBe(0);

    // Nothing was requeued: the send may already have happened.
    expect(h.auditEvents.some((e) => e.event === "task_requeued")).toBe(false);
  });

  it("refuses a new turn that belongs to another task", async () => {
    const h = await makeHarness();
    h.delivery = "wrong_task";

    await h.startTask("t-other");
    await flushUntil(() => h.auditEvents.some((e) => e.event === "dispatch_unconfirmed"));

    expect(h.clicks).toBe(1);
    expect(stageOf(h)).toBe("RECONCILIATION_REQUIRED");
    expect(h.waitCalls).toBe(0);
    expect(h.store.snapshot().pending).toHaveLength(0);
  });
});

describe("running confirmation", () => {
  it("records real processing as the moment WorkBuddy started working", async () => {
    const h = await makeHarness();

    await h.startTask("t-running");
    await h.finish();

    const held = h.store.snapshot().currentTask;
    expect(held?.taskId).toBe("t-running");

    /*
     * The id on the record is the one the page actually showed, not the
     * handle the adapter hands back: a message WorkBuddy never showed cannot
     * be recognised later as this round's.
     */
    expect(held?.workbuddyOutboundMessageId).toBe("turn-t-running");

    expect(held?.execution?.stage).toBe("RESULT_RECEIVED");

    // The whole chain, in the order the facts arrived.
    await waitForLedgerEvent(h, "t-running", "RESULT_RECEIVED");

    expect(await h.history("t-running")).toEqual([
      "TASK_PUBLISHED",
      "TASK_ACCEPTED",
      "DISPATCH_STARTED",
      "INPUT_CONFIRMED",
      "SEND_CONFIRMED",
      "RUNNING_CONFIRMED",
      "RESULT_RECEIVED",
    ]);
  });

  it("accepts a result that landed before any processing was seen", async () => {
    const h = await makeHarness();
    h.running = "result_ready";

    await h.startTask("t-fast");
    await h.finish();

    // A finished answer is still the task having run: it is not stalled.
    expect(h.store.snapshot().currentTask?.execution?.stage).toBe("RESULT_RECEIVED");
    expect(h.auditEvents.some((e) => e.event === "dispatch_unconfirmed")).toBe(false);
  });

  /*
   * The accident the whole delivery module exists for: WorkBuddy cancelled a
   * turn it had already run. Cancelling is not proof that nothing happened,
   * so the round freezes as evidence and only a human sends it again.
   */
  it("treats a cancellation after the send as evidence, not as a retry", async () => {
    const h = await makeHarness();
    h.running = "cancelled";

    await h.startTask("t-cancelled");
    await flushUntil(() => h.relay.status().reconciliationHold === true);

    expect(stageOf(h)).toBe("RECONCILIATION_REQUIRED");
    expect(h.auditEvents.some((e) => e.event === "task_requeued")).toBe(false);
    expect(h.sentToChatGpt).toHaveLength(0);

    // Only a decision puts it back on the queue, and the decision is one.
    const resolved = await h.relay.resolveReconciliation("the cancellation was false");
    expect(resolved.ok).toBe(true);

    const queued = h.store.snapshot().pending as PendingItem[];
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      kind: "gpt_task",
      taskId: "t-cancelled",
      retryCount: 1,
      reason: "reconciled: the cancellation was false",
    });
  });

  it("leaves a turn that neither ran nor answered for reconciliation", async () => {
    const h = await makeHarness();
    h.running = "timeout";

    await h.startTask("t-silent");
    await flushUntil(() => stageOf(h) === "RECONCILIATION_REQUIRED");

    expect(h.auditEvents.some((e) => e.event === "task_requeued")).toBe(false);
    expect(h.sentToChatGpt).toHaveLength(0);
  });
});

describe("result receipt, delivery and acknowledgement", () => {
  it("persists the answer before it delivers it", async () => {
    const h = await makeHarness();

    await h.startTask("t-persist");
    await h.finish();

    // The ledger is written after the record, not with it.
    await waitForLedgerEvent(h, "t-persist", "RESULT_PERSISTED");
    await waitForLedgerEvent(h, "t-persist", "RESULT_DELIVERED");

    const events = await h.history("t-persist");

    /*
     * Persisting the RESULT is what makes the delivery survivable: the
     * queued answer is the only thing that is still there if the relay dies
     * between the two events below, and asking WorkBuddy to run the task
     * again would be far worse than sending the answer twice.
     */
    expect(events.indexOf("RESULT_PERSISTED")).toBeGreaterThan(-1);
    expect(events.indexOf("RESULT_PERSISTED")).toBeLessThan(events.indexOf("RESULT_DELIVERED"));

    /*
     * The durable copy is released only once the delivery is on the record,
     * so a crash in that window leaves something to re-deliver.
     */
    await flushUntil(
      () => (h.store.snapshot().pending as PendingItem[]).length === 0,
      3000,
      "the queued RESULT to be released after delivery",
    );
  });

  /*
   * The other side of that rule: with nobody to deliver to, the answer stays
   * queued instead of being lost with the in-memory record.
   */
  it("keeps the answer queued when there is nobody to deliver it to", async () => {
    const h = await makeHarness();
    h.connected = false;

    await h.startTask("t-queued");
    await h.finish();
    await flushUntil(() => stageOf(h) === "RESULT_PERSISTED");

    expect(h.sentToChatGpt).toHaveLength(0);

    const queued = h.store.snapshot().pending as PendingItem[];
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      kind: "workbuddy_result",
      taskId: "t-queued",
      workbuddyMessageId: "wb-1",
    });
    expect(queued[0]?.text ?? "").toContain("TYPE: RESULT");
  });

  it("separates delivery from acknowledgement, and closes on the second one", async () => {
    const h = await makeHarness();
    // A delivered answer is held, so delivery and acknowledgement can be told
    // apart; the acknowledgement is issued by hand below.
    h.autoAck = false;

    await h.startTask("t-deliver");
    await h.finish();

    /*
     * The bridge took the text: that is delivery. The round is not over,
     * because nothing has said ChatGPT actually received it.
     */
    await flushUntil(() => stageOf(h) === "RESULT_DELIVERED");
    expect(h.sentToChatGpt.filter((text) => text.includes("TYPE: RESULT"))).toHaveLength(1);

    // The durable copy is released only once the delivery is on the record.
    await flushUntil(
      () =>
        h.store.snapshot().currentTask?.status === "sent_to_gpt" &&
        (h.store.snapshot().pending as PendingItem[]).length === 0,
      3000,
      "the delivery to be recorded and the queued RESULT released",
    );
    expect(h.store.snapshot().currentTask?.status).toBe("sent_to_gpt");
    expect(h.store.snapshot().pending).toHaveLength(0);
    expect(
      h.auditEvents.some(
        (e) => e.event === "round_completed" && e.payload.reason === "result_delivered",
      ),
    ).toBe(false);

    // The acknowledgement arrives: the round closes now, and not before.
    await h.raw({ type: "chatgpt_send_result", requestId: null, ok: true, sent: true });
    await flushUntil(() => h.store.snapshot().currentTask === null);

    expect(
      h.auditEvents.some(
        (e) => e.event === "round_completed" && e.payload.reason === "gpt_send_confirmed",
      ),
    ).toBe(true);
    expect(h.auditEvents.find((e) => e.event === "chatgpt_send_result")?.payload).toMatchObject({
      ok: true,
      sent: true,
    });
  });

  it("does not let an acknowledgement belonging to another round close a live one", async () => {
    const h = await makeHarness();

    await h.startTask("t-live");
    await flushUntil(
      () => h.store.snapshot().currentTask?.status === "waiting_workbuddy",
      3000,
      "the send to be confirmed",
    );

    // An extension still answering something older must not be read as this
    // round's delivery.
    await h.raw({ type: "chatgpt_send_result", requestId: null, ok: true, sent: true });

    expect(h.store.snapshot().currentTask?.taskId).toBe("t-live");
    expect(h.store.snapshot().currentTask?.execution?.stage).not.toBe("RESULT_ACKED");
    expect(h.store.snapshot().currentTask?.status).toBe("waiting_workbuddy");
  });

  it("refuses to deliver an answer that names another task", async () => {
    const h = await makeHarness();

    await h.startTask("t-mismatch");
    await flushUntil(() => h.waiting());

    // WorkBuddy answers something else, and the relay says so instead of
    // handing a foreign answer to ChatGPT.
    h.answerWith(
      [
        "[ZHIXING_RELAY]",
        "TYPE: RESULT",
        "TASK_ID: t-elsewhere",
        "SOURCE: WORKBUDDY",
        "",
        "not this task",
      ].join("\n"),
    );

    // The record moves first and the audit follows it, so the fact that the
    // round stopped here is what is waited for.
    await flushUntil(
      () => h.auditEvents.some((e) => e.event === "workbuddy_result_task_mismatch"),
      3000,
      "the mismatch to be reported",
    );

    expect(stageOf(h)).toBe("RECONCILIATION_REQUIRED");
    expect(h.sentToChatGpt).toHaveLength(0);
  });

  it("closes the round once the acknowledgement lands, and the queue moves on", async () => {
    const h = await makeHarness();

    await h.startTask("t-ack");
    await h.finish();

    // The round closes on the acknowledgement, and only then.
    await flushUntil(
      () => h.auditEvents.some((e) => e.event === "round_completed"),
      3000,
      "the round to close",
    );

    expect(h.store.snapshot().currentTask).toBeNull();
    expect(h.store.snapshot().state).toBe("IDLE");

    // A late echo of an acknowledgement must not resurrect a finished round.
    await h.raw({ type: "chatgpt_send_result", requestId: null, ok: true, sent: true });
    expect(h.auditEvents.filter((e) => e.event === "round_completed")).toHaveLength(1);
  });
});

describe("restart recovery", () => {
  it("re-delivers a persisted answer without running the task again", async () => {
    const h = await makeHarness();

    // A round that delivered its answer and never got an acknowledgement.
    await h.store.enqueue({
      kind: "workbuddy_result",
      id: "pending-wb-restart",
      taskId: "t-restart",
      text: [
        "[ZHIXING_RELAY]",
        "TYPE: RESULT",
        "TASK_ID: t-restart",
        "SOURCE: WORKBUDDY",
        "",
        RESULT_BODY,
      ].join("\n"),
      workbuddyMessageId: "wb-1",
      createdAt: new Date().toISOString(),
    });

    await h.store.mutate((state) => {
      state.currentTask = {
        taskId: "t-restart",
        sourceFingerprint: "fp-restart",
        sourceText: taskBlock("t-restart"),
        startedAt: new Date().toISOString(),
        status: "sent_to_gpt",
        sentToGptAt: new Date(Date.now() - 60_000).toISOString(),
        workbuddyOutboundMessageId: "wb-1",
      };
      state.state = "WAIT_GPT";
    });

    const replay = await h.restart();
    expect(h.store.snapshot().paused).toBe(true);

    await replay.relay.resume();

    /*
     * The fresh relay has no lease of its own, so the first inbound message
     * is what expires the stale one - the same path a live relay takes when
     * an acknowledgement never arrives.
     */
    await replay.push({ type: "chatgpt_page_ready", title: "recovered" });

    await flushUntil(
      () => replay.sentToChatGpt.filter((text) => text.includes("TYPE: RESULT")).length === 1,
      3000,
      "the RESULT to be re-delivered",
    );

    // The answer went out exactly once...
    expect(
      replay.sentToChatGpt.filter((text) => text.includes("TYPE: RESULT")),
    ).toHaveLength(1);
    // ...and WorkBuddy was never asked to do the work a second time.
    expect(replay.sentToWorkBuddy).toHaveLength(0);
    expect(h.store.snapshot().currentTask).toBeNull();
  });
});

/**
 * The two hour accident this repair exists for.
 *
 * WorkBuddy had taken the task and was working on it; the answer never
 * arrived inside the window. The instinct of a turn loop is to retry, and a
 * retry here typed the user's request into WorkBuddy a second time, while the
 * first turn - which had not finished - was still going. A wait that runs out
 * is therefore not a failed send: it is a fact about a task that may already
 * be running somewhere.
 */
describe("a result wait that runs out after WorkBuddy already had the task", () => {
  it("freezes the round instead of requeuing it, and never sends a second time", async () => {
    const h = await makeHarness();

    /*
     * The real window is two hours; the fake names the same number in the
     * error so the classification under test is the production one, but it
     * gives up quickly so the case does not have to wait for it.
     */
    h.waitWindow = { budgetMs: 7_200_000, failsAfterMs: 15 };
    // WorkBuddy is definitely working on the payload before the wait runs out.
    h.running = "running";

    await h.startTask("t-slow");

    await flushUntil(
      () => h.auditEvents.some((event) => event.event === "workbuddy_wait_failed"),
      3000,
      "the wait to run out",
    );

    // The failure is recorded as a freeze, not as a failure that earned a retry.
    const frozen = h.auditEvents.find((event) => event.event === "workbuddy_wait_failed");
    expect(frozen?.payload.action).toBe("frozen_for_human_decision");
    expect(frozen?.payload.error).toContain("Timed out waiting WorkBuddy after 7200000ms");

    /*
     * Nothing moved on: no requeue was written, so the queue stays empty and
     * the turn was not handed back to a router that would send it again.
     */
    expect(h.auditEvents.some((event) => event.event === "task_requeued")).toBe(false);
    expect(h.auditEvents.some((event) => event.event === "workbuddy_turn_failed")).toBe(false);
    expect(h.store.snapshot().pending).toHaveLength(0);

    /*
     * The original dispatch is untouched. A freeze keeps the evidence a human
     * needs - which task, which dispatch, which message, which stage - so a
     * second dispatch cannot be confused with the first one.
     */
    const held = h.store.snapshot().currentTask;
    expect(held?.taskId).toBe("t-slow");
    expect(held?.dispatchId).toBe("t-slow#0");
    expect(held?.workbuddyOutboundMessageId).toBe("turn-t-slow");
    expect(held?.execution?.stage).toBe("RECONCILIATION_REQUIRED");

    // One send, one click, one wait: the task was never dispatched twice.
    expect(h.sentToWorkBuddy.filter((text) => text.includes("t-slow"))).toHaveLength(1);
    expect(h.clicks).toBe(1);
    expect(h.waitCalls).toBe(1);

    // scheduling is not left holding anything the next task may trip over
    expect(h.auditEvents.some((event) => event.event === "dispatch_unconfirmed")).toBe(false);

    /*
     * The ledger shows the same story: the chain reaches the point of no
     * return and stops there. No requeue line, and no second dispatch.
     */
    const history = await h.history("t-slow");

    expect(history.indexOf("SEND_CONFIRMED")).toBeGreaterThanOrEqual(0);
    expect(history.indexOf("RUNNING_CONFIRMED")).toBeGreaterThan(history.indexOf("SEND_CONFIRMED"));
    expect(history).toContain("DISPATCH_STALLED");

    expect(history).not.toContain("TASK_REQUEUED");
    expect(history).not.toContain("TASK_ENQUEUED");
    expect(history).not.toContain("DISPATCH_RETRY");

    /*
     * And the freeze holds the line for the next task: a round that is still
     * in flight owns the schedule, so a new task waits instead of overwriting
     * the record the human is about to read.
     */
    await h.raw({
      type: "chatgpt_assistant_message",
      text: taskBlock("t-after-freeze"),
      fingerprint: "fp-after",
    });

    await flushUntil(
      () => h.store.snapshot().pending.some((item) => item.text.includes("t-after-freeze")),
      3000,
      "the next task to wait its turn",
    );

    expect(h.sentToWorkBuddy.filter((text) => text.includes("t-slow"))).toHaveLength(1);
    expect(stageOf(h)).toBe("RECONCILIATION_REQUIRED");
    expect(h.store.snapshot().currentTask?.taskId).toBe("t-slow");
  });

  it("keeps the frozen dispatch's evidence when the relay restarts", async () => {
    const h = await makeHarness();
    h.waitWindow = { budgetMs: 7_200_000, failsAfterMs: 15 };
    h.running = "running";

    await h.startTask("t-slow-restart");
    await flushUntil(
      () => h.auditEvents.some((event) => event.event === "workbuddy_wait_failed"),
      3000,
      "the wait to run out",
    );

    const before = h.store.snapshot().currentTask;
    expect(before?.execution?.stage).toBe("RECONCILIATION_REQUIRED");

    /*
     * The window is cleared for the replay, so the resumed wait can actually
     * hear the answer: what is being tested is that the restart went back to
     * the ALREADY SENT message, not that the task was sent again.
     */
    h.waitWindow = null;

    const replay = await h.restart();
    await replay.relay.resume();

    /*
     * A restarted relay reads the durable record, not a status string the
     * freeze happened to write: the task is mid-flight in WorkBuddy, so the
     * only honest move is to wait for that very message. The task text must
     * never appear in sendText again.
     */
    await flushUntil(() => replay.waiting?.() === true, 3000, "the recovered wait to start");

    expect(replay.sentToWorkBuddy.filter((text) => text.includes("t-slow-restart"))).toHaveLength(0);

    // The evidence a human would have to read is still the original one.
    const after = h.store.snapshot().currentTask;
    expect(after?.taskId).toBe("t-slow-restart");
    expect(after?.dispatchId).toBe(before?.dispatchId);
    expect(after?.workbuddyOutboundMessageId).toBe(before?.workbuddyOutboundMessageId);

    // The recovered wait listens to the original message and delivers once.
    replay.answerWith(RESULT_BODY);

    await flushUntil(
      () => replay.sentToChatGpt.filter((text) => text.includes("TYPE: RESULT")).length === 1,
      3000,
      "the recovered answer to be delivered",
    );

    expect(replay.sentToChatGpt.filter((text) => text.includes("TYPE: RESULT"))).toHaveLength(1);
  });
});

describe("control surface", () => {
  it("reports where a dispatch stands, without leaking its history", async () => {
    const h = await makeHarness();
    // Held on purpose: the stage this round is in must be observable.
    h.runningDelayMs = 80;

    await h.startTask("t-status");
    await flushUntil(() => stageOf(h) === "SEND_CONFIRMED");

    const status = h.relay.status();
    expect(status).toMatchObject({
      reconciliationHold: false,
      currentAttempt: 0,
      executionStage: "SEND_CONFIRMED",
    });
    expect(status.currentDispatchId).toBe("t-status#0");
    expect(typeof status.executionStageStartedAt).toBe("string");
    expect(typeof status.executionLastProgressAt).toBe("string");
    expect(typeof status.ledgerEventCount).toBe("number");

    /*
     * The chain itself is the ledger's to keep: the status screen answers
     * "where is it now", so it carries the stage and nothing of the road
     * taken to reach it.
     */
    const overHttp = await controlStatus(h);
    expect(overHttp).toMatchObject({
      ok: true,
      reconciliationHold: false,
      currentAttempt: 0,
      executionStage: "SEND_CONFIRMED",
      currentDispatchId: "t-status#0",
    });
    expect(overHttp).not.toHaveProperty("executionHistory");
    expect(overHttp).not.toHaveProperty("history");

    // The running confirmation is what gates the wait for the answer.
    expect(h.waitCalls).toBe(0);
    h.answerWith(RESULT_BODY);
  });

  /*
   * A resume answers a request that is already late. It has to hand the HTTP
   * caller its 200 and let the turn keep going without it.
   */
  it("returns from resume without waiting for WorkBuddy to answer", async () => {
    const h = await makeHarness();

    await h.store.mutate((state) => {
      state.currentTask = {
        taskId: "t-resume",
        sourceFingerprint: "fp-resume",
        sourceText: taskBlock("t-resume"),
        startedAt: new Date().toISOString(),
        status: "waiting_workbuddy",
        workbuddyOutboundMessageId: "wb-1",
      };
      state.state = "WAIT_WORKBUDDY";
    });

    const started = Date.now();
    await h.relay.resume();

    /*
     * The turn is still hanging on the answer: a resume that awaited it
     * could not have returned at all.
     */
    expect(h.waitCalls).toBe(0);
    expect(Date.now() - started).toBeLessThan(500);

    await flushUntil(() => h.waitCalls === 1);
    h.answerWith(RESULT_BODY);
    await flushUntil(() => h.store.snapshot().currentTask === null);
  });

  /** A hold may append to the ledger, never rewrite it. */
  it("keeps the ledger intact while reconciling a held task", async () => {
    const h = await makeHarness();
    h.running = "cancelled";

    await h.startTask("t-held");
    await flushUntil(() => h.relay.status().reconciliationHold === true);

    const before = await ledgerLines(join(sandboxRoot, `case-${seq}`));

    await h.relay.resolveReconciliation("a human looked at the page");
    await flushUntil(() => h.auditEvents.some((e) => e.event === "task_requeued"), 3000);

    // The resolution is filed against no task, so it is read from the whole
    // ledger rather than from one task's chain.
    await waitForLedgerEvent(h, "*", "RECONCILIATION_RESOLVED", () => h.ledger());

    const after = await ledgerLines(h.dir);

    /*
     * Every earlier line is still there, in the same order: a resolution is
     * a new fact about an old chain, not a correction of one.
     */
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.length).toBeGreaterThan(before.length);

    const events = await h.ledger();

    /*
     * The hold is one entry in the chain, named after why the round stopped
     * rather than after the stage it stopped in, and lifting it only adds the
     * line that says so.
     */
    expect(events).toContain("DISPATCH_STALLED");
    expect(events).toContain("RECONCILIATION_RESOLVED");
    expect(events.indexOf("DISPATCH_STALLED")).toBeLessThan(events.indexOf("RECONCILIATION_RESOLVED"));
  });

  /*
   * A task sitting in the queue is not a task the relay lost.
   *
   * Reconciliation is handed the live queue and the task in flight, and it is
   * only with them that it can tell "still mine" from "forgotten": a chain the
   * ledger knows but the state file no longer lists is exactly what a
   * reconciliation exists to describe, and the same chain described while the
   * relay still has it queued is nothing at all.
   *
   * The pass is run by closing an unrelated task, so that the chain under test
   * is judged by the ledger alone and not by the closure that triggers it.
   */
  it("does not reconcile a queued task as a task it lost", async () => {
    const h = await makeHarness();

    const log = new TaskLedger(pathToFileURL(join(h.dir, "ledger.jsonl")));
    await log.append({
      event: "TASK_PUBLISHED",
      taskId: "t-queued",
      taskFingerprint: "fp-queued",
      source: "gpt",
    });
    await log.append({
      event: "DISPATCH_STARTED",
      taskId: "t-queued",
      taskFingerprint: "fp-queued",
      dispatchId: "t-queued#0",
      attempt: 0,
      source: "relay",
    });

    await h.store.enqueue({
      kind: "gpt_task",
      id: "pending-queued",
      text: taskBlock("t-queued"),
      fingerprint: "fp-queued",
      createdAt: new Date().toISOString(),
      taskId: "t-queued",
      attempt: 0,
      retryCount: 0,
    });

    const closed = await h.relay.closeReconciledTaskWithoutResend({
      taskId: "t-pass-trigger",
      reason: "the pass this case runs",
    });

    expect(closed.ok).toBe(true);
    // The queued chain is explained by the queue, so it blocks nothing.
    expect(closed.blocked).toBe(false);
    expect(h.store.snapshot().pending).toHaveLength(1);
  });
});
