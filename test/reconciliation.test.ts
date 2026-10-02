import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ReconciliationService,
  TaskLedger,
  decideDispatch,
  dispatchIdFor,
  reconcile,
  taskFingerprint,
} from "../src/reconciliation/index.js";
import { readRelayIntent } from "../src/protocol.js";
import type { ReconciliationEvent } from "../src/reconciliation/index.js";

let root = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "zxr-recon-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function ledger(name: string): TaskLedger {
  return new TaskLedger(new URL(`file:///${join(root, name).replace(/\\/g, "/")}`));
}

/** The events a healthy chain leaves behind, in the order they happen. */
function healthyChain(taskId: string, fp: string): ReconciliationEvent[] {
  const at = "2026-10-02T00:00:00.000Z";
  return [
    { seq: 1, at, event: "TASK_PUBLISHED" as const, taskId, taskFingerprint: fp, dispatchId: null, attempt: null, source: "gpt" as const, executor: null, model: null, messageFingerprint: "m1", workbuddyMessageId: null, detail: null },
    { seq: 2, at, event: "TASK_ACCEPTED" as const, taskId, taskFingerprint: fp, dispatchId: null, attempt: null, source: "relay" as const, executor: null, model: "hy3", messageFingerprint: "m1", workbuddyMessageId: null, detail: null },
    { seq: 3, at, event: "DISPATCH_STARTED" as const, taskId, taskFingerprint: fp, dispatchId: dispatchIdFor(taskId, 0), attempt: 0, source: "relay" as const, executor: "workbuddy", model: "hy3", messageFingerprint: null, workbuddyMessageId: null, detail: null },
  ];
}

describe("task identity", () => {
  const open = "[ZHIXING_RELAY]";
  const close = "[ZHIXING_RELAY_END]";

  it("gives the same fingerprint to the same envelope, however the prose around it reads", () => {
    const once = `${open}\nTYPE: TASK\nTASK_ID: t-1\n\nbody\n${close}`;
    const twice = `analysis\n\n${once}\n\nand more prose`;

    const first = readRelayIntent(once);
    const second = readRelayIntent(twice);

    expect(first.kind).toBe("task");
    expect(second.kind).toBe("task");
    if (first.kind !== "task" || second.kind !== "task") return;

    expect(taskFingerprint(first.task.block ?? "")).toBe(taskFingerprint(second.task.block ?? ""));
    expect(taskFingerprint(first.task.block ?? "")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives different fingerprints to a different envelope under the same task id", () => {
    const first = `${open}\nTYPE: TASK\nTASK_ID: t-1\n\nrun the gate\n${close}`;
    const second = `${open}\nTYPE: TASK\nTASK_ID: t-1\n\nrun the gate, twice\n${close}`;

    expect(taskFingerprint(first)).not.toBe(taskFingerprint(second));
  });

  it("names a dispatch after the task and its attempt, never after the task alone", () => {
    expect(dispatchIdFor("t-1", 0)).toBe("t-1#0");
    expect(dispatchIdFor("t-1", 2)).toBe("t-1#2");
    expect(dispatchIdFor("t-1", 0)).not.toBe(dispatchIdFor("t-1", 1));
  });

  it("re-parses a published envelope to the same fingerprint the ledger holds", () => {
    const envelope = `${open}\nTYPE: TASK\nTASK_ID: t-1\nMODEL: hy3\nSOURCE: GPT\n\nwork\n${close}`;
    const intent = readRelayIntent(envelope);

    expect(intent.kind).toBe("task");
    if (intent.kind !== "task") return;
    expect(intent.task.taskId).toBe("t-1");
    expect(taskFingerprint(intent.task.block ?? "")).toBe(taskFingerprint(envelope));
  });
});

describe("ledger", () => {
  it("only ever appends: an earlier event keeps its fields and its sequence", async () => {
    const log = ledger("append-only.jsonl");
    const first = await log.append({
      event: "TASK_PUBLISHED",
      taskId: "t-append",
      taskFingerprint: "fp-1",
      source: "gpt",
    });
    const second = await log.append({
      event: "SEND_CONFIRMED",
      taskId: "t-append",
      taskFingerprint: "fp-1",
      dispatchId: dispatchIdFor("t-append", 0),
      attempt: 0,
      workbuddyMessageId: "wb-1",
      source: "relay",
    });

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);

    const { events } = await log.list();
    expect(events).toHaveLength(2);
    expect(events[0]?.event).toBe("TASK_PUBLISHED");
    expect(events[1]?.workbuddyMessageId).toBe("wb-1");
  });

  it("keeps history per task and does not let one task see another", async () => {
    const log = ledger("history.jsonl");
    await log.append({ event: "TASK_PUBLISHED", taskId: "a", taskFingerprint: "fa", source: "gpt" });
    await log.append({ event: "TASK_PUBLISHED", taskId: "b", taskFingerprint: "fb", source: "gpt" });

    const history = await log.history("a");
    expect(history).toHaveLength(1);
    expect(history[0]?.taskId).toBe("a");
  });

  it("counts an unreadable line instead of deleting it", async () => {
    const file = join(root, "corrupt.jsonl");
    await writeFile(file, `${JSON.stringify({ event: "TASK_PUBLISHED", taskId: "c", taskFingerprint: "fc" })}\nnot json\n`, "utf8");

    const log = new TaskLedger(new URL(`file:///${file.replace(/\\/g, "/")}`));
    const { events, corruptLines } = await log.list();

    expect(events).toHaveLength(1);
    expect(corruptLines).toBe(1);
  });

  it("does not glue onto a file whose last line has no newline", async () => {
    const file = join(root, "no-newline.jsonl");
    await writeFile(file, `${JSON.stringify({ event: "TASK_PUBLISHED", taskId: "d", taskFingerprint: "fd" })}`, "utf8");

    const log = new TaskLedger(new URL(`file:///${file.replace(/\\/g, "/")}`));
    await log.append({ event: "TASK_COMPLETED", taskId: "d", taskFingerprint: "fd", source: "relay" });

    const raw = await readFile(file, "utf8");
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);

    expect(lines).toHaveLength(2);
    expect(() => JSON.parse(lines[1] ?? "")).not.toThrow();
  });
});

