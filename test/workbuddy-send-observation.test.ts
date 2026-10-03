/**
 * v0.4.7.3i: the SEND confirmation false negative that closed a finished task.
 *
 * What production actually did, in order: the durable source proof held, the
 * model selector switched, the composer read back, WorkBuddy ran the task and
 * answered `ZHIXING_SMOKE_V0473E_002_OK` - and the send detector still said
 * `no_new_turn`, so the round went to `RECONCILIATION_REQUIRED` and an operator
 * had to close it by hand.
 *
 * Measured on the live page with the shipped reader, this is why. A `.cr-agent`
 * is WorkBuddy's own round and only WorkBuddy's: its header says "WorkBuddy",
 * its body is the answer, and its chrome rides along with it. The text the
 * relay typed is *not* in that node - it is a `.cr-self-message` sibling, and
 * the document virtualiser can render that bubble more than once with a
 * different `data-user-message-id` each time.
 *
 * So collecting `.cr-agent` only made a fresh outbound turn structurally
 * invisible: every send was scored `no_new_turn`, no matter what the page did.
 *
 * These cases hold the two facts that have to stay true at once:
 *
 *   a user-authored row is collected and is the only thing that can vote
 *   an assistant round - processing, status, answer, completion - never votes
 *
 * The page here is scripted through the *shipped* expression, so a collector
 * that quietly drops the user family fails here rather than in production.
 */

import { describe, expect, it } from "vitest";
import { TURN_SNAPSHOT_EXPRESSION, parseTurnSnapshot } from "../src/workbuddy/client.js";
import { confirmSend, waitForSendConfirmation, type SendConfirmation } from "../src/workbuddy/turn-ack.js";
import { turnTextSignature } from "../src/workbuddy/turn-roles.js";

const TASK_ID = "relay-production-smoke-v0473e-002";
const PAYLOAD_PREFIX = "[ZHIXING_RELAY] TYPE: TASK";
const RESULT_TEXT = "ZHIXING_SMOKE_V0473E_002_OK";

/** What the relay typed, as the page renders it as a user message. */
const OUTBOUND = `${PAYLOAD_PREFIX}\nTASK_ID: ${TASK_ID}\nMODEL: hy3`;

/** A user-authored message row, as the virtualised document renders it. */
function userRow(message: string): Row {
  return { kind: "user", text: message, message };
}

/** WorkBuddy's round, with the chrome the live page measured on it. */
function round(options: { text: string; processing?: boolean; completed?: boolean }): Row {
  const has = options.processing
    ? [".cr-agent__processing-status", ".cr-agent--processing"]
    : options.completed
      ? [".conversation-finished-footer", ".cr-collapse--completed"]
      : [];

  return {
    kind: "assistant",
    text: options.text,
    // The round echoes the prompt back, but it is WorkBuddy's text, not a row.
    has,
    processing: options.processing,
    completed: options.completed,
  };
}

type Row = {
  kind: "user" | "assistant";
  /** The whole innerText of the node. */
  text: string;
  /** What the user row's message element holds. */
  message?: string;
  has?: string[];
  processing?: boolean | undefined;
  completed?: boolean | undefined;
};

/**
 * The smallest `document` the shipped expression needs: a composer and the
 * rows, ordered the way the document orders them.
 *
 * `userRow` answers `classList.contains('cr-self-message')`, which is how the
 * expression tells the two node families apart.
 */
