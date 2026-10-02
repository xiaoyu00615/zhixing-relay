import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ReconciliationService,
  TaskLedger,
  decideDispatch,
  dispatchIdFor,
  identityFingerprints,
  isConcreteTaskFingerprint,
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

/*
 * The ledger the relay really produced during the two hour incident: one
 * envelope, a dispatch, a send confirmation, and then the requeue and the
 * startup block written without an envelope to point at. The last two carry
 * the placeholder fingerprint on purpose - that is what the writers had to
 * write when they could not name the task - and on this chain they are what
 * made reconciliation report a contradiction that never existed.
 */
const INCIDENT_TASK = "relay-reliable-ack-v047-001";
const INCIDENT_ENVELOPE =
  "[ZHIXING_RELAY]\nTYPE: TASK\nTASK_ID: relay-reliable-ack-v047-001\n\nfreeze the chain and say what you saw\n[ZHIXING_RELAY_END]";
const INCIDENT_HASH = taskFingerprint(INCIDENT_ENVELOPE);

function incidentLedger(): ReconciliationEvent[] {
  const at = "2026-10-02T00:00:00.000Z";
  const row = (
    seq: number,
    event: ReconciliationEvent["event"],
    taskId: string,
    taskFingerprint: string,
    extra: Partial<ReconciliationEvent> = {},
  ): ReconciliationEvent => ({
    seq,
    at,
    event,
    taskId,
    taskFingerprint,
    dispatchId: null,
    attempt: null,
    source: "relay",
    executor: null,
    model: null,
    messageFingerprint: null,
    workbuddyMessageId: null,
    detail: null,
    ...extra,
  });

  return [
    row(1, "RECONCILIATION_MATCHED", "*", "*"),
    row(2, "TASK_PUBLISHED", INCIDENT_TASK, INCIDENT_HASH, { source: "gpt" }),
    row(3, "DISPATCH_STARTED", INCIDENT_TASK, INCIDENT_HASH, {
      dispatchId: `${INCIDENT_TASK}#0`,
      attempt: 0,
    }),
    row(4, "SEND_CONFIRMED", INCIDENT_TASK, INCIDENT_HASH, {
      dispatchId: `${INCIDENT_TASK}#0`,
      attempt: 0,
    }),
    row(5, "TASK_REQUEUED", INCIDENT_TASK, "*", {
      detail: { retryCount: 1, reason: "Timed out waiting WorkBuddy after 7200000ms" },
    }),
    row(6, "RECONCILIATION_BLOCKED", INCIDENT_TASK, "*"),
  ];
}

describe("fingerprints that name nothing", () => {
  it("recognises a placeholder as bookkeeping and a hash as identity", () => {
    expect(isConcreteTaskFingerprint("*")).toBe(false);
    expect(isConcreteTaskFingerprint("")).toBe(false);
    expect(isConcreteTaskFingerprint(null)).toBe(false);
    expect(isConcreteTaskFingerprint(undefined)).toBe(false);
    expect(isConcreteTaskFingerprint(INCIDENT_HASH)).toBe(true);
  });

  it("counts identity, not rows", () => {
    expect(identityFingerprints([INCIDENT_HASH, INCIDENT_HASH, "*", "*", null, ""])).toEqual([
      INCIDENT_HASH,
    ]);
    expect(identityFingerprints(["*", "*"])).toEqual([]);
    expect(identityFingerprints([INCIDENT_HASH, "other", "*"])).toHaveLength(2);
  });
});