describe("resend decision", () => {
  const req = { maxAttempts: 3 } as const;

  it("sends a fresh task", () => {
    const decision = decideDispatch([], {
      taskId: "t-1",
      taskFingerprint: "fp",
      gptEvidence: null,
      ...req,
    });

    expect(decision.kind).toBe("dispatched");
    if (decision.kind !== "dispatched") return;
    expect(decision.dispatchId).toBe("t-1#0");
    expect(decision.attempt).toBe(0);
  });

  it("allows a retry only when a dispatch exists, nothing confirmed ran, and the GPT page still shows the same envelope", () => {
    const decision = decideDispatch(healthyChain("t-1", "fp"), {
      taskId: "t-1",
      taskFingerprint: "fp",
      gptEvidence: { taskId: "t-1", taskFingerprint: "fp" },
      ...req,
    });

    expect(decision.kind).toBe("resend_allowed");
    if (decision.kind !== "resend_allowed") return;
    expect(decision.dispatchId).toBe("t-1#1");
    expect(decision.attempt).toBe(1);
  });

  it("refuses the retry when the GPT page no longer carries that envelope", () => {
    const decision = decideDispatch(healthyChain("t-1", "fp"), {
      taskId: "t-1",
      taskFingerprint: "fp",
      gptEvidence: { taskId: "t-1", taskFingerprint: "other" },
      ...req,
    });

    expect(decision).toEqual({
      kind: "blocked",
      reason: "gpt_not_found",
      detail: expect.stringContaining("no proof of what was published"),
    });
  });

  it("refuses to send a task that already produced a result", () => {
    const chain = healthyChain("t-1", "fp").concat([
      { seq: 4, at: "2026-10-02T00:01:00.000Z", event: "RESULT_RECEIVED" as const, taskId: "t-1", taskFingerprint: "fp", dispatchId: "t-1#0", attempt: 0, source: "workbuddy" as const, executor: "workbuddy", model: null, messageFingerprint: null, workbuddyMessageId: "wb-1", detail: null },
    ]);

    expect(decideDispatch(chain, { taskId: "t-1", taskFingerprint: "fp", gptEvidence: null, ...req })).toMatchObject({
      kind: "blocked",
      reason: "already_completed",
    });
  });

  it("refuses a second dispatch once WorkBuddy was seen running", () => {
    const chain = healthyChain("t-1", "fp").concat([
      { seq: 4, at: "2026-10-02T00:00:30.000Z", event: "RUNNING_CONFIRMED" as const, taskId: "t-1", taskFingerprint: "fp", dispatchId: "t-1#0", attempt: 0, source: "workbuddy" as const, executor: "workbuddy", model: null, messageFingerprint: null, workbuddyMessageId: "wb-1", detail: null },
    ]);

    expect(decideDispatch(chain, { taskId: "t-1", taskFingerprint: "fp", gptEvidence: null, ...req })).toMatchObject({
      kind: "blocked",
      reason: "already_running",
    });
  });

  it("refuses to blindly retry after a send was confirmed", () => {
    const chain = healthyChain("t-1", "fp").concat([
      { seq: 4, at: "2026-10-02T00:00:20.000Z", event: "SEND_CONFIRMED" as const, taskId: "t-1", taskFingerprint: "fp", dispatchId: "t-1#0", attempt: 0, source: "relay" as const, executor: "workbuddy", model: null, messageFingerprint: null, workbuddyMessageId: "wb-1", detail: null },
    ]);

    expect(decideDispatch(chain, { taskId: "t-1", taskFingerprint: "fp", gptEvidence: null, ...req })).toMatchObject({
      kind: "blocked",
      reason: "send_confirmed",
    });
  });

  it("allows the retry that the limit still has room for", () => {
    const chain = healthyChain("t-1", "fp").concat([
      { seq: 4, at: "2026-10-02T00:00:10.000Z", event: "TASK_REQUEUED" as const, taskId: "t-1", taskFingerprint: "fp", dispatchId: "t-1#1", attempt: 1, source: "relay" as const, executor: null, model: null, messageFingerprint: null, workbuddyMessageId: null, detail: null },
    ]);

    const decision = decideDispatch(chain, {
      taskId: "t-1",
      taskFingerprint: "fp",
      gptEvidence: { taskId: "t-1", taskFingerprint: "fp" },
      maxAttempts: 3,
    });

    expect(decision.kind).toBe("resend_allowed");
  });

  it("stops at the retry limit instead of retrying for ever", () => {
    const chain = healthyChain("t-1", "fp").concat([
      { seq: 4, at: "2026-10-02T00:00:10.000Z", event: "TASK_REQUEUED" as const, taskId: "t-1", taskFingerprint: "fp", dispatchId: "t-1#1", attempt: 1, source: "relay" as const, executor: null, model: null, messageFingerprint: null, workbuddyMessageId: null, detail: null },
    ]);

    const decision = decideDispatch(chain, {
      taskId: "t-1",
      taskFingerprint: "fp",
      gptEvidence: { taskId: "t-1", taskFingerprint: "fp" },
      maxAttempts: 2,
    });

    expect(decision.kind === "blocked" && decision.reason).toBe("attempts_exhausted");
  });

  it("blocks a contradiction: one taskId, two envelopes", () => {
    const chain = healthyChain("t-1", "fp").concat([
      { seq: 4, at: "2026-10-02T00:02:00.000Z", event: "TASK_PUBLISHED" as const, taskId: "t-1", taskFingerprint: "fp-2", dispatchId: null, attempt: null, source: "gpt" as const, executor: null, model: null, messageFingerprint: "m2", workbuddyMessageId: null, detail: null },
    ]);

    expect(decideDispatch(chain, { taskId: "t-1", taskFingerprint: "fp-2", gptEvidence: null, ...req })).toMatchObject({
      kind: "blocked",
      reason: "identity_conflict",
    });
  });

  /*
   * This is the accident that started the module: WorkBuddy cancelled a turn
   * that had already been sent and had already begun producing output.
   * Cancelling is not proof that nothing happened.
   */
  it("does not treat a cancelled turn as nothing having run", () => {
    const chain = healthyChain("t-1", "fp").concat([
      { seq: 4, at: "2026-10-02T00:00:30.000Z", event: "SEND_CONFIRMED" as const, taskId: "t-1", taskFingerprint: "fp", dispatchId: "t-1#0", attempt: 0, source: "relay" as const, executor: "workbuddy", model: null, messageFingerprint: null, workbuddyMessageId: "wb-1", detail: { cancelled: true } },
      { seq: 5, at: "2026-10-02T00:00:31.000Z", event: "RUNNING_CONFIRMED" as const, taskId: "t-1", taskFingerprint: "fp", dispatchId: "t-1#0", attempt: 0, source: "workbuddy" as const, executor: "workbuddy", model: null, messageFingerprint: null, workbuddyMessageId: "wb-1", detail: { cancelled: true } },
    ]);

    expect(decideDispatch(chain, { taskId: "t-1", taskFingerprint: "fp", gptEvidence: null, ...req })).toMatchObject({
      kind: "blocked",
      reason: "already_running",
    });

    const report = reconcile(chain, { reason: "cancelled" });
    expect(report.blocked).toBe(true);
  });
});