function stubDocument(rows: Row[]) {
  return {
    querySelector: (selector: string) =>
      selector.includes("contenteditable") ? { innerText: "" } : null,
    querySelectorAll: (selector: string) => {
      // Faithful to the selector: a collector that only asks for `.cr-agent`
      // must not be handed the user family, or it would pass while still
      // being blind to the outbound message on the live page.
      const picked = selector.includes(".cr-self-message")
        ? rows
        : rows.filter((row) => row.kind === "assistant");

      return picked.map((row) => ({
        innerText: row.text,
        classList: {
          contains: (name: string) =>
            row.kind === "user" ? name === "cr-self-message" : name === "cr-agent--processing",
        },
        // A user bubble nested inside an assistant round is the round's echo
        // of the prompt; the live page renders the outbound one as a sibling.
        matches: () => false,
        querySelector: (inner: string) =>
          inner === ".cr-self-message__content" && row.kind === "user" && row.message !== undefined
            ? { innerText: row.message }
            : (row.has ?? []).includes(inner)
              ? { innerText: row.text }
              : null,
        querySelectorAll: () => [],
      }));
    },
  };
}

/** Runs the shipped expression against a scripted page. */
function snapshotOf(rows: Row[]) {
  const expression = TURN_SNAPSHOT_EXPRESSION({ taskId: TASK_ID, payloadPrefix: PAYLOAD_PREFIX });

  const run = new Function(
    "document",
    `return (${expression})`,
  ) as (doc: unknown) => string;

  return run(stubDocument(rows));
}

function confirm(before: Row[], after: Row[]): SendConfirmation {
  return confirmSend({
    before: parseTurnSnapshot(snapshotOf(before)),
    after: parseTurnSnapshot(snapshotOf(after)),
    expectedTaskId: TASK_ID,
  });
}

/** The state before the click: the previous task, still on the page. */
const BEFORE: Row[] = [
  userRow("relay-production-smoke-v0473d-001"),
  round({ text: `已完成 21s ${RESULT_TEXT}`, completed: true }),
];

/** A clock that advances only when the waiter sleeps. */
function clockOf(step: number) {
  let elapsed = 0;

  return {
    now: () => elapsed,
    sleep: async (ms: number) => {
      elapsed += ms;
    },
    step,
  };
}

