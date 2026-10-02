/**
 * v0.4.7.3d: the production SEND confirmation false failure.
 *
 * The real smoke task `relay-production-smoke-v0473c-001` was typed, clicked,
 * rendered by WorkBuddy, executed, answered with the right result - and
 * recorded as `SEND_CONFIRM_FAILED` / `new_turn_wrong_task`, because the send
 * detector looked at the whole `.cr-agent` set and the node that happened to
 * appear first was WorkBuddy's own processing card:
 *
 *   observedMessageId = "20|WorkBuddy ... 已处理 ... 思考中"
 *
 * A turn count that grew is not a send. These cases replay the real order of
 * nodes after the click and hold the detector to the rule that only a
 * user-authored outbound turn can prove a send.
 */

import { describe, expect, it } from "vitest";
import {
  confirmSend,
  waitForSendConfirmation,
  type SendConfirmation,
  type TurnRole,
  type TurnSnapshot,
} from "../src/workbuddy/turn-ack.js";
import { classifyTurnNode } from "../src/workbuddy/turn-roles.js";

const SMOKE_TASK = "relay-production-smoke-v0473c-001";

/**
 * The node the production page produced, kept as the literal it was:
 * an assistant-side status card, 20 characters long.
 */
const PROCESSING_CARD = "20|WorkBuddy ... 已处理 ... 思考中";

/** One page read, with the roles the page adapter would have classified. */
function page(turns: Array<[signature: string, role: TurnRole, containsTaskId?: boolean]>): TurnSnapshot {
  return {
    inputText: "",
    turns: turns.map(([signature, role, containsTaskId = false]) => ({
      signature,
      role,
      containsTaskId,
    })),
  };
}

/** The state of the page before the click: one old outbound turn and its answer. */
const BEFORE = page([
  ["old-user", "user", true],
  ["old-assistant", "assistant"],
]);

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

/**
 * Drives a real polling loop through the order of page reads the browser
 * would produce, so the test sees what the loop sees.
 */
function drive(
  timeline: TurnSnapshot[],
  options: { before: TurnSnapshot; expectedTaskId: string; pollIntervalMs: number; timeoutMs: number },
): Promise<SendConfirmation> {
  let polls = 0;
  const clock = clockOf(options.pollIntervalMs);

  return waitForSendConfirmation(
    async () => {
      const read = timeline[Math.min(polls, timeline.length - 1)] ?? options.before;
      polls += 1;
      return read;
    },
    {
      before: options.before,
      expectedTaskId: options.expectedTaskId,
      pollIntervalMs: options.pollIntervalMs,
      timeoutMs: options.timeoutMs,
      now: clock.now,
      sleep: clock.sleep,
    },
  );
}

