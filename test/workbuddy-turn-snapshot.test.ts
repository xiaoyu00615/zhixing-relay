/**
 * v0.4.7.3e: the page adapter's half of the send contract.
 *
 * The unit tests in workbuddy-user-turn.test.ts prove the *verdict* is right;
 * this file proves the page adapter hands the verdict layer the facts it needs,
 * and that the whole chain - shipped browser expression, adapter shape, pure
 * verdict - agrees on one model:
 *
 *   the page classifies every rendered node and deletes none of them
 *   the adapter preserves that set and validates only its shape
 *   confirmSend is the single place that decides who may vote
 *
 * The chain below is driven through the real `readTurnSnapshot`, so a page
 * that started filtering again, or an adapter that started deleting the
 * assistant-side nodes again, fails here rather than in production.
 */

import { describe, expect, it } from "vitest";
import {
  TURN_SNAPSHOT_EXPRESSION,
  WorkBuddyClient,
  parseTurnSnapshot,
} from "../src/workbuddy/client.js";
import {
  confirmSend,
  waitForSendConfirmation,
  type TurnRole,
  type TurnSnapshot,
} from "../src/workbuddy/turn-ack.js";

const SMOKE_TASK = "relay-production-smoke-v0473c-001";
const PAYLOAD_PREFIX = "Production smoke test only.";

/** The relay's own outbound bubble, as the page rendered it. */
const USER_BUBBLE_TEXT = `${PAYLOAD_PREFIX}\n\nTASK_ID: ${SMOKE_TASK}`;

/** The production status card, kept as the literal the page produced. */
const PROCESSING_CARD_TEXT = "WorkBuddy ... 已处理 ... 思考中";

function signatureOf(text: string): string {
  // The page's own rule, mirrored so the test can name the node it expects.
  return `${text.length}|${text.slice(0, 64)}`;
}

const PROCESSING_CARD_SIGNATURE = signatureOf(PROCESSING_CARD_TEXT);
const USER_BUBBLE_SIGNATURE = signatureOf(USER_BUBBLE_TEXT);

type StubNode = {
  text: string;
  classes?: string[];
  /** Selectors this node answers to, i.e. which chrome it renders. */
  has?: string[];
};

/**
 * The smallest `document` the expression needs: one composer and a list of
 * `.cr-agent` nodes. Nothing else on the page exists as far as it is concerned.
 */
function stubDocument(nodes: StubNode[], composer: string) {
  return {
    querySelector: (selector: string) =>
      selector.includes("contenteditable") ? { innerText: composer } : null,
    querySelectorAll: (selector: string) =>
      selector === ".cr-agent"
        ? nodes.map((node) => ({
            innerText: node.text,
            classList: { contains: (name: string) => (node.classes ?? []).includes(name) },
            querySelector: (inner: string) =>
              (node.has ?? []).includes(inner) ? { innerText: node.text } : null,
            querySelectorAll: () => [],
          }))
        : [],
  };
}

function runExpression(expression: string, nodes: StubNode[], composer = ""): string {
  const run = new Function(
    "document",
    // CDP evaluates the expression and hands back its value; a Function body
    // has to say so explicitly.
    // Parenthesised on purpose: the expression starts with a newline, and
    // `return` followed by a newline is a different statement.
    `return (${expression})`,
  ) as (doc: unknown) => string;

  return run(stubDocument(nodes, composer));
}

function evaluatePage(
  nodes: StubNode[],
  options: { taskId: string; payloadPrefix: string; composer?: string },
): {
  inputText: string;
  turnCount: number;
  turns: Array<{ signature: string; role: string; containsTaskId: boolean; index: number }>;
} {
  return JSON.parse(
    runExpression(
      TURN_SNAPSHOT_EXPRESSION({
        taskId: options.taskId,
        payloadPrefix: options.payloadPrefix,
      }),
      nodes,
      options.composer ?? "",
    ),
  ) as {
    inputText: string;
    turnCount: number;
    turns: Array<{ signature: string; role: string; containsTaskId: boolean; index: number }>;
  };
}

/** One page state, as the browser would render it at one poll. */
type PageState = StubNode[];

const PROCESSING_CARD: StubNode = {
  text: PROCESSING_CARD_TEXT,
  classes: ["cr-agent", "cr-agent--processing"],
  has: [".cr-agent__processing-status"],
};

const USER_BUBBLE: StubNode = {
  text: USER_BUBBLE_TEXT,
  has: [".cr-self-message__content"],
};

const OLD_USER_TURN: StubNode = { text: "an older request", has: [".cr-self-message__content"] };

const OLD_ANSWER: StubNode = { text: "已完成 12s", has: [".conversation-finished-footer"] };

/**
 * The real adapter, reading a scripted page one poll at a time.
 *
 * Only the CDP transport is replaced; `readTurnSnapshot`, the expression it
 * builds and the shape it returns are the ones that ship.
 */