describe("the incident ledger", () => {
  it("reads one identity out of a chain that mentions a task and its bookkeeping", () => {
    const report = reconcile(incidentLedger(), { reason: "startup", current: INCIDENT_TASK, pending: [] });

    const task = report.tasks.find((item) => item.taskId === INCIDENT_TASK);
    expect(task?.identities).toEqual([INCIDENT_HASH]);
    expect(task?.fingerprints).toEqual([INCIDENT_HASH, "*"]);
    expect(report.findings.some((finding) => finding.kind === "identity_conflict")).toBe(false);
  });

  /*
   * The assertion that matters: while the relay still knows the task, the
   * chain the accident left behind is not blocked. The placeholder rows are
   * footnotes about it, not a second envelope.
   */
  it("is not blocked while the relay still knows the task", () => {
    const report = reconcile(incidentLedger(), { reason: "startup", current: INCIDENT_TASK, pending: [] });

    expect(report.blocked).toBe(false);
    expect(report.tasks.find((item) => item.taskId === INCIDENT_TASK)?.state).toBe("dispatched");

    /*
     * The report keeps its informational note that a requeue makes a retry
     * look harmless; it is a note, not a green light. The gate that actually
     * decides is the dispatch decision below, and that one refuses anything
     * that was proven sent.
     */
    const kinds = report.findings.map((finding) => finding.kind);
    expect(kinds).toContain("missing_execution_evidence");
    expect(kinds).toContain("missing_result_receipt");
    expect(kinds).not.toContain("identity_conflict");
  });

  /*
   * Never let the placeholder rows turn into a reason to send again. A task
   * that was proven sent answers the dispatch question before any retry rule
   * can be reached, so the request above stays frozen even though the report
   * itself carries an informational "resend" note.
   */
  it("cannot be resent through the dispatch decision, however the report reads", async () => {
    const log = ledger("incident-no-resend.jsonl");
    const service = new ReconciliationService(log);

    for (const event of incidentLedger()) {
      await log.append({
        event: event.event,
        taskId: event.taskId,
        taskFingerprint: event.taskFingerprint,
        dispatchId: event.dispatchId,
        attempt: event.attempt,
        source: event.source,
      });
    }

    const history = await service.getTaskHistory(INCIDENT_TASK);
    expect(decideDispatch(history, {
      taskId: INCIDENT_TASK,
      taskFingerprint: INCIDENT_HASH,
      gptEvidence: null,
      maxAttempts: 3,
    })).toMatchObject({ kind: "blocked", reason: "send_confirmed" });
  });

  /*
   * Once the live state has forgotten the task, the chain gains a blocker that
   * has nothing to do with fingerprints: the ledger knows a task the relay
   * does not. That finding existed before this repair and belongs to a
   * different question, so it is reported and left alone.
   */
  it("reports the task as orphaned - and only as orphaned - once the relay forgot it", () => {
    const report = reconcile(incidentLedger(), { reason: "startup", current: null, pending: [] });

    expect(report.blocked).toBe(true);
    expect(report.findings.filter((finding) => finding.severity === "blocking").map((finding) => finding.kind)).toEqual([
      "orphaned_task",
    ]);
    expect(report.findings.some((finding) => finding.kind === "identity_conflict")).toBe(false);

    /*
     * The forgotten accident carries SEND_CONFIRMED and TASK_REQUEUED. It is
     * blocked, and it must not also wear a note offering a resend: the note
     * and the gate are the same fact now, so no resend_allowed is printed for
     * a chain the relay has already proven it sent.
     */
    expect(report.resendAllowed).toBe(false);
    expect(report.findings.map((finding) => finding.kind)).not.toContain("resend_allowed");
  });

  /*
   * Recording the placeholder that a resolution writes must not chain onto the
   * task it is attached to: the resolution is about the hold, not about the
   * envelope, so it carries the placeholder even when it names the task.
   */
  it("lifts the hold for a task without making the task look published twice", async () => {
    const log = ledger("incident-resolved.jsonl");
    const service = new ReconciliationService(log);

    for (const event of incidentLedger()) {
      await log.append({
        event: event.event,
        taskId: event.taskId,
        taskFingerprint: event.taskFingerprint,
        source: event.source,
      });
    }

    await service.recordReconciliationResolved({ taskId: INCIDENT_TASK, reason: "operator decided" });

    const { events: rows } = await log.list();
    expect(rows.map((event) => event.event)).toContain("RECONCILIATION_RESOLVED");
    expect(rows.find((event) => event.event === "RECONCILIATION_RESOLVED")?.taskFingerprint).toBe("*");

    const { report } = await service.reconcile("after resolution");
    expect(report.findings.some((finding) => finding.kind === "identity_conflict")).toBe(false);
    expect(report.blocked).toBe(true);

    /*
     * The resolution row is bookkeeping, so the only blocker left is the task
     * the live state has forgotten about; the resolution did not add one, and
     * it did not silence the contradiction that never existed.
     */
    expect(report.findings.filter((finding) => finding.severity === "blocking").map((finding) => finding.kind)).toEqual([
      "orphaned_task",
    ]);
  });

  it("accepts the real envelope on top of a placeholder row the old release wrote", async () => {
    const log = ledger("incident-publish-over-placeholder.jsonl");
    const service = new ReconciliationService(log);

    await log.append({
      event: "TASK_REQUEUED",
      taskId: INCIDENT_TASK,
      taskFingerprint: "*",
      source: "relay",
      detail: { retryCount: 1 },
    });

    const publish = await service.recordTaskPublished({
      taskId: INCIDENT_TASK,
      taskFingerprint: INCIDENT_HASH,
      source: "gpt",
    });

    expect(publish.status).toBe("ok");
    expect(await log.length()).toBe(2);
  });
});