describe("reconcile", () => {
  it("reports a healthy chain as matched and not blocked", () => {
    const report = reconcile(healthyChain("t-1", "fp"), {
      reason: "startup",
      current: "t-1",
      pending: [],
    });

    expect(report.blocked).toBe(false);
    expect(report.tasksSeen).toBe(1);
    expect(report.tasks[0]?.state).toBe("dispatched");
    expect(report.findings.map((f) => f.kind)).toContain("missing_execution_evidence");
  });

  it("reports a finished chain as matched with no findings left", () => {
    const chain = healthyChain("t-1", "fp").concat([
      { seq: 4, at: "2026-10-02T00:00:20.000Z", event: "SEND_CONFIRMED" as const, taskId: "t-1", taskFingerprint: "fp", dispatchId: "t-1#0", attempt: 0, source: "relay" as const, executor: "workbuddy", model: "hy3", messageFingerprint: null, workbuddyMessageId: "wb-1", detail: null },
      { seq: 5, at: "2026-10-02T00:00:31.000Z", event: "RUNNING_CONFIRMED" as const, taskId: "t-1", taskFingerprint: "fp", dispatchId: "t-1#0", attempt: 0, source: "workbuddy" as const, executor: "workbuddy", model: "hy3", messageFingerprint: null, workbuddyMessageId: "wb-1", detail: null },
      { seq: 6, at: "2026-10-02T00:01:00.000Z", event: "RESULT_RECEIVED" as const, taskId: "t-1", taskFingerprint: "fp", dispatchId: "t-1#0", attempt: 0, source: "workbuddy" as const, executor: "workbuddy", model: "hy3", messageFingerprint: null, workbuddyMessageId: "wb-2", detail: null },
      { seq: 7, at: "2026-10-02T00:01:05.000Z", event: "RESULT_DELIVERED" as const, taskId: "t-1", taskFingerprint: "fp", dispatchId: "t-1#0", attempt: 0, source: "relay" as const, executor: "workbuddy", model: "hy3", messageFingerprint: null, workbuddyMessageId: "wb-2", detail: null },
      { seq: 8, at: "2026-10-02T00:01:06.000Z", event: "TASK_COMPLETED" as const, taskId: "t-1", taskFingerprint: "fp", dispatchId: "t-1#0", attempt: 0, source: "relay" as const, executor: "workbuddy", model: "hy3", messageFingerprint: null, workbuddyMessageId: "wb-2", detail: null },
    ]);

    const report = reconcile(chain, { reason: "completed", current: null, pending: [] });

    expect(report.blocked).toBe(false);
    expect(report.tasks[0]?.state).toBe("completed");
    expect(report.tasks[0]?.findings.map((f) => f.kind)).toEqual(["matched"]);
  });

  it("blocks on a duplicated send", () => {
    const chain = healthyChain("t-1", "fp").concat([
      { seq: 4, at: "2026-10-02T00:00:40.000Z", event: "DISPATCH_STARTED" as const, taskId: "t-1", taskFingerprint: "fp", dispatchId: "t-1#0", attempt: 0, source: "relay" as const, executor: "workbuddy", model: null, messageFingerprint: null, workbuddyMessageId: null, detail: null },
    ]);

    const report = reconcile(chain);
    expect(report.blocked).toBe(true);
    expect(report.findings.some((f) => f.kind === "duplicate_dispatch")).toBe(true);
  });

  it("flags a task that was published but never reached the send", () => {
    const report = reconcile(healthyChain("t-1", "fp"));
    expect(report.findings.some((f) => f.kind === "missing_execution_evidence")).toBe(true);
    expect(report.tasks[0]?.mayResend).toBe(false);
  });

  it("flags a task the state file has forgotten", () => {
    const report = reconcile(healthyChain("t-1", "fp"), { reason: "startup", current: null, pending: [] });

    expect(report.blocked).toBe(true);
    expect(report.findings.some((f) => f.kind === "orphaned_task")).toBe(true);
  });

  it("accepts the same task while it is still queued or in flight", () => {
    const report = reconcile(healthyChain("t-1", "fp"), { current: "t-1", pending: [] });
    expect(report.blocked).toBe(false);

    const queued = reconcile(healthyChain("t-1", "fp"), { current: null, pending: ["t-1"] });
    expect(queued.blocked).toBe(false);
  });

  it("warns when the ledger writes a result before the send that caused it", () => {
    const outOfOrder: ReconciliationEvent[] = [
      { seq: 1, at: "2026-10-02T00:09:00.000Z", event: "RESULT_RECEIVED", taskId: "t-1", taskFingerprint: "fp", dispatchId: "t-1#0", attempt: 0, source: "workbuddy", executor: "workbuddy", model: null, messageFingerprint: null, workbuddyMessageId: "wb-1", detail: null },
      { seq: 2, at: "2026-10-02T00:09:01.000Z", event: "SEND_CONFIRMED", taskId: "t-1", taskFingerprint: "fp", dispatchId: "t-1#0", attempt: 0, source: "relay", executor: "workbuddy", model: null, messageFingerprint: null, workbuddyMessageId: "wb-1", detail: null },
    ];

    const report = reconcile(outOfOrder);
    expect(report.findings.some((f) => f.kind === "out_of_order")).toBe(true);
    expect(report.tasks[0]?.state).toBe("running");
  });

  it("blocks when the ledger holds a result the relay was not running", () => {
    const resultOfAnotherTask: ReconciliationEvent[] = [
      { seq: 1, at: "2026-10-02T00:10:00.000Z", event: "RESULT_RECEIVED", taskId: "t-stale", taskFingerprint: "fp", dispatchId: "t-stale#0", attempt: 0, source: "workbuddy", executor: "workbuddy", model: null, messageFingerprint: null, workbuddyMessageId: "wb-1", detail: null },
    ];

    const report = reconcile(resultOfAnotherTask, { reason: "startup", current: "t-2", pending: [] });

    expect(report.blocked).toBe(true);
    expect(report.findings.some((f) => f.kind === "result_task_id_mismatch")).toBe(true);
    expect(report.findings.find((f) => f.kind === "result_task_id_mismatch")?.detail).toContain("t-2");
  });

  it("leaves the in-flight task alone when the result belongs to it", () => {
    const chain: ReconciliationEvent[] = [
      { seq: 1, at: "2026-10-02T00:11:00.000Z", event: "TASK_PUBLISHED", taskId: "t-2", taskFingerprint: "fp", dispatchId: null, attempt: null, source: "gpt", executor: null, model: null, messageFingerprint: null, workbuddyMessageId: null, detail: null },
      { seq: 2, at: "2026-10-02T00:11:10.000Z", event: "RESULT_RECEIVED", taskId: "t-2", taskFingerprint: "fp", dispatchId: "t-2#0", attempt: 0, source: "workbuddy", executor: "workbuddy", model: null, messageFingerprint: null, workbuddyMessageId: "wb-1", detail: null },
    ];

    const report = reconcile(chain, { current: "t-2", pending: [] });

    expect(report.blocked).toBe(false);
    expect(report.findings.some((f) => f.kind === "result_task_id_mismatch")).toBe(false);
  });
});

