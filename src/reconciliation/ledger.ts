import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isoNow } from "../utils.js";
import {
  makeEvent,
  type NewReconciliationEvent,
  type ReconciliationEvent,
} from "./types.js";

/**
 * Append-only task ledger.
 *
 * The ledger is the only place that can answer "what did WorkBuddy actually
 * receive for this task?", which the live state cannot, because state.json
 * overwrites itself. Every write here therefore only ever adds a line.
 *
 * There is deliberately no update, no delete, no clear and no rewrite: the
 * ways to break a ledger are all in this class and none of them exist. If the
 * file grows too big the answer is rotation, which belongs to whoever runs the
 * relay, not to a writer.
 */
export class TaskLedger {
  private readonly file: string;

  constructor(url: URL) {
    this.file = fileURLToPath(url);
  }

  /** Appends one event and returns it carrying its assigned sequence number. */
  async append(input: {
    event: NewReconciliationEvent["event"];
    taskId: string;
    taskFingerprint: string;
    dispatchId?: string | null;
    attempt?: number | null;
    source?: NewReconciliationEvent["source"];
    executor?: string | null;
    model?: string | null;
    messageFingerprint?: string | null;
    workbuddyMessageId?: string | null;
    detail?: Record<string, unknown> | null;
  }): Promise<ReconciliationEvent> {
    const written = await this.appendMany([input]);
    return written[0] as ReconciliationEvent;
  }

  /** Appends a batch in one pass, so a burst keeps its order. */
  async appendMany(
    inputs: Array<{
      event: NewReconciliationEvent["event"];
      taskId: string;
      taskFingerprint: string;
      dispatchId?: string | null;
      attempt?: number | null;
      source?: NewReconciliationEvent["source"];
      executor?: string | null;
      model?: string | null;
      messageFingerprint?: string | null;
      workbuddyMessageId?: string | null;
      detail?: Record<string, unknown> | null;
    }>,
  ): Promise<ReconciliationEvent[]> {
    if (inputs.length === 0) return [];

    await mkdir(dirname(this.file), { recursive: true });

    const existing = await readFile(this.file, "utf8").catch(() => "");

    /*
     * A file that was written by something else may not end on a newline.
     * Appending to it would glue the new event to the old line and corrupt
     * both, so the separator is forced before the first event goes in.
     */
    const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";

    const base = existing.split("\n").filter((line) => line.trim().length > 0).length;

    const written = inputs.map((input, index) => ({
      seq: base + index + 1,
      ...makeEvent(
        {
          event: input.event,
          taskId: input.taskId,
          taskFingerprint: input.taskFingerprint,
          dispatchId: input.dispatchId ?? null,
          attempt: input.attempt ?? null,
          source: input.source ?? "relay",
          executor: input.executor ?? null,
          model: input.model ?? null,
          messageFingerprint: input.messageFingerprint ?? null,
          workbuddyMessageId: input.workbuddyMessageId ?? null,
          detail: input.detail ?? null,
        },
        isoNow(),
      ),
    }));

    const payload = written
      .map((event) => JSON.stringify(event))
      .join("\n");

    await appendFile(this.file, `${separator}${payload}\n`, "utf8");

    return written;
  }

  /**
   * Reads the whole ledger. Lines that are not valid JSON are counted, never
   * dropped: a ledger with holes is exactly the thing reconciliation has to
   * be able to see.
   */
  async list(): Promise<{ events: ReconciliationEvent[]; corruptLines: number }> {
    const raw = await readFile(this.file, "utf8").catch(() => "");
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);

    const events: ReconciliationEvent[] = [];
    let corruptLines = 0;

    for (const line of lines) {
      let parsed: ReconciliationEvent | null = null;

      try {
        const value: unknown = JSON.parse(line);
        if (value && typeof value === "object" && typeof (value as ReconciliationEvent).event === "string") {
          parsed = value as ReconciliationEvent;
        }
      } catch {
        parsed = null;
      }

      if (parsed) events.push(parsed);
      else corruptLines += 1;
    }

    return { events, corruptLines };
  }

  /** Every event for one task, in append order. */
  async history(taskId: string): Promise<ReconciliationEvent[]> {
    const { events } = await this.list();
    return events.filter((event) => event.taskId === taskId);
  }

  async length(): Promise<number> {
    const { events } = await this.list();
    return events.length;
  }
}

/** The ledger the relay itself uses, next to the audit log. */
export function defaultLedgerUrl(): URL {
  return new URL("../data/ledger.jsonl", import.meta.url);
}
