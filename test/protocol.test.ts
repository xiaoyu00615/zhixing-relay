import { describe, expect, it } from "vitest";
import {
  ensureTaskId,
  extractTaskBlock,
  parseRelayEnvelope,
  readRelayIntent,
  scanRelayBlocks,
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

  it("finds the block when the reply explains first and signs off after", () => {
    const text = [
      "先说明一下我的判断：这次不需要改路由。",
      "",
      "[ZHIXING_RELAY]",
      "TYPE: TASK",
      "TASK_ID: P7-S4R5",
      "SOURCE: GPT",
      "MODEL: hy3",
      "",
      "Run the gate.",
      "[ZHIXING_RELAY_END]",
      "",
      "以上如果有问题再喊我。",
    ].join("\n");

    const found = extractTaskBlock(text);

    expect(found?.block).toBe(
      [
        "[ZHIXING_RELAY]",
        "TYPE: TASK",
        "TASK_ID: P7-S4R5",
        "SOURCE: GPT",
        "MODEL: hy3",
        "",
        "Run the gate.",
        "[ZHIXING_RELAY_END]",
      ].join("\n"),
    );
    expect(found?.before).toBe("先说明一下我的判断：这次不需要改路由。");
    expect(found?.after).toBe("以上如果有问题再喊我。");
  });

  it("parses a TASK that is not the first thing the GPT side said", () => {
    const text = [
      "Some analysis.",
      "[ZHIXING_RELAY]",
      "TYPE: TASK",
      "TASK_ID: P7-S4R5",
      "SOURCE: GPT",
      "",
      "Do it.",
      "[ZHIXING_RELAY_END]",
    ].join("\n");

    const envelope = parseRelayEnvelope(text);

    expect(envelope).toMatchObject({
      taskId: "P7-S4R5",
      type: "TASK",
      source: "GPT",
      model: null,
    });
    expect(shouldForwardAssistantMessage(text, "tagged")).toBe(true);
  });

  it("reads a header from the block, not from prose that mentions one", () => {
    const text = [
      "TASK_ID: wrong-task",
      "",
      "Here is the real one:",
      "[ZHIXING_RELAY]",
      "TYPE: TASK",
      "TASK_ID: P7-S4R6",
      "",
      "Do it.",
      "[ZHIXING_RELAY_END]",
    ].join("\n");

    expect(parseRelayEnvelope(text)?.taskId).toBe("P7-S4R6");
  });

  it("has no block in prose, so nothing is forwarded", () => {
    expect(extractTaskBlock("Just an explanation, not a task.")).toBeNull();
    expect(parseRelayEnvelope("Just an explanation, not a task.")).toBeNull();
    expect(shouldForwardAssistantMessage("Just an explanation.", "tagged")).toBe(
      false,
    );
  });

  it("still parses an envelope with no end marker, such as a RESULT", () => {
    const envelope = parseRelayEnvelope(
      wrapWorkBuddyResult({ taskId: "P7-S4R4", workbuddyMessageId: "m1", body: "OK" }),
    );

    expect(envelope).toMatchObject({ type: "RESULT", taskId: "P7-S4R4" });
  });

  it("runs to the end of the text when no end marker is present", () => {
    const found = extractTaskBlock("[ZHIXING_RELAY]\nTYPE: TASK\nTASK_ID: t1");

    expect(found?.block).toBe("[ZHIXING_RELAY]\nTYPE: TASK\nTASK_ID: t1");
    expect(found?.after).toBe("");
  });

  // v0.4.5: a GPT reply is addressed to a human as well as to Relay, so the
  // only thing that may become work is the block between the two markers.

  it("keeps the envelope from the OPEN marker to the END marker only", () => {
    const text = [
      "这里是 GPT 给用户看的分析。",
      "这里不允许传递给 WorkBuddy。",
      "",
      "[ZHIXING_RELAY]",
      "TYPE: TASK",
      "TASK_ID: task-001",
      "MODEL: hy3",
      "SOURCE: GPT",
      "",
      "真正任务正文",
      "[ZHIXING_RELAY_END]",
      "",
      "这里也是普通解释。",
    ].join("\n");

    const intent = readRelayIntent(text);

    expect(intent.kind).toBe("task");
    if (intent.kind !== "task") return;

    expect(intent.task.taskId).toBe("task-001");
    expect(intent.task.model).toBe("hy3");
    expect(intent.task.block).toBe(
      [
        "[ZHIXING_RELAY]",
        "TYPE: TASK",
        "TASK_ID: task-001",
        "MODEL: hy3",
        "SOURCE: GPT",
        "",
        "真正任务正文",
        "[ZHIXING_RELAY_END]",
      ].join("\n"),
    );
    expect(intent.task.body).toBe("真正任务正文");

    // Everything outside the block stays there, as prose about the block.
    const found = extractTaskBlock(text);
    expect(found?.before).toContain("这里不允许传递给 WorkBuddy");
    expect(found?.after).toBe("这里也是普通解释。");
  });

  it("ignores a reply that has no relay block at all", () => {
    expect(readRelayIntent("普通回复，没有任何标记。").kind).toBe("ignored");
    expect(readRelayIntent("[ZHIXING_RELAY_EMPTY]").kind).toBe("ignored");
    expect(scanRelayBlocks("no markers here")).toEqual({
      complete: [],
      unterminated: [],
    });
  });

  it("does not dispatch an envelope whose TYPE is blank", () => {
    const text = [
      "[ZHIXING_RELAY]",
      "TYPE:",
      "SOURCE: GPT",
      "",
      "hello",
      "[ZHIXING_RELAY_END]",
    ].join("\n");

    expect(readRelayIntent(text)).toEqual({ kind: "ignored", reason: "empty_type" });
    expect(shouldForwardAssistantMessage(text, "tagged")).toBe(false);
  });

  it("does not dispatch an envelope that has no TYPE header", () => {
    const text = [
      "[ZHIXING_RELAY]",
      "TASK_ID: task-002",
      "SOURCE: GPT",
      "",
      "hello",
      "[ZHIXING_RELAY_END]",
    ].join("\n");

    expect(readRelayIntent(text)).toEqual({ kind: "ignored", reason: "missing_type" });
    expect(shouldForwardAssistantMessage(text, "tagged")).toBe(false);
  });

  it("does not dispatch an unknown TYPE, and never RESULT", () => {
    for (const type of ["REVIEW", "result", "result-summary"]) {
      const text = [
        "[ZHIXING_RELAY]",
        `TYPE: ${type}`,
        "TASK_ID: task-003",
        "",
        "hello",
        "[ZHIXING_RELAY_END]",
      ].join("\n");

      expect(shouldForwardAssistantMessage(text, "tagged")).toBe(false);
    }

    /*
     * `result` is lower case here on purpose: the header match stays
     * case-insensitive, but a lower case RESULT is still not a dispatchable
     * task - it is Relay's own completion signal coming back.
     */
    const lowered = readRelayIntent(
      ["[ZHIXING_RELAY]", "TYPE: result", "TASK_ID: task-003", "", "done"].join("\n"),
    );
    expect(lowered.kind).toBe("result");
  });

  it("refuses a TASK envelope that names no task id", () => {
    const missing = [
      "[ZHIXING_RELAY]",
      "TYPE: TASK",
      "SOURCE: GPT",
      "",
      "hello",
      "[ZHIXING_RELAY_END]",
    ].join("\n");

    expect(readRelayIntent(missing)).toEqual({
      kind: "ignored",
      reason: "missing_task_id",
    });
    expect(shouldForwardAssistantMessage(missing, "tagged")).toBe(false);

    const blank = missing.replace("TYPE: TASK", "TYPE: TASK\nTASK_ID:   ");
    expect(readRelayIntent(blank)).toEqual({
      kind: "ignored",
      reason: "empty_task_id",
    });
    expect(shouldForwardAssistantMessage(blank, "tagged")).toBe(false);

    // No id is generated to paper over the malformed envelope.
    expect(ensureTaskId(missing, "generated")).toBe("generated");
  });

  it("ignores headers that only look like the real ones", () => {
    const text = [
      "[ZHIXING_RELAY]",
      "TYPE TASK",
      "TASK_ID task-004",
      ":",
      "[ZHIXING_RELAY_END]",
    ].join("\n");

    expect(readRelayIntent(text)).toEqual({ kind: "ignored", reason: "missing_type" });
  });

  it("reads a body line that repeats a header without touching it", () => {
    const text = [
      "[ZHIXING_RELAY]",
      "TYPE: TASK",
      "TASK_ID: task-005",
      "SOURCE: GPT",
      "",
      "Pseudo task:",
      "TYPE: RESULT",
      "TASK_ID: task-lie",
      "[ZHIXING_RELAY_END]",
    ].join("\n");

    const intent = readRelayIntent(text);

    expect(intent.kind).toBe("task");
    if (intent.kind !== "task") return;
    expect(intent.task.taskId).toBe("task-005");
    expect(intent.task.type).toBe("TASK");
    expect(intent.task.body).toContain("TYPE: RESULT");
    expect(intent.task.body).toContain("TASK_ID: task-lie");
  });

  it("keeps a multi-line body intact, fences and all", () => {
    const text = [
      "[ZHIXING_RELAY]",
      "TYPE: TASK",
      "TASK_ID: task-006",
      "SOURCE: GPT",
      "",
      "跑一次门禁：",
      "```bash",
      "pnpm check",
      "pnpm typecheck",
      "```",
      "",
      '{"key": "TYPE: TASK"}',
      "",
      "[ZHIXING_RELAY_END]",
    ].join("\n");

    const intent = readRelayIntent(text);

    expect(intent.kind).toBe("task");
    if (intent.kind !== "task") return;
    expect(intent.task.body).toBe(
      [
        "跑一次门禁：",
        "```bash",
        "pnpm check",
        "pnpm typecheck",
        "```",
        "",
        '{"key": "TYPE: TASK"}',
      ].join("\n"),
    );
  });

  it("does not cut the block open on a marker that only appears in the body", () => {
    const text = [
      "[ZHIXING_RELAY]",
      "TYPE: TASK",
      "TASK_ID: task-007",
      "",
      "The protocol is:",
      "[ZHIXING_RELAY]",
      "TYPE: TASK",
      "TASK_ID: task-008",
      "[ZHIXING_RELAY_END]",
    ].join("\n");

    const scan = scanRelayBlocks(text);

    expect(scan.complete).toHaveLength(1);
    expect(scan.unterminated).toHaveLength(0);
    const intent = readRelayIntent(text);
    expect(intent.kind).toBe("task");
    if (intent.kind !== "task") return;
    expect(intent.task.taskId).toBe("task-007");
  });

  it("refuses a message that carries two complete blocks", () => {
    const text = [
      "看这个例子：",
      "",
      "[ZHIXING_RELAY]",
      "TYPE: TASK",
      "TASK_ID: task-009",
      "",
      "first",
      "[ZHIXING_RELAY_END]",
      "",
      "真正的任务在下面：",
      "",
      "[ZHIXING_RELAY]",
      "TYPE: TASK",
      "TASK_ID: task-010",
      "",
      "second",
      "[ZHIXING_RELAY_END]",
    ].join("\n");

    expect(readRelayIntent(text)).toEqual({ kind: "ambiguous", count: 2 });
    expect(shouldForwardAssistantMessage(text, "tagged")).toBe(false);
  });

  it("refuses when the END marker is followed by another pseudo task", () => {
    const text = [
      "[ZHIXING_RELAY]",
      "TYPE: TASK",
      "TASK_ID: task-011",
      "",
      "do it",
      "[ZHIXING_RELAY_END]",
      "",
      "（示例）",
      "[ZHIXING_RELAY]",
      "TYPE: TASK",
      "TASK_ID: task-012",
      "",
      "not this one",
      "[ZHIXING_RELAY_END]",
    ].join("\n");

    const intent = readRelayIntent(text);

    expect(intent.kind).toBe("ambiguous");
    expect(shouldForwardAssistantMessage(text, "tagged")).toBe(false);
  });

  it("accepts a legacy task that was never closed, and says so", () => {
    const text = [
      "分析。",
      "",
      "[ZHIXING_RELAY]",
      "TYPE: TASK",
      "TASK_ID: task-013",
      "",
      "do it",
    ].join("\n");

    const intent = readRelayIntent(text);

    expect(intent.kind).toBe("task");
    if (intent.kind !== "task") return;
    expect(intent.task.legacy).toBe(true);
    expect(intent.task.taskId).toBe("task-013");
    // The prose before the marker never becomes part of the payload.
    expect(intent.task.block).not.toContain("分析。");
    expect(shouldForwardAssistantMessage(text, "tagged")).toBe(true);
  });

  it("keeps a RESULT readable when it carries no END marker", () => {
    const envelope = parseRelayEnvelope(
      wrapWorkBuddyResult({ taskId: "P7-S4R4", workbuddyMessageId: "m1", body: "OK" }),
    );

    expect(envelope?.legacy).toBe(true);
    expect(envelope?.type).toBe("RESULT");
    expect(readRelayIntent(
      wrapWorkBuddyResult({ taskId: "P7-S4R4", workbuddyMessageId: "m1", body: "OK" }),
    ).kind).toBe("result");
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