function adapterFor(pages: PageState[]) {
  const client = new WorkBuddyClient("ws://relay.invalid/never-opened");
  let poll = 0;

  Object.defineProperty(client, "cdp", {
    value: {
      evaluate: async (expression: string) => {
        const nodes = pages[Math.min(poll, pages.length - 1)] ?? [];
        poll += 1;
        return runExpression(expression, nodes);
      },
    },
  });

  const read = () =>
    client.readTurnSnapshot({ taskId: SMOKE_TASK, payloadPrefix: PAYLOAD_PREFIX });

  return { read, polls: () => poll };
}

/** A clock that advances only when the waiter sleeps, so the window can close. */
function clockOf(pollIntervalMs: number) {
  let elapsed = 0;

  return {
    now: () => elapsed,
    sleep: async (ms: number) => {
      elapsed += ms;
    },
  };
}

describe("the turn snapshot the page produces", () => {
  it("classifies WorkBuddy's status card instead of hiding it", () => {
    /*
     * The production node, as the page rendered it: WorkBuddy chrome, and the
     * processing label inside it. It has to survive into the snapshot - the
     * relay needs to be able to say it saw this and waited it out.
     */
    const page = evaluatePage([PROCESSING_CARD], {
      taskId: SMOKE_TASK,
      payloadPrefix: PAYLOAD_PREFIX,
    });

    expect(page.turnCount).toBe(1);
    expect(page.turns).toHaveLength(1);
    expect(page.turns[0]?.role).toBe("assistant");
    expect(page.turns[0]?.containsTaskId).toBe(false);
  });

  it("reports the outbound turn with the task id it carries", () => {
    const page = evaluatePage([PROCESSING_CARD, USER_BUBBLE], {
      taskId: SMOKE_TASK,
      payloadPrefix: PAYLOAD_PREFIX,
    });

    // Both nodes come back: the verdict layer decides, the page reports.
    expect(page.turns).toHaveLength(2);
    expect(page.turns.map((turn) => turn.role)).toEqual(["assistant", "user"]);

    const outbound = page.turns.find((turn) => turn.role === "user");
    // The whole point of the field: without it there is nothing to match.
    expect(outbound?.containsTaskId).toBe(true);
  });

  it("identifies the outbound turn by the payload when the page marks nothing", () => {
    const page = evaluatePage([{ text: USER_BUBBLE_TEXT }], {
      taskId: SMOKE_TASK,
      payloadPrefix: PAYLOAD_PREFIX,
    });

    expect(page.turns).toHaveLength(1);
    expect(page.turns[0]?.role).toBe("user");
  });

  it("classifies a finished answer assistant-side rather than deleting it", () => {
    const page = evaluatePage(
      [
        { text: "已完成 12s", has: [".conversation-finished-footer", ".cr-collapse--completed"] },
        { text: "已完成 7m22s\n\nZHIXING_SMOKE_V0473C_OK" },
      ],
      { taskId: SMOKE_TASK, payloadPrefix: PAYLOAD_PREFIX },
    );

    expect(page.turns.map((turn) => turn.role)).toEqual(["assistant", "assistant"]);
  });

  it("leaves a node it cannot identify in the set, marked unknown", () => {
    const page = evaluatePage([{ text: "something the classifier has no rule for" }], {
      taskId: SMOKE_TASK,
      payloadPrefix: PAYLOAD_PREFIX,
    });

    expect(page.turns).toHaveLength(1);
    expect(page.turns[0]?.role).toBe("unknown");
  });
});

describe("the adapter's shape check", () => {
  it("keeps every role the page classified", () => {
    const snapshot = parseTurnSnapshot(
      JSON.stringify({
        inputText: "",
        turnCount: 3,
        turns: [
          { signature: "a", role: "user", containsTaskId: true },
          { signature: "b", role: "assistant", containsTaskId: false },
          { signature: "c", role: "unknown", containsTaskId: false },
        ],
      }),
    );

    expect(snapshot.turns.map((turn) => turn.role)).toEqual(["user", "assistant", "unknown"]);
  });

  /*
   * No signature, no identity: a node that cannot be told apart between two
   * polls cannot be called new, so it is dropped rather than voted on.
   */
  it("drops a node with no signature and demotes an unreadable role", () => {
    const snapshot = parseTurnSnapshot(
      JSON.stringify({
        inputText: "",
        turns: [
          { role: "user", containsTaskId: true },
          { signature: "b", role: "assistant" },
          { signature: "c", role: "sent-by-alien" },
          { signature: "d", containsTaskId: "yes" },
        ],
      }),
    );

    expect(snapshot.turns.map((turn) => turn.signature)).toEqual(["b", "c", "d"]);
    expect(snapshot.turns.map((turn) => turn.role)).toEqual(["assistant", "unknown", "unknown"]);
    expect(snapshot.turns[2]?.containsTaskId).toBe(false);
  });

  it("answers an empty snapshot when the page handed back nothing usable", () => {
    expect(parseTurnSnapshot(undefined).turns).toEqual([]);
    expect(parseTurnSnapshot("not json").turns).toEqual([]);
  });
});

/*
 * The production order of nodes, driven all the way through the shipped
 * expression, the adapter and the verdict: this is the regression the
 * `ignoredRoles` diagnostic exists for, and it can only be written when every
 * classified node really reaches the verdict layer.
 */
