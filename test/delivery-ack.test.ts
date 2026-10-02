/**
 * v0.4.7: the delivery acknowledgements, as pure logic.
 *
 * Nothing here has a relay in the room and nothing touches a DOM. Every
 * verdict is made from plain values, so the rules that keep a task from being
 * sent twice are testable without WorkBuddy being reachable.
 */

import { describe, expect, it } from "vitest";
import {
  advanceStage,
  createExecutionState,
  isAlertStage,
  isStaleDispatch,
  stageRank,
  withStageDetail,
  type TaskExecutionState,
} from "../src/delivery/stage.js";
import {
  classifyTurnFailure,
  confirmInputReadback,
  confirmSend,
  waitForRunning,
  waitForSendConfirmation,
  type RunningConfirmation,
  type RunningSignals,
  type TurnSnapshot,
} from "../src/workbuddy/turn-ack.js";

const AT = "2026-10-02T00:00:00.000Z";

/**
 * A clock that moves only when the waiter sleeps.
 *
 * A bounded wait must be able to close its window: if the clock never moves the
 * `while` never ends and the test spins forever. Tying the clock to the sleep
 * keeps the timing exact without ever touching a real timer.
 */
function stepClock(options: { pollIntervalMs: number; timeoutMs: number }): {
  now: () => number;
  sleep: () => Promise<void>;
  slept: () => number;
} {
  let elapsed = 0;
  let slept = 0;

  return {
    now: () => elapsed,
    sleep: async () => {
      slept += 1;
      elapsed += options.pollIntervalMs;
    },
    slept: () => slept,
  };
}

function snapshot(turns: Array<[string, boolean]>): TurnSnapshot {
  return {
    inputText: "",
    turns: turns.map(([signature, containsTaskId]) => ({ signature, containsTaskId })),
  };
}

describe("stage machine", () => {
  it("walks one dispatch through the healthy pipeline, in order", () => {
    let state: TaskExecutionState | null = null;

    for (const stage of [
      "QUEUED",
      "DISPATCHING",
      "INPUT_CONFIRMED",
      "SEND_CONFIRMED",
      "RUNNING_CONFIRMED",
      "RESULT_RECEIVED",
      "RESULT_PERSISTED",
      "RESULT_DELIVERED",
      "RESULT_ACKED",
      "COMPLETED",
    ] as const) {
      const next = advanceStage(state, stage, AT);
      expect(next).not.toBeNull();
      state = next;
    }

    expect(state?.stage).toBe("COMPLETED");
    // Every hop is a fact, not a log line.
    expect(state?.history).toHaveLength(10);
    expect(state?.stageStartedAt).toBe(AT);
  });

  it("refuses to rewind, because a late ack is not evidence of a earlier stage", () => {
    const started = createExecutionState({ stage: "RESULT_DELIVERED", at: AT });

    expect(advanceStage(started, "SEND_CONFIRMED", AT)).toBeNull();
    expect(advanceStage(started, "RUNNING_CONFIRMED", AT)).toBeNull();
  });

  it("accepts an alert stage from anywhere, so a cancellation can freeze a live round", () => {
    const running = createExecutionState({ stage: "RUNNING_CONFIRMED", at: AT });

    const frozen = advanceStage(running, "RECONCILIATION_REQUIRED", AT);

    expect(frozen?.stage).toBe("RECONCILIATION_REQUIRED");
    expect(frozen?.lastProgressAt).toBe(AT);
    expect(isAlertStage("RECONCILIATION_REQUIRED")).toBe(true);
    expect(isAlertStage("RUNNING_CONFIRMED")).toBe(false);
  });

  it("keeps the stage that already reports an alert", () => {
    const frozen = createExecutionState({ stage: "RECONCILIATION_REQUIRED", at: AT });

    expect(advanceStage(frozen, "RECONCILIATION_REQUIRED", AT)).toBe(frozen);
  });

  it("starts a fresh state when the record is gone, so post-restart evidence still lands", () => {
    const advanced = advanceStage(null, "SEND_CONFIRMED", AT);

    expect(advanced?.stage).toBe("SEND_CONFIRMED");
    expect(advanced?.history).toEqual(["SEND_CONFIRMED"]);
  });

  it("sorts the alert stages before the pipeline ones", () => {
    expect(stageRank("RECONCILIATION_REQUIRED")).toBeLessThan(stageRank("QUEUED"));
    expect(stageRank("FAILED")).toBeLessThan(stageRank("BLOCKED"));
    expect(stageRank("COMPLETED")).toBeGreaterThan(stageRank("RESULT_ACKED"));
  });

  it("writes extra evidence onto a stage without moving it", () => {
    const delivered = advanceStage(
      advanceStage(null, "RESULT_DELIVERED", AT),
      "RESULT_DELIVERED",
      AT,
    );

    const noted = withStageDetail(delivered, { requestId: "req-1" }, AT);

    expect(noted?.stage).toBe("RESULT_DELIVERED");
    expect(noted?.detail).toMatchObject({ requestId: "req-1" });
  });

  it("treats an ack from another dispatch as stale, not as progress", () => {
    const live = { taskId: "t-1", dispatchId: "t-1#0" };

    expect(isStaleDispatch(live, { taskId: "t-2", dispatchId: "t-2#0" })).toBe(true);
    expect(isStaleDispatch(live, { taskId: "t-1", dispatchId: "t-1#1" })).toBe(true);
    expect(isStaleDispatch(live, { taskId: "t-1", dispatchId: "t-1#0" })).toBe(false);
    // A fact with no identity to argue about is not stale: it cannot belong to
    // another round, so dropping it would only lose evidence.
    expect(isStaleDispatch(live, {})).toBe(false);
    expect(isStaleDispatch(null, { taskId: "t-9", dispatchId: "t-9#0" })).toBe(false);
  });
});