describe("a user-authored row is the send proof", () => {
  it("finds the outbound message when the round around it holds the answer", () => {
    const after: Row[] = [
      ...BEFORE,
      userRow(OUTBOUND),
      round({ text: `已处理 5m44s ${OUTBOUND}`, processing: true }),
    ];

    const confirmation = confirm(BEFORE, after);

    expect(confirmation.ok).toBe(true);
    expect(confirmation.reason).toBe("confirmed");
    expect(confirmation.observedMessageId).toBe(turnTextSignature(OUTBOUND));
    // The round was seen and deliberately ignored.
    expect(confirmation.ignoredRoles).toContain("assistant");
  });

  it("keeps the message's identity while the assistant side runs and finishes", () => {
    const processing = snapshotOf([
      ...BEFORE,
      userRow(OUTBOUND),
      round({ text: `已处理 5m44s ${OUTBOUND}`, processing: true }),
    ]);
    const completed = snapshotOf([
      ...BEFORE,
      userRow(OUTBOUND),
      round({ text: `已完成 21s ${RESULT_TEXT}`, completed: true }),
      round({ text: `已处理 6m02s ${OUTBOUND}`, processing: false }),
    ]);

    // The outbound row, not merely the first user row the page renders.
    const idOf = (raw: unknown) =>
      parseTurnSnapshot(raw)
        .turns.filter((t) => t.role === "user" && t.containsTaskId)
        .map((t) => t.signature)
        .join(",");

    expect(idOf(completed)).toBe(idOf(processing));
    expect(idOf(completed)).toBe(turnTextSignature(OUTBOUND));
  });

  it("confirms the send when the user message only appears afterwards", () => {
    const confirmation = confirm(BEFORE, [...BEFORE, userRow(OUTBOUND)]);

    expect(confirmation.reason).toBe("confirmed");
    expect(confirmation.observedMessageId).toBe(turnTextSignature(OUTBOUND));
  });

  it("still refuses an assistant card, processing or finished, on its own", () => {
    expect(confirm(BEFORE, [...BEFORE, round({ text: "已处理 3s 思考中", processing: true })]).reason).toBe(
      "no_new_turn",
    );
    expect(confirm(BEFORE, [...BEFORE, round({ text: `已完成 21s ${RESULT_TEXT}`, completed: true })]).reason).toBe(
      "no_new_turn",
    );
  });

  it("calls a user row of another task exactly that", () => {
    const confirmation = confirm(BEFORE, [...BEFORE, userRow("SOME OTHER TASK\n\nTASK_ID: relay-other")]);

    expect(confirmation.ok).toBe(false);
    expect(confirmation.reason).toBe("new_turn_wrong_task");
    expect(confirmation.observedMessageId).toBe(turnTextSignature("SOME OTHER TASK\n\nTASK_ID: relay-other"));
  });

  it("reads the task id off the message, not off the container around it", () => {
    /*
     * One `.cr-agent` can still render the outbound message while WorkBuddy
     * appends its own text to the same node. The container then quotes the
     * task id even though the message the relay typed does not - and the
     * message is the only thing that can speak for the send.
     */
    const containerQuotesTheTask: Row = {
      kind: "user",
      text: `some other request\n\n已处理 3s\nTASK_ID: ${TASK_ID}`,
      message: "some other request",
    };

    const confirmation = confirm(BEFORE, [...BEFORE, containerQuotesTheTask]);

    expect(confirmation.ok).toBe(false);
    expect(confirmation.reason).toBe("new_turn_wrong_task");
  });

  it("tells two messages apart even when they open the same way", () => {
    /*
     * The old rule was length plus the first 64 characters. Two messages that
     * share their first 64 characters and their length are indistinguishable
     * to it, so the second one reads as "the turn already seen" and a real
     * send is scored no_new_turn. The head has to be a full 64 characters for
     * that to bite: anything shorter and the tail leaks into the prefix.
     */
    const head = "the relay typed this same opening line for two different tasks".padEnd(64, ".");
    const one = `${head}AAAA`;
    const two = `${head}BBBB`;

    expect(head.length).toBe(64);
    expect(one.slice(0, 64)).toBe(two.slice(0, 64));

    expect(one.length).toBe(two.length);

    const snapshots = [one, two].map((message) =>
      parseTurnSnapshot(snapshotOf([userRow(message)])),
    );

    expect(snapshots.map((s) => s.turns.length)).toEqual([1, 1]);
    expect(snapshots[0]?.turns[0]?.signature).not.toBe(snapshots[1]?.turns[0]?.signature);
    // Distinct messages, distinct identities - the old head-only rule merged them.
    expect(snapshots[0]?.turns[0]?.signature).not.toBe(`${one.length}|${one.slice(0, 64)}`);
  });

  it("recognises the same user turn while the round around it keeps growing", () => {
    const afterRows: Row[] = [
      userRow(OUTBOUND),
      round({ text: `已处理 1s ${OUTBOUND}`, processing: true }),
    ];
    const laterRows: Row[] = [
      userRow(OUTBOUND),
      round({ text: `已处理 9m59s ${OUTBOUND} plus forty kilobytes of answer`, processing: true }),
    ];
    const after = parseTurnSnapshot(snapshotOf(afterRows));
    const later = parseTurnSnapshot(snapshotOf(laterRows));

    const idOf = (snapshot: { turns: Array<{ role: string; containsTaskId: boolean; signature: string }> }) =>
      snapshot.turns
        .filter((turn) => turn.role === "user" && turn.containsTaskId)
        .map((turn) => turn.signature)
        .join(",");

    // The answer grew; the message did not, so it is not a new turn.
    expect(idOf(later)).toBe(idOf(after));
    expect(confirm(BEFORE, [...BEFORE, ...afterRows])).toMatchObject({ reason: "confirmed" });
    expect(confirm([...BEFORE, ...afterRows], [...BEFORE, ...laterRows])).toMatchObject({
      reason: "no_new_turn",
    });
  });

  it("confirms even when the very first poll already shows a completed round", async () => {
    const pages: Row[][] = [
      [userRow(OUTBOUND), round({ text: `已完成 22s ${RESULT_TEXT}`, completed: true })],
    ];
    let poll = 0;

    const clock = clockOf(250);

    const confirmation = await waitForSendConfirmation(
      async () => {
        const rows = pages[Math.min(poll, pages.length - 1)] ?? [];
        poll += 1;
        return parseTurnSnapshot(snapshotOf(rows));
      },
      {
        before: parseTurnSnapshot(snapshotOf(BEFORE)),
        expectedTaskId: TASK_ID,
        pollIntervalMs: clock.step,
        timeoutMs: 5000,
        now: clock.now,
        sleep: clock.sleep,
      },
    );

    expect(confirmation.reason).toBe("confirmed");
    expect(confirmation.observedMessageId).toBe(turnTextSignature(OUTBOUND));
    // The finished round was ignored as evidence of the send; it is not one.
    expect(confirmation.ignoredRoles).toContain("assistant");
  });

  it("collapses the virtualiser's duplicate rows of one message into one turn", () => {
    const snapshot = parseTurnSnapshot(snapshotOf([userRow(OUTBOUND), userRow(OUTBOUND)]));

    expect(snapshot.turns.filter((turn) => turn.role === "user")).toHaveLength(1);
    expect(snapshot.turns.find((turn) => turn.role === "user")?.containsTaskId).toBe(true);
  });
});

