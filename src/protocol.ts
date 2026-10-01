import { normalizeText } from "./utils.js";

/** Opens a relay block. Everything Relay reads lives between the two markers. */
export const RELAY_BLOCK_OPEN = "[ZHIXING_RELAY]";
/** Closes a relay block. An envelope without it is the legacy form. */
export const RELAY_BLOCK_CLOSE = "[ZHIXING_RELAY_END]";

/**
 * A relay block pulled out of a longer message.
 *
 * `before` / `after` are the surrounding prose. They are returned so a caller
 * can say how much of the reply was dropped, never so it can be sent.
 */
export type TaskBlock = {
  /** `[ZHIXING_RELAY]` up to and including `[ZHIXING_RELAY_END]`, trimmed. */
  block: string;
  before: string;
  after: string;
  /** True when no END marker closed the block, so it ran to the end of the text. */
  legacy: boolean;
};

/**
 * Line offsets of a `\n`-split string, used to slice the original text back
 * out of. Scanning by lines is what keeps a `[ZHIXING_RELAY]` written inside
 * the task body from cutting the block open again.
 */
function lineOffsets(lines: readonly string[]): number[] {
  const offsets: number[] = [];
  let cursor = 0;
  for (const line of lines) {
    offsets.push(cursor);
    cursor += line.length + 1;
  }
  return offsets;
}

function makeBlock(raw: string, from: number, to: number, legacy: boolean): TaskBlock {
  const open = raw.indexOf(RELAY_BLOCK_OPEN, from);
  const close = legacy ? -1 : raw.indexOf(RELAY_BLOCK_CLOSE, from);

  return {
    block: raw.slice(open, close < 0 ? to : close + RELAY_BLOCK_CLOSE.length).trim(),
    before: raw.slice(0, open).trim(),
    after: close < 0 ? "" : raw.slice(close + RELAY_BLOCK_CLOSE.length).trim(),
    legacy,
  };
}

/**
 * Every relay block in `text`, split by whether an END marker closed it.
 *
 * Markers only count when they own their whole line, so a task body that quotes
 * the protocol (a code fence, a paragraph mentioning the marker) cannot open a
 * second block, and prose that merely mentions `[ZHIXING_RELAY]` is not a task.
 */
export function scanRelayBlocks(text: string): {
  complete: TaskBlock[];
  unterminated: TaskBlock[];
} {
  const raw = normalizeText(text);
  const lines = raw.split("\n");
  const offsets = lineOffsets(lines);

  const complete: TaskBlock[] = [];
  const unterminated: TaskBlock[] = [];

  let openLine = -1;
  let openAt = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = (lines[index] ?? "").trim();
    const at = offsets[index] ?? 0;

    if (openLine < 0) {
      if (trimmed !== RELAY_BLOCK_OPEN) continue;
      openLine = index;
      openAt = at;
      continue;
    }

    if (trimmed !== RELAY_BLOCK_CLOSE) continue;

    complete.push(makeBlock(raw, openAt, at, false));
    openLine = -1;
    openAt = 0;
  }

  /*
   * Legacy form: `[ZHIXING_RELAY]` with nothing closing it, so the envelope
   * runs to the end of the message. The RESULT Relay itself sends to ChatGPT is
   * still written this way, so dropping this branch would break completion.
   */
  if (openLine >= 0) {
    unterminated.push(makeBlock(raw, openAt, raw.length, true));
  }

  return { complete, unterminated };
}

/**
 * The first relay block inside `text`, or null when the text has none.
 *
 * The markers may sit anywhere in the message: a reply that opens with an
 * explanation and appends its task at the end is the normal case, and the
 * prose around the block is dropped rather than forwarded.
 */
export function extractTaskBlock(text: string): TaskBlock | null {
  const { complete, unterminated } = scanRelayBlocks(text);
  return complete[0] ?? unterminated[0] ?? null;
}

export type ParsedRelayTask = {
  taskId: string | null;
  type: string | null;
  source: string | null;
  /**
   * The task's own model constraint, e.g. `MODEL: hy3`.
   *
   * A null here means the task does not care which model runs it, which is
   * different from "the task asked for a model that does not exist": the
   * router keeps both apart so a typo degrades to normal routing instead of
   * silently choosing a model the GPT side never asked for.
   */
  model: string | null;
  /** The envelope as it arrived: markers, headers and body, trimmed. */
  block: string | null;
  /** The task payload: everything in the envelope after its header lines. */
  body: string;
  /** True when the envelope carried no END marker. */
  legacy: boolean;
  /** True when the message carried more than one complete relay block. */
  ambiguous: boolean;
  raw: string;
};

/** `KEY: value`, read from the header lines of an envelope only. */
const HEADER_LINE = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/;

function stripMarkers(block: string): string[] {
  const lines = block.split("\n");
  if (lines[0]?.trim() === RELAY_BLOCK_OPEN) lines.shift();

  const last = lines[lines.length - 1];
  if (last !== undefined && last.trim() === RELAY_BLOCK_CLOSE) lines.pop();

  return lines;
}

