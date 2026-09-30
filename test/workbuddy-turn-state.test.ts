import { describe, expect, it } from "vitest";
import {
  decideTurnState,
  turnBody,
  waitForTurn,
  type WaitForTurnOptions,
  type WorkBuddyState,
  type WorkBuddyTurnSignals,
} from "../src/workbuddy/turn-state.js";

/*
 * Regression tests for the V0.4 E2E regression:
 *
 * Reality: WorkBuddy completed the task, but Relay threw
 * "WorkBuddy task cancelled" and never relayed RESULT back to GPT.
 *
 * Root cause: readState() scored the turn with a full-text keyword search:
 *
 *   completed = agent.innerText.includes("已完成")
 *   cancelled = agent.innerText.includes("已取消")
 *
 * A completed reply quoted its own detection source code, so its markdown
 * body literally contained both "已完成" and "已取消" inside
 * <code class="cr-inline-code">. Both flags became true at once.
 *
 * The fixtures below are verbatim structural signals captured from real DOM
 * through CDP on the affected page (3 agents in one conversation).
 */

/** Completed turn that self-poisoned the old keyword scan. */
const REAL_COMPLETED_AGENT: WorkBuddyTurnSignals = {
  found: true,
  cls: "cr-agent",
  processingClass: false,
  processingAttr: null,
  hasProcessingStatus: false,
  processingStatusText: "",
  hasCompletionStatus: false,
  completionStatusText: "",
  hasCancelledIndicator: false,
  hasFinishedFooter: true,
  hasCompletedCollapse: true,
  markdownCount: 1,
};

/** Genuinely cancelled turn. Also carries the finished footer. */
const REAL_CANCELLED_AGENT: WorkBuddyTurnSignals = {
  found: true,
  cls: "cr-agent cr-agent--with-status",
  processingClass: false,
  processingAttr: null,
  hasProcessingStatus: false,
  processingStatusText: "",
  hasCompletionStatus: true,
  completionStatusText: "已取消 1s",
  hasCancelledIndicator: true,
  hasFinishedFooter: true,
  hasCompletedCollapse: false,
  markdownCount: 0,
};

/** Still-running turn. Its full text ALSO matched both old keywords. */
const REAL_RUNNING_AGENT: WorkBuddyTurnSignals = {
  found: true,
  cls: "cr-agent cr-agent--with-status cr-agent--processing",
  processingClass: true,
  processingAttr: "true",
  hasProcessingStatus: true,
  processingStatusText: "已处理 7m12s",
  hasCompletionStatus: false,
  completionStatusText: "",
  hasCancelledIndicator: false,
  hasFinishedFooter: false,
  hasCompletedCollapse: false,
  markdownCount: 6,
};

const NO_AGENT: WorkBuddyTurnSignals = {
  found: false,
  cls: "",
  processingClass: false,
  processingAttr: null,
  hasProcessingStatus: false,
  processingStatusText: "",
  hasCompletionStatus: false,
  completionStatusText: "",
  hasCancelledIndicator: false,
  hasFinishedFooter: false,
  hasCompletedCollapse: false,
  markdownCount: 0,
};

type StatePatch = Partial<WorkBuddyState>;

function state(patch: StatePatch = {}): WorkBuddyState {
  return {
    text: "",
    markdownText: "",
    running: false,
    completed: false,
    cancelled: false,
    debug: "test",
    ...patch,
  };
}

function scripted(states: StatePatch[]): () => Promise<WorkBuddyState> {
  if (states.length === 0) throw new Error("script must not be empty");
  let i = 0;
  return async () => {
    const patch = states[i] ?? states[states.length - 1];
    i += 1;
    return state(patch ?? {});
  };
}

function fastOptions(overrides: Partial<WaitForTurnOptions> = {}): WaitForTurnOptions {
  let ticks = 0;
  return {
    pollIntervalMs: 0,
    maxWaitMs: 60000,
    sleep: async () => {},
    now: () => {
      ticks += 1;
      return ticks * 1000;
    },
    ...overrides,
  };
}

function repeat(patch: StatePatch, times: number): StatePatch[] {
  return Array.from({ length: times }, () => patch);
}