describe("input confirmation", () => {
  it("accepts a composer that read back the payload", () => {
    const confirmation = confirmInputReadback({ expected: "TASK_ID: t-1", observed: "TASK_ID: t-1" });

    expect(confirmation.ok).toBe(true);
    expect(confirmation.reason).toBe("confirmed");
    expect(confirmation.exactMatch).toBe(true);
  });

  it("accepts the composer reflow the renderer actually produces", () => {
    const confirmation = confirmInputReadback({
      expected: "line one\n\n\nline two",
      observed: "line one\n\n line two   ",
    });

    expect(confirmation.ok).toBe(true);
    expect(confirmation.normalizedMatch).toBe(true);
  });

  it("refuses a tampered composer, so a partial payload never reaches a send", () => {
    const confirmation = confirmInputReadback({
      expected: "TASK_ID: t-1",
      observed: "TASK_ID: t-1 (tampered)",
    });

    expect(confirmation.ok).toBe(false);
    expect(confirmation.reason).toBe("readback_mismatch");
  });

  it("refuses an empty composer and a missing one", () => {
    expect(confirmInputReadback({ expected: "x", observed: "   " }).reason).toBe(
      "empty_composer",
    );
    expect(
      confirmInputReadback({ expected: "x", observed: "x", composerFound: false }).reason,
    ).toBe("no_composer");
  });
});