describe("reconciliation service", () => {
  it("blocks a task id that arrives under a second envelope, and records why", async () => {
    const log = ledger("service-conflict.jsonl");
    const service = new ReconciliationService(log);

    await service.recordTaskPublished({ taskId: "t-1", taskFingerprint: "fp-1", source: "gpt" });
    const second = await service.recordTaskPublished({ taskId: "t-1", taskFingerprint: "fp-2", source: "gpt" });

    expect(second.status).toBe("blocked");

    const history = await service.getTaskHistory("t-1");
    expect(history.map((e) => e.event)).toEqual(["TASK_PUBLISHED", "TASK_BLOCKED", "RECONCILIATION_BLOCKED"]);
  });

  it("records the evidence of a turn and reconciles the whole ledger", async () => {
    const log = ledger("service-chain.jsonl");
    const service = new ReconciliationService(log);

    await service.recordTaskPublished({ taskId: "t-2", taskFingerprint: "fp", source: "gpt" });
    await service.recordDispatch({ taskId: "t-2", taskFingerprint: "fp", dispatchId: "t-2#0", attempt: 0, model: "hy3" });
    await service.recordExecutionEvidence({ event: "SEND_CONFIRMED", taskId: "t-2", taskFingerprint: "fp", dispatchId: "t-2#0", attempt: 0, workbuddyMessageId: "wb-1" });
    await service.recordExecutionEvidence({ event: "RUNNING_CONFIRMED", taskId: "t-2", taskFingerprint: "fp", dispatchId: "t-2#0", attempt: 0, workbuddyMessageId: "wb-1" });
    await service.recordExecutionEvidence({ event: "RESULT_RECEIVED", taskId: "t-2", taskFingerprint: "fp", dispatchId: "t-2#0", attempt: 0, workbuddyMessageId: "wb-2" });
    await service.recordExecutionEvidence({ event: "TASK_COMPLETED", taskId: "t-2", taskFingerprint: "fp", dispatchId: "t-2#0", attempt: 0, workbuddyMessageId: "wb-2" });

    const { report } = await service.reconcile("after-result");

    expect(report.tasks[0]?.state).toBe("completed");
    expect(report.blocked).toBe(false);
    expect(await log.length()).toBe(6);
  });
});