/**
 * The production accident, replayed: the older page shape, where the outbound
 * text only ever lives inside WorkBuddy's round, cannot see a send happen; the
 * measured page shape, where it lives in its own row, can.
 */
describe("the production shape of smoke002", () => {
  it("scores no_new_turn when the outbound text is only ever inside the round", () => {
    const oldShape = [...BEFORE, round({ text: `已处理 5m44s ${OUTBOUND}`, processing: true })];

    expect(confirm(BEFORE, oldShape).reason).toBe("no_new_turn");
  });

  it("scores confirmed when that same text is rendered as its own user row", () => {
    const measuredShape = [...BEFORE, userRow(OUTBOUND), round({ text: `已处理 5m44s ${OUTBOUND}`, processing: true })];

    const confirmation = confirm(BEFORE, measuredShape);

    expect(confirmation.ok).toBe(true);
    expect(confirmation.observedMessageId).toBe(turnTextSignature(OUTBOUND));
  });
});

describe("the adapter fails closed on what the page sends back", () => {
  it("drops an unreadable role and demotes a non-boolean task id", () => {
    const snapshot = parseTurnSnapshot(
      JSON.stringify({
        inputText: "",
        turns: [
          // A role the classifier cannot emit, and a task id that is not one.
          { signature: "u1", role: "sent-by-alien", containsTaskId: "yes" },
          // A real role, but the task id arrives as something else.
          { signature: "u2", role: "user", containsTaskId: 1 },
          // No signature at all: the node cannot be told new, so it is dropped.
          { role: "user", containsTaskId: true },
          { signature: "u4", role: "unknown", containsTaskId: true },
        ],
      }),
    );

    expect(snapshot.turns.map((turn) => turn.signature)).toEqual(["u1", "u2", "u4"]);
    expect(snapshot.turns.map((turn) => turn.role)).toEqual(["unknown", "user", "unknown"]);
    expect(snapshot.turns.map((turn) => turn.containsTaskId)).toEqual([false, false, true]);
  });

  it("never lets an answer carry the send on its own", () => {
    // The result text is on the page and belongs to this dispatch, and still
    // the relay has nothing that proves the click published anything.
    const confirmation = confirmSend({
      before: parseTurnSnapshot(snapshotOf(BEFORE)),
      after: parseTurnSnapshot(snapshotOf([...BEFORE, round({ text: `已完成 21s ${RESULT_TEXT}`, completed: true })])),
      expectedTaskId: TASK_ID,
    });

    expect(confirmation.ok).toBe(false);
    expect(confirmation.reason).toBe("no_new_turn");
    expect(confirmation.observedMessageId).toBeNull();
  });
});