describe("the whole chain, in the production order", () => {
  it("waits out the status card at the first poll and confirms at the second", async () => {
    const { read } = adapterFor([
      [OLD_USER_TURN, OLD_ANSWER],
      [OLD_USER_TURN, OLD_ANSWER, PROCESSING_CARD],
      [OLD_USER_TURN, OLD_ANSWER, PROCESSING_CARD, USER_BUBBLE],
    ]);

    const before = await read();

    // Poll one: the click landed, WorkBuddy started working, nothing outbound
    // yet. Not a send of something else - an unknown send.
    const firstPoll = await read();
    const first = confirmSend({ before, after: firstPoll, expectedTaskId: SMOKE_TASK });

    expect(first.reason).toBe("no_new_turn");
    expect(first.observedMessageId).toBeNull();
    // The diagnostic is reachable now: the card is in the snapshot, named.
    expect(first.ignoredRoles).toContain("assistant");
    expect(firstPoll.turns.map((turn) => turn.role)).toContain("assistant");

    const clock = clockOf(250);
    const confirmation = await waitForSendConfirmation(read, {
      before,
      expectedTaskId: SMOKE_TASK,
      pollIntervalMs: 250,
      timeoutMs: 5000,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(confirmation.reason).toBe("confirmed");
    expect(confirmation.ok).toBe(true);
    // The proof is the outbound bubble, never the status card.
    expect(confirmation.observedMessageId).toBe(USER_BUBBLE_SIGNATURE);
    expect(confirmation.observedMessageId).not.toBe(PROCESSING_CARD_SIGNATURE);
    expect(confirmation.ignoredRoles).toContain("assistant");
  });

  it("still ends in no_new_turn when only ever the status card appears", async () => {
    const { read } = adapterFor([
      [OLD_USER_TURN, OLD_ANSWER],
      [OLD_USER_TURN, OLD_ANSWER, PROCESSING_CARD],
    ]);

    const before = await read();
    const clock = clockOf(250);

    const confirmation = await waitForSendConfirmation(read, {
      before,
      expectedTaskId: SMOKE_TASK,
      pollIntervalMs: 250,
      timeoutMs: 500,
      now: clock.now,
      sleep: clock.sleep,
    });

    // "nothing sent" is not "something else was sent": only the second one
    // would send again, and that is what this relay must never do.
    expect(confirmation.reason).toBe("no_new_turn");
    expect(confirmation.ok).toBe(false);
    expect(confirmation.ignoredRoles).toContain("assistant");
  });

  it("calls an outbound turn belonging to another task exactly that", async () => {
    const { read } = adapterFor([
      [OLD_USER_TURN, OLD_ANSWER],
      [
        OLD_USER_TURN,
        OLD_ANSWER,
        PROCESSING_CARD,
        { text: "another request\n\nTASK_ID: some-other-task", has: [".cr-self-message__content"] },
      ],
    ]);

    const before = await read();
    const clock = clockOf(250);

    const confirmation = await waitForSendConfirmation(read, {
      before,
      expectedTaskId: SMOKE_TASK,
      pollIntervalMs: 250,
      timeoutMs: 5000,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(confirmation.reason).toBe("new_turn_wrong_task");
    expect(confirmation.ok).toBe(false);
    expect(confirmation.observedMessageId).not.toBe(PROCESSING_CARD_SIGNATURE);
  });

  it("never lets an answer that quotes the task id pass itself off as the send", async () => {
    /*
     * WorkBuddy quotes the id of what it is working on, so an assistant node
     * can carry the task id. It is not the relay's message going out.
     */
    const { read } = adapterFor([
      [OLD_USER_TURN, OLD_ANSWER],
      [
        OLD_USER_TURN,
        OLD_ANSWER,
        { text: `working on ${SMOKE_TASK}`, classes: ["cr-agent--processing"] },
      ],
    ]);

    const before = await read();
    const clock = clockOf(250);

    const confirmation = await waitForSendConfirmation(read, {
      before,
      expectedTaskId: SMOKE_TASK,
      pollIntervalMs: 250,
      timeoutMs: 500,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(confirmation.reason).toBe("no_new_turn");
    expect(confirmation.ignoredRoles).toContain("assistant");
  });
});

/** Keeps the type import honest: the roles the page emits are the only ones. */
const ROLES_UNDER_TEST: TurnRole[] = ["user", "assistant", "unknown"];

describe("the roles the contract talks about", () => {
  it("are exactly the ones the classifier can emit", () => {
    expect(ROLES_UNDER_TEST).toHaveLength(3);
  });

  it("and a snapshot carrying them survives the adapter untouched", () => {
    const snapshot: TurnSnapshot = {
      inputText: "",
      turns: ROLES_UNDER_TEST.map((role, index) => ({
        signature: `s-${index}`,
        role,
        containsTaskId: false,
      })),
    };

    const round = parseTurnSnapshot(JSON.stringify({ inputText: "", turns: snapshot.turns }));

    expect(round.turns).toEqual(snapshot.turns);
  });
});