describe("the send detector, against the production order of nodes", () => {
  it("ignores the processing card, keeps polling, and confirms the real user turn", async () => {
    /*
     * The order the page really produced: WorkBuddy's status card first, the
     * outbound turn a beat later.
     */
    const timeline: TurnSnapshot[] = [
      page([["old-user", "user", true], ["old-assistant", "assistant"], [PROCESSING_CARD, "assistant"]]),
      page([
        ["old-user", "user", true],
        ["old-assistant", "assistant"],
        [PROCESSING_CARD, "assistant"],
        [`user-${SMOKE_TASK}`, "user", true],
      ]),
    ];

    const confirmation = await drive(timeline, {
      before: BEFORE,
      expectedTaskId: SMOKE_TASK,
      pollIntervalMs: 250,
      timeoutMs: 5000,
    });

    expect(confirmation.reason).toBe("confirmed");
    expect(confirmation.ok).toBe(true);
    // The proof is the outbound turn, never the status card.
    expect(confirmation.observedMessageId).toBe(`user-${SMOKE_TASK}`);
    // And the ignored card is reported, so the log can say why nothing fired.
    expect(confirmation.ignoredRoles).toContain("assistant");
  });

  /*
   * The failure this regression exists for, written down as a test: the very
   * verdict that stopped a completed task from being accepted as sent.
   */
  it("never calls a status card a send of another task", () => {
    const confirmation = confirmSend({
      before: BEFORE,
      after: page([["old-user", "user", true], [PROCESSING_CARD, "assistant"]]),
      expectedTaskId: SMOKE_TASK,
    });

    expect(confirmation.ok).toBe(false);
    expect(confirmation.reason).toBe("no_new_turn");
    expect(confirmation.observedMessageId).toBeNull();
  });

  it("waits out a processing card that is followed by no outbound turn at all", async () => {
    const clock = clockOf(250);

    const confirmation = await waitForSendConfirmation(
      async () => page([["old-user", "user", true], [PROCESSING_CARD, "assistant"]]),
      {
        before: BEFORE,
        expectedTaskId: SMOKE_TASK,
        pollIntervalMs: 250,
        timeoutMs: 500,
        now: clock.now,
        sleep: clock.sleep,
      },
    );

    // "nothing sent" is not the same as "something else was sent": the second
    // would send again, and that is the one thing this relay must not do.
    expect(confirmation.reason).toBe("no_new_turn");
    expect(confirmation.ok).toBe(false);
  });

  it("still refuses an outbound turn that belongs to another task", () => {
    const confirmation = confirmSend({
      before: BEFORE,
      after: page([
        ["old-user", "user", true],
        ["user-other-task", "user"],
      ]),
      expectedTaskId: SMOKE_TASK,
    });

    expect(confirmation.ok).toBe(false);
    expect(confirmation.reason).toBe("new_turn_wrong_task");
    expect(confirmation.observedMessageId).toBe("user-other-task");
  });

  it("does not let an answer land before the outbound turn and pass itself off as a send", async () => {
    /*
     * The answer stream starts first and it even carries the task id, because
     * WorkBuddy quotes the id of what it is working on. It is not the relay's
     * message going out, and the detector has to say so.
     */
    const first = page([
      ["old-user", "user", true],
      ["answer-start", "assistant"],
      ["answer-quoting-task", "assistant", true],
    ]);

    const confirmation = await drive(
      [
        first,
        page([
          ["old-user", "user", true],
          ["answer-start", "assistant"],
          ["answer-quoting-task", "assistant", true],
          [`user-${SMOKE_TASK}`, "user", true],
        ]),
      ],
      {
        before: BEFORE,
        expectedTaskId: SMOKE_TASK,
        pollIntervalMs: 250,
        timeoutMs: 5000,
      },
    );

    expect(confirmation.reason).toBe("confirmed");
    expect(confirmation.observedMessageId).toBe(`user-${SMOKE_TASK}`);
  });

  it("ignores a node the page could not identify either way", () => {
    const confirmation = confirmSend({
      before: BEFORE,
      after: page([["mystery", "unknown"], [`user-${SMOKE_TASK}`, "user", true]]),
      expectedTaskId: SMOKE_TASK,
    });

    expect(confirmation.reason).toBe("confirmed");
    expect(confirmation.ignoredRoles).toEqual(["unknown"]);
  });
});

describe("who authored a node", () => {
  it("calls a node with user content, or with the outbound payload, outbound", () => {
    expect(classifyTurnNode({ hasUserContent: true, hasAssistantChrome: false, hasStatusLabel: false, carriesPayload: false })).toBe("user");
    expect(classifyTurnNode({ hasUserContent: false, hasAssistantChrome: false, hasStatusLabel: false, carriesPayload: true })).toBe("user");
  });

  /*
   * The production node, expressed as the four facts the page collects for it:
   * no user content, the processing chrome, the "已处理 / 思考中" label.
   */
  it("calls WorkBuddy's own status card assistant-side, never outbound", () => {
    expect(
      classifyTurnNode({
        hasUserContent: false,
        hasAssistantChrome: true,
        hasStatusLabel: true,
        carriesPayload: false,
      }),
    ).toBe("assistant");
  });

  it("leaves an unidentifiable node unknown, so it cannot vote", () => {
    expect(
      classifyTurnNode({
        hasUserContent: false,
        hasAssistantChrome: false,
        hasStatusLabel: false,
        carriesPayload: false,
      }),
    ).toBe("unknown");
  });

  it("never demotes a real outbound turn to assistant because its status label moved", () => {
    expect(
      classifyTurnNode({
        hasUserContent: true,
        hasAssistantChrome: false,
        hasStatusLabel: true,
        carriesPayload: false,
      }),
    ).toBe("user");
  });
});
