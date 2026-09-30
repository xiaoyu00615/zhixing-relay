import { normalizeText } from "./utils.js";

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
  raw: string;
};

function headerValue(text: string, key: string): string | null {
  const pattern = new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, "im");
  return pattern.exec(text)?.[1]?.trim() || null;
}

export function parseRelayEnvelope(text: string): ParsedRelayTask | null {
  const raw = normalizeText(text);
  if (!/^\s*\[ZHIXING_RELAY\]\s*$/im.test(raw)) return null;

  return {
    taskId: headerValue(raw, "TASK_ID"),
    type: headerValue(raw, "TYPE")?.toUpperCase() || null,
    source: headerValue(raw, "SOURCE")?.toUpperCase() || null,
    model: headerValue(raw, "MODEL"),
    raw,
  };
}

export function shouldForwardAssistantMessage(
  text: string,
  mode: "tagged" | "all",
): boolean {
  if (mode === "all") return true;
  const parsed = parseRelayEnvelope(text);
  return parsed?.type === "TASK";
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