describe("a contradiction that is real", () => {
  const twoEnvelopes = (first: string, second: string): ReconciliationEvent[] => {
    const base = incidentLedger().filter(
      (event) => isConcreteTaskFingerprint(event.taskFingerprint) || event.event === "RECONCILIATION_MATCHED",
    );

    return base.concat([
      { ...base[1] as ReconciliationEvent, seq: 7, event: "TASK_PUBLISHED", taskFingerprint: first },
      { ...base[1] as ReconciliationEvent, seq: 8, event: "TASK_PUBLISHED", taskFingerprint: second, messageFingerprint: "m2" },
    ]);
  };

  it("blocks two concrete envelopes under one task id, and offers no resend", () => {
    const report = reconcile(twoEnvelopes(INCIDENT_HASH, "0".repeat(64)), {
      reason: "startup",
      current: INCIDENT_TASK,
      pending: [],
    });

    expect(report.blocked).toBe(true);
    expect(report.resendAllowed).toBe(false);

    const conflict = report.findings.find((finding) => finding.kind === "identity_conflict");
    expect(conflict?.severity).toBe("blocking");
    expect(report.tasks.find((task) => task.taskId === INCIDENT_TASK)?.mayResend).toBe(false);
  });

  it("blocks the dispatch decision for the same two envelopes", () => {
    const history = twoEnvelopes(INCIDENT_HASH, "0".repeat(64)).filter(
      (event) => event.event === "TASK_PUBLISHED" || event.event === "RECONCILIATION_MATCHED",
    );

    expect(decideDispatch(history, {
      taskId: INCIDENT_TASK,
      taskFingerprint: "0".repeat(64),
      gptEvidence: null,
      maxAttempts: 3,
    })).toMatchObject({ kind: "blocked", reason: "identity_conflict" });
  });
});
/*
 * The last piece of the semantics: the ledger can hold a task the live state
 * has forgotten. Three answers have to stay apart - the relay still running
 * it, the task lost, and the task a human closed - and only the middle one
 * may freeze scheduling.
 */