describe("send confirmation", () => {
  const before = snapshot([["turn-a", false]]);

  it("confirms only when the click grew a new turn carrying this task", () => {
    const confirmation = confirmSend({
      before,
      after: snapshot([
        ["turn-a", false],
        ["turn-t-1", true],
      ]),
      expectedTaskId: "t-1",
    });

    expect(confirmation.ok).toBe(true);
    expect(confirmation.observedMessageId).toBe("turn-t-1");
  });

  /*
   * The click is the start of the unknown, never the end of it: without a new
   * turn the relay cannot tell a swallowed click from a half-finished send.
   */
  it("does not mistake a successful click for a confirmed send", () => {
    const confirmation = confirmSend({
      before,
      after: snapshot([["turn-a", false]]),
      expectedTaskId: "t-1",
    });

    expect(confirmation.ok).toBe(false);
    expect(confirmation.reason).toBe("no_new_turn");
  });

  it("refuses a new turn that belongs to another task", () => {
    const confirmation = confirmSend({
      before,
      after: snapshot([["turn-other", false]]),
      expectedTaskId: "t-1",
    });

    expect(confirmation.ok).toBe(false);
    expect(confirmation.reason).toBe("new_turn_wrong_task");
  });

  it("reports the turn counts as evidence", () => {
    const confirmation = confirmSend({
      before,
      after: snapshot([["turn-a", false], ["turn-t-1", true]]),
      expectedTaskId: "t-1",
    });

    expect(confirmation.beforeTurnCount).toBe(1);
    expect(confirmation.afterTurnCount).toBe(2);
  });

  it("keeps polling until the new turn shows up, then stops", async () => {
    const after = snapshot([
      ["turn-a", false],
      ["turn-t-9", true],
    ]);
    const clock = stepClock({ pollIntervalMs: 5, timeoutMs: 50 });
    let seen = false;
    let polls = 0;

    const confirmation = await waitForSendConfirmation(
      async () => {
        polls += 1;
        return seen ? after : snapshot([["turn-a", false]]);
      },
      {
        before,
        expectedTaskId: "t-9",
        pollIntervalMs: 5,
        timeoutMs: 50,
        now: clock.now,
        sleep: async () => {
          seen = true;
          await clock.sleep();
        },
      },
    );

    expect(confirmation.ok).toBe(true);
    expect(confirmation.observedMessageId).toBe("turn-t-9");
    // One look, one sleep, one more look: it stopped the moment it could.
    expect(polls).toBe(2);
    expect(clock.slept()).toBe(1);
  });

  /*
   * The send is in an unknown state, not a failed one: the click happened and
   * no new turn arrived. The answer has to be the same as an outright refusal,
   * so the relay has no reason to quietly assume the click worked.
   */
  it("gives up inside its window and still says no, never maybe", async () => {
    const clock = stepClock({ pollIntervalMs: 5, timeoutMs: 10 });
    let polls = 0;

    const confirmation = await waitForSendConfirmation(
      async () => {
        polls += 1;
        return snapshot([["turn-a", false]]);
      },
      {
        before,
        expectedTaskId: "t-1",
        pollIntervalMs: 5,
        timeoutMs: 10,
        now: clock.now,
        sleep: clock.sleep,
      },
    );

    expect(confirmation.ok).toBe(false);
    expect(confirmation.reason).toBe("no_new_turn");
    // It spent its whole window looking and then admitted it saw nothing.
    expect(polls).toBe(2);
    expect(clock.slept()).toBe(2);
  });
});

describe("running confirmation", () => {
  function watch(
    signals: RunningSignals,
    options: { pollIntervalMs: number; timeoutMs: number },
  ): Promise<{ confirmation: RunningConfirmation; slept: () => number }> {
    const clock = stepClock(options);

    return waitForRunning(
      async () => signals,
      {
        pollIntervalMs: options.pollIntervalMs,
        timeoutMs: options.timeoutMs,
        now: clock.now,
        sleep: clock.sleep,
      },
    ).then((confirmation) => ({ confirmation, slept: clock.slept }));
  }

  it("prefers real processing over everything else", async () => {
    const { confirmation, slept } = await watch(
      { running: true, completed: false, cancelled: true },
      { pollIntervalMs: 5, timeoutMs: 10 },
    );

    expect(confirmation.outcome).toBe("running");
    expect(confirmation.ok).toBe(true);
    // Seen on the first look: no window was spent.
    expect(slept()).toBe(0);
  });

  it("treats a cancel button as cancelled, not as never-started", async () => {
    const { confirmation } = await watch(
      { running: false, completed: false, cancelled: true },
      { pollIntervalMs: 5, timeoutMs: 10 },
    );

    expect(confirmation.outcome).toBe("cancelled");
    expect(confirmation.ok).toBe(false);
    expect(confirmation.evidence.cancelled).toBe(true);
  });

  it("allows a result that landed before any processing was seen", async () => {
    const { confirmation } = await watch(
      { running: false, completed: true, cancelled: false },
      { pollIntervalMs: 5, timeoutMs: 10 },
    );

    expect(confirmation.outcome).toBe("result_ready");
    expect(confirmation.evidence.completed).toBe(true);
  });

  /*
   * The case reconciliation exists for: WorkBuddy neither worked nor answered,
   * so the turn is stalled and must not be retried on these two facts alone.
   */
  it("calls a silent turn stalled rather than finished", async () => {
    const { confirmation, slept } = await watch(
      { running: false, completed: false, cancelled: false },
      { pollIntervalMs: 5, timeoutMs: 10 },
    );

    expect(confirmation.outcome).toBe("timeout");
    expect(confirmation.ok).toBe(false);
    // It used the whole window, then said so.
    expect(slept()).toBe(2);
  });
});

describe("turn failure classification", () => {
  it("separates a cancellation from a stall and from an error", () => {
    expect(classifyTurnFailure(new Error("WorkBuddy task cancelled"))).toBe("cancelled");
    expect(classifyTurnFailure(new Error("Timed out after 30s"))).toBe("timeout");
    expect(classifyTurnFailure(new Error("the websocket died"))).toBe("error");
  });
});