describe("decideTurnState - structural verdicts", () => {
  it("reports the real completed turn as completed, never cancelled", () => {
    expect(decideTurnState(REAL_COMPLETED_AGENT)).toEqual({
      running: false,
      completed: true,
      cancelled: false,
    });
  });

  it("still detects a genuinely cancelled turn", () => {
    expect(decideTurnState(REAL_CANCELLED_AGENT)).toEqual({
      running: false,
      completed: false,
      cancelled: true,
    });
  });

  it("keeps a running turn running even when its body already has text", () => {
    expect(decideTurnState(REAL_RUNNING_AGENT)).toEqual({
      running: true,
      completed: false,
      cancelled: false,
    });
  });

  it("treats a missing agent as waiting, never as finished", () => {
    expect(decideTurnState(NO_AGENT).completed).toBe(false);
    expect(decideTurnState(NO_AGENT).cancelled).toBe(false);
    expect(decideTurnState(NO_AGENT).running).toBe(true);
  });

  it("THREE AGENTS: the agent whose body contained both keywords is completed only", () => {
    // The old scanner returned {completed:true, cancelled:true} for these three
    // because every one of them had "已完成" or "已取消" somewhere in its text.
    // Signals carry no body text, so body content cannot participate.
    const poisonedBody = 'text.includes("已完成"/"已取消")';
    expect(poisonedBody).toContain("已完成");
    expect(poisonedBody).toContain("已取消");

    expect(decideTurnState(REAL_COMPLETED_AGENT).cancelled).toBe(false);
    expect(decideTurnState(REAL_CANCELLED_AGENT).completed).toBe(false);
    expect(decideTurnState(REAL_RUNNING_AGENT).completed).toBe(false);
    expect(decideTurnState(REAL_RUNNING_AGENT).cancelled).toBe(false);
  });

  it("never yields completed AND cancelled for any signal combination", () => {
    const completionLabels = ["", "已取消 1s", "已完成 7m22s", "已停止"];

    for (const processingClass of [false, true]) {
      for (const hasProcessingStatus of [false, true]) {
        for (const hasCancelledIndicator of [false, true]) {
          for (const hasCompletedCollapse of [false, true]) {
            for (const hasFinishedFooter of [false, true]) {
              for (const completionStatusText of completionLabels) {
                const verdict = decideTurnState({
                  ...REAL_COMPLETED_AGENT,
                  processingClass,
                  hasProcessingStatus,
                  hasCancelledIndicator,
                  hasCompletedCollapse,
                  hasFinishedFooter,
                  completionStatusText,
                });

                expect(verdict.completed && verdict.cancelled).toBe(false);
              }
            }
          }
        }
      }
    }
  });
});

describe("turnBody - RESULT payload extraction", () => {
  it("prefers clean markdown over UI-polluted whole text", () => {
    const body = turnBody(
      state({
        text: "WorkBuddy\n已完成 7m22s\nHy4 preview\n00:02\nreal answer",
        markdownText: "real answer",
      }),
    );

    expect(body).toBe("real answer");
  });

  it("falls back to whole text when no markdown block exists", () => {
    expect(turnBody(state({ text: "fallback body", markdownText: "" }))).toBe(
      "fallback body",
    );
  });
});

describe("waitForTurn - E2E regression behaviours", () => {
  it("[REGRESSION] completed turn whose answer contains 已取消 still succeeds", async () => {
    // Exactly the failure seen in production: the completed WorkBuddy answer
    // quoted the detection code, so its body contained "已取消".
    const finalState: StatePatch = {
      running: false,
      completed: true,
      cancelled: false,
      text: 'WorkBuddy\n已完成 7m22s\nfix: readState() used text.includes("已取消")',
      markdownText: '# DONE\nWe fixed text.includes("已取消") detection.',
    };

    const result = await waitForTurn(
      scripted([
        { running: true, completed: false, cancelled: false, markdownText: "" },
        ...repeat(finalState, 6),
      ]),
      fastOptions(),
    );

    expect(result.text).toContain("已取消");
    expect(result.lastState.cancelled).toBe(false);
    expect(result.lastState.completed).toBe(true);
  });

  it("[REGRESSION] a genuinely cancelled turn still throws", async () => {
    await expect(
      waitForTurn(
        scripted([
          { running: true, markdownText: "" },
          ...repeat({ running: false, completed: false, cancelled: true, text: "已取消 1s" }, 4),
        ]),
        fastOptions(),
      ),
    ).rejects.toThrow(/cancelled/i);
  });

  it("does not finish early while the turn is still running", async () => {
    await expect(
      waitForTurn(
        scripted(repeat({ running: true, completed: false, cancelled: false, markdownText: "partial" }, 40)),
        fastOptions({ maxWaitMs: 20000 }),
      ),
    ).rejects.toThrow(/Timed out waiting WorkBuddy/);
  });

  it("survives a long silent running turn (no text growth) without misjudging it", async () => {
    // Ten minutes of no new output: still running, still no completion.
    await expect(
      waitForTurn(
        scripted(repeat({ running: true, completed: false, cancelled: false, text: "", markdownText: "" }, 40)),
        fastOptions({ maxWaitMs: 40000 }),
      ),
    ).rejects.toThrow(/Timed out waiting WorkBuddy/);
  });

  it("returns the clean markdown body once completed and stable", async () => {
    const finalState: StatePatch = {
      running: false,
      completed: true,
      cancelled: false,
      text: "WorkBuddy\n已完成 7m22s\nHy4 preview\ncb-credit-usage-text\n00:02",
      markdownText: "## clean answer\nfrom WorkBuddy",
    };

    const result = await waitForTurn(
      scripted([
        { running: true, markdownText: "" },
        // body still growing -> must not be accepted
        { ...finalState, markdownText: "## partially" },
        ...repeat(finalState, 6),
      ]),
      fastOptions(),
    );

    expect(result.text).toBe("## clean answer\nfrom WorkBuddy");
    expect(result.text).not.toContain("WorkBuddy\n");
    expect(result.text).not.toContain("已完成 7m22s");
    expect(result.text).not.toContain("Hy4 preview");
    expect(result.text).not.toContain("cb-credit-usage-text");
  });

  it("respects abort", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      waitForTurn(
        scripted(repeat({ running: true, markdownText: "" }, 10)),
        fastOptions({ signal: controller.signal }),
      ),
    ).rejects.toThrow(/aborted/);
  });
});
