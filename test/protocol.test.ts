import { describe, expect, it } from "vitest";
import {
  ensureTaskId,
  parseRelayEnvelope,
  shouldForwardAssistantMessage,
  wrapWorkBuddyResult,
} from "../src/protocol.js";

describe("relay protocol", () => {
  it("accepts a tagged TASK", () => {
    const text = [
      "[ZHIXING_RELAY]",
      "TYPE: TASK",
      "TASK_ID: P7-S4R4",
      "SOURCE: GPT",
      "",
      "Run the gate.",
    ].join("\n");

    expect(parseRelayEnvelope(text)).toMatchObject({
      taskId: "P7-S4R4",
      type: "TASK",
      source: "GPT",
    });

    expect(shouldForwardAssistantMessage(text, "tagged")).toBe(true);
  });

  it("does not forward normal GPT prose in tagged mode", () => {
    expect(
      shouldForwardAssistantMessage(
        "This is just an explanation, not a task.",
        "tagged",
      ),
    ).toBe(false);
  });

  it("falls back to a generated task id", () => {
    expect(ensureTaskId("[ZHIXING_RELAY]\nTYPE: TASK", "fallback")).toBe(
      "fallback",
    );
  });

  it("wraps WorkBuddy results for ChatGPT", () => {
    const output = wrapWorkBuddyResult({
      taskId: "P7-S4R4",
      workbuddyMessageId: "msg-42",
      body: "PASS",
    });

    expect(output).toContain("TYPE: RESULT");
    expect(output).toContain("TASK_ID: P7-S4R4");
    expect(output).toContain("WORKBUDDY_MESSAGE_ID: msg-42");
    expect(output).toContain("PASS");
  });
});