describe("a task the relay has forgotten", () => {
  const OTHER_TASK = "relay-reliable-ack-v047-002";
  const OTHER_HASH = "1".repeat(64);

  /** The accident chain, seeded through the ledger itself, not as an array. */
  async function seedAccident(name: string): Promise<{ log: TaskLedger; service: ReconciliationService }> {
    const log = ledger(name);
    const service = new ReconciliationService(log);

    for (const event of incidentLedger()) {
      await log.append({
        event: event.event,
        taskId: event.taskId,
        taskFingerprint: event.taskFingerprint,
        dispatchId: event.dispatchId,
        attempt: event.attempt,
        source: event.source,
      });
    }

    return { log, service };
  }

  /*
   * Before any decision: the chain the accident left behind. It blocks - the
   * relay forgot the task - but it never offers a resend, because WorkBuddy
   * proved it got the send and an old requeue row cannot say otherwise.
   */
  it("blocks on the orphan, and never offers a resend the send was proven for", async () => {
    const { service } = await seedAccident("forgotten-before.jsonl");

    const { report } = await service.reconcile("startup", { pending: [], current: null });

    expect(report.findings.filter((finding) => finding.severity === "blocking").map((f) => f.kind)).toEqual([
      "orphaned_task",
    ]);
    expect(report.blocked).toBe(true);
    expect(report.resendAllowed).toBe(false);
    expect(report.tasks.find((task) => task.taskId === INCIDENT_TASK)?.mayResend).toBe(false);
    expect(report.findings.some((finding) => finding.kind === "identity_conflict")).toBe(false);
  });

  /*
   * The live context is what tells "the relay is running it" from "the relay
   * lost it". Without it every unfinished task in the ledger - including the
   * one running this second - reads as orphaned.
   */
  it("does not orphan a task the relay is running or still has queued", async () => {
    const { service } = await seedAccident("forgotten-live.jsonl");

    const running = await service.reconcile("startup", { pending: [], current: INCIDENT_TASK });
    expect(running.report.blocked).toBe(false);
    expect(running.report.findings.some((finding) => finding.kind === "orphaned_task")).toBe(false);

    const queued = await service.reconcile("startup", { pending: [INCIDENT_TASK], current: null });
    expect(queued.report.blocked).toBe(false);
    expect(queued.report.findings.some((finding) => finding.kind === "orphaned_task")).toBe(false);

    // ... and the very same chain is an orphan once the relay has forgotten it.
    const forgotten = await service.reconcile("startup", { pending: [], current: null });
    expect(forgotten.report.blocked).toBe(true);
    expect(forgotten.report.findings.some((finding) => finding.kind === "orphaned_task")).toBe(true);
  });

  /*
   * The accident, closed the only honest way: a human says WorkBuddy finished
   * the work and it will never be resent. The task is not enqueued, not
   * requeued, and no completion the relay never saw is written in its place.
   */
  it("closes the orphan without sending, requeueing or rewriting anything", async () => {
    const { log, service } = await seedAccident("forgotten-closed.jsonl");
    const linesBefore = (await log.list()).events.length;

    const closed = await service.recordTaskClosedWithoutResend({
      taskId: INCIDENT_TASK,
      reason: "WorkBuddy finished the work; the result never reached the relay",
    });

    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    expect(closed.event.event).toBe("RECONCILIATION_RESOLVED");
    // Task-scoped: it names the task it closes, and carries no envelope.
    expect(closed.event.taskId).toBe(INCIDENT_TASK);
    expect(closed.event.taskFingerprint).toBe("*");
    expect(closed.event.detail).toMatchObject({ disposition: "close_without_resend" });

    const { report } = await service.reconcile("after close", { pending: [], current: null });

    expect(report.blocked).toBe(false);
    expect(report.findings.some((finding) => finding.kind === "orphaned_task")).toBe(false);
    expect(report.findings.some((finding) => finding.kind === "historical_task_closed")).toBe(true);
    expect(report.resendAllowed).toBe(false);
    expect(report.tasks.find((task) => task.taskId === INCIDENT_TASK)?.mayResend).toBe(false);
    expect(report.tasks.find((task) => task.taskId === INCIDENT_TASK)?.closedAtSeq).toBe(closed.event.seq);

    /*
     * One row was added and nothing else: no second dispatch, no completion,
     * no correction of the chain the relay already recorded.
     */
    const { events: rows } = await log.list();
    expect(rows).toHaveLength(linesBefore + 1);
    expect(rows.filter((row) => row.event === "DISPATCH_STARTED")).toHaveLength(1);
    expect(rows.filter((row) => row.event === "TASK_COMPLETED")).toHaveLength(0);
  });

  it("refuses a close that does not name a task", async () => {
    const { service } = await seedAccident("forgotten-no-task.jsonl");

    expect(await service.recordTaskClosedWithoutResend({ taskId: "   ", reason: "why" })).toMatchObject({
      ok: false,
    });
    expect(
      (await service.reconcile("after close", { pending: [], current: null })).report.blocked,
    ).toBe(true);
  });

  /*
   * A restart reads the same file again. The closure has to survive it, or the
   * next start-up would re-freeze on a task a human already settled.
   */
  it("stays closed after a restart that re-reads the ledger from disk", async () => {
    const { service } = await seedAccident("forgotten-restart.jsonl");

    await service.recordTaskClosedWithoutResend({ taskId: INCIDENT_TASK, reason: "already done" });

    // A new process: the same file, the same answer.
    const restarted = new ReconciliationService(ledger("forgotten-restart.jsonl"));
    const { report } = await restarted.reconcile("startup after restart", { pending: [], current: null });

    expect(report.blocked).toBe(false);
    expect(report.findings.some((finding) => finding.kind === "orphaned_task")).toBe(false);
    expect(report.tasks.find((task) => task.taskId === INCIDENT_TASK)?.closedAtSeq).not.toBeNull();
  });

  /*
   * A close that cleared *everything* would be a global reset wearing an
   * operator's authority, so it closes the task it names and nothing more.
   */
  it("closes only the task it names: another forgotten task stays blocked", async () => {
    const log = ledger("forgotten-multi.jsonl");

    for (const event of incidentLedger()) {
      await log.append({
        event: event.event,
        taskId: event.taskId,
        taskFingerprint: event.taskFingerprint,
        dispatchId: event.dispatchId,
        attempt: event.attempt,
        source: event.source,
      });
    }
    await log.append({
      event: "TASK_PUBLISHED",
      taskId: OTHER_TASK,
      taskFingerprint: OTHER_HASH,
      source: "gpt",
    });
    await log.append({
      event: "DISPATCH_STARTED",
      taskId: OTHER_TASK,
      taskFingerprint: OTHER_HASH,
      dispatchId: `${OTHER_TASK}#0`,
      attempt: 0,
      source: "relay",
    });

    const service = new ReconciliationService(log);
    await service.recordTaskClosedWithoutResend({ taskId: INCIDENT_TASK, reason: "already done" });

    const { report } = await service.reconcile("after close", { pending: [], current: null });

    // Three chains: the accident, the other lost task, and the placeholder row.
    expect(report.tasksSeen).toBe(3);
    expect(report.blocked).toBe(true);
    expect(
      report.findings
        .filter((finding) => finding.severity === "blocking")
        .map((finding) => `${finding.kind}:${finding.taskId}`),
    ).toEqual([`orphaned_task:${OTHER_TASK}`]);
    expect(report.findings.some((finding) => finding.kind === "historical_task_closed" && finding.taskId === INCIDENT_TASK)).toBe(true);
    expect(report.tasks.find((task) => task.taskId === OTHER_TASK)?.closedAtSeq).toBeNull();
  });

  /*
   * A decision cannot cover what happens after it. When the chain grows a new
   * send, that send is judged on its own and the old orphan comes back.
   */
  it("does not let a closure cover a later send", async () => {
    const { log, service } = await seedAccident("forgotten-boundary.jsonl");

    const closed = await service.recordTaskClosedWithoutResend({ taskId: INCIDENT_TASK, reason: "already done" });
    if (!closed.ok) throw new Error("the closure was not written");

    // A later send, written the way any later execution record would be: an
    // appended row, never a correction of the chain already on disk.
    await log.append({
      event: "DISPATCH_STARTED",
      taskId: INCIDENT_TASK,
      taskFingerprint: INCIDENT_HASH,
      dispatchId: `${INCIDENT_TASK}#1`,
      attempt: 1,
      source: "relay",
      detail: { reason: "requeued after the closure was written" },
    });

    const { report } = await service.reconcile("after a later send", { pending: [], current: null });

    expect(report.blocked).toBe(true);
    expect(report.findings.filter((finding) => finding.severity === "blocking").map((f) => f.kind)).toEqual([
      "orphaned_task",
    ]);
    expect(report.findings.some((finding) => finding.kind === "historical_task_closed")).toBe(false);
    expect(report.tasks.find((task) => task.taskId === INCIDENT_TASK)?.closedAtSeq).toBe(closed.event.seq);
  });

  /*
   * The pair that keeps the rule honest: a proven send refuses a resend, but
   * a chain with no send evidence at all still gets one - otherwise the rule
   * would have become "never resend" and the requeue path would be dead.
   */
  it("offers a resend only while nothing proves WorkBuddy got the task", () => {
    const proven = reconcile(incidentLedger(), { reason: "manual", pending: [], current: INCIDENT_TASK });

    expect(proven.tasks.find((task) => task.taskId === INCIDENT_TASK)?.mayResend).toBe(false);
    expect(proven.resendAllowed).toBe(false);

    /*
     * The note and the gate are one fact. The chain below carries a proven
     * send, so it must not carry a `resend_allowed` finding either: a report
     * that offers a resend the relay is about to refuse is worse than no
     * report, because it is what an operator acts on.
     */
    expect(proven.findings.map((finding) => finding.kind)).not.toContain("resend_allowed");

    const unproven = reconcile(
      incidentLedger().filter((event) => event.event !== "SEND_CONFIRMED"),
      { reason: "manual", pending: [], current: INCIDENT_TASK },
    );

    expect(unproven.tasks.find((task) => task.taskId === INCIDENT_TASK)?.mayResend).toBe(true);
    expect(unproven.resendAllowed).toBe(true);
    expect(unproven.findings.map((finding) => finding.kind)).toContain("resend_allowed");
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