/**
 * Reads the leading header run of an envelope.
 *
 * The run stops at the first line that is not `KEY: value`, so a body line
 * that happens to read `TYPE: TASK` can never become the envelope's type, and
 * a `TASK_ID:` in the prose outside the block can never name a task.
 */
function readHeaders(block: string): { headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = {};
  const lines = stripMarkers(block);

  let last = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const matched = HEADER_LINE.exec(lines[i] ?? "");
    const key = matched?.[1];
    const value = matched?.[2];
    if (!matched || key === undefined || value === undefined) break;
    headers[key.toUpperCase()] = value.trim();
    last = i;
  }

  return { headers, body: lines.slice(last + 1).join("\n").trim() };
}

function envelopeFromBlock(block: TaskBlock, ambiguous: boolean): ParsedRelayTask {
  const { headers, body } = readHeaders(block.block);
  const value = (key: string): string | null => headers[key] || null;

  return {
    taskId: value("TASK_ID"),
    /*
     * Case is kept insensitive on purpose, like every other header: `TYPE: task`
     * names the same envelope as `TYPE: TASK`. Only the literal TASK value is
     * dispatchable, so anything else - including a blank one - is not a task.
     */
    type: value("TYPE")?.toUpperCase() ?? null,
    source: value("SOURCE")?.toUpperCase() ?? null,
    model: value("MODEL"),
    block: block.block,
    body,
    legacy: block.legacy,
    ambiguous,
    raw: block.block,
  };
}

/**
 * The envelope of the first relay block in `text`, or null when there is none.
 *
 * Headers come from inside the block only. Scanning the whole message would
 * let a `TASK_ID:` line in the prose pick the identity of a task.
 */
export function parseRelayEnvelope(text: string): ParsedRelayTask | null {
  const { complete, unterminated } = scanRelayBlocks(text);
  const first = complete[0] ?? unterminated[0];
  if (!first) return null;

  return envelopeFromBlock(first, complete.length > 1);
}

/** Why a message was left alone, phrased for a log line an operator can read. */
export type RelayRejectionReason =
  | "no_block"
  | "missing_type"
  | "empty_type"
  | "unknown_type"
  | "missing_task_id"
  | "empty_task_id";

/**
 * What a ChatGPT message means to the relay.
 *
 * Every branch that is not `task` is deliberately inert: nothing is queued,
 * nothing is typed into WorkBuddy, and the relay's own state is untouched.
 */
export type RelayIntent =
  | { kind: "task"; task: ParsedRelayTask }
  | { kind: "result"; task: ParsedRelayTask }
  | { kind: "ambiguous"; count: number }
  | { kind: "ignored"; reason: RelayRejectionReason };

export function readRelayIntent(text: string): RelayIntent {
  const { complete, unterminated } = scanRelayBlocks(text);

  if (complete.length + unterminated.length === 0) {
    return { kind: "ignored", reason: "no_block" };
  }

  /*
   * More than one closed envelope in a single reply is ambiguous: picking the
   * first would be a guess, and running both would book WorkBuddy twice for a
   * message that only ever meant one thing. Prose is where examples live.
   */
  if (complete.length > 1) {
    return { kind: "ambiguous", count: complete.length };
  }

  const first: TaskBlock | undefined = complete[0] ?? unterminated[0];
  if (!first) return { kind: "ignored", reason: "no_block" };

  const { headers } = readHeaders(first.block);
  const task = envelopeFromBlock(first, false);

  if (!("TYPE" in headers)) return { kind: "ignored", reason: "missing_type" };
  if (!headers.TYPE) return { kind: "ignored", reason: "empty_type" };
  if (task.type === "RESULT") return { kind: "result", task };
  if (task.type !== "TASK") return { kind: "ignored", reason: "unknown_type" };

  /*
   * A task names itself. Generating an id here would hide a malformed envelope
   * behind an otherwise plausible round.
   */
  if (!("TASK_ID" in headers)) return { kind: "ignored", reason: "missing_task_id" };
  if (!headers.TASK_ID) return { kind: "ignored", reason: "empty_task_id" };

  return { kind: "task", task };
}

export function shouldForwardAssistantMessage(
  text: string,
  mode: "tagged" | "all",
): boolean {
  if (mode === "all") return true;
  return readRelayIntent(text).kind === "task";
}

export function ensureTaskId(text: string, fallback: string): string {
  return parseRelayEnvelope(text)?.taskId || fallback;
}

export function wrapWorkBuddyResult(args: {
  taskId: string;
  workbuddyMessageId: string;
  body: string;
}): string {
  return [
    "[ZHIXING_RELAY]",
    "TYPE: RESULT",
    `TASK_ID: ${args.taskId}`,
    "SOURCE: WORKBUDDY",
    `WORKBUDDY_MESSAGE_ID: ${args.workbuddyMessageId}`,
    "",
    args.body.trim(),
  ].join("\n");
}
