/**
 * WorkBuddy quota (model usage limit) detection.
 *
 * The production symptom this exists for:
 *
 *   "当前您在Hy4 preview模型的免费使用量已超过频率限制，可在 04:00 重置"
 *
 * Before this module, that notice arrived as the whole turn body and the relay
 * had no way to tell it apart from any other answer, so the task was reported
 * as a generic failure and the next task picked the same exhausted model.
 *
 * Design, in three parts:
 *
 *   1. `COLLECT_QUOTA_SIGNALS_EXPRESSION` - ONE CDP round trip that reads the
 *      current model label, the quota/credit notice elements and the current
 *      turn text. It opens no second browser connection and changes nothing,
 *      so it can run after every turn without side effects.
 *   2. Node-side parsing below - deliberately pure, so the reset time and the
 *      verdict are unit-testable without a browser.
 *   3. `detectQuota()` - combines the two into the single shape Relay cares
 *      about.
 *
 * Why keyword matching here and not "structural signals only" as in
 * turn-state.ts: completion and cancellation are marked by WorkBuddy with
 * dedicated DOM nodes, but a quota limit is a *sentence* WorkBuddy writes into
 * its answer. Keyword matching is therefore unavoidable - so it is fenced in:
 *
 *   - the answer body is only ever matched against STRONG_MARKERS, i.e. the
 *     fixed phrases WorkBuddy itself prints for this condition, never phrases
 *     an answer could quote about rate limits in general;
 *   - WEAK_MARKERS are only honoured inside WorkBuddy's own notice elements;
 *   - the notice elements are checked first, and only the turn text is
 *     consulted when no notice matched;
 *   - the parser never guesses a model from the text - the model label comes
 *     from the selector trigger, and Relay already knows the routed id.
 */

/**
 * Fixed phrases WorkBuddy renders when a model's free quota is spent.
 * Safe to match against arbitrary answer text.
 */
export const STRONG_MARKERS: readonly string[] = [
  "免费使用量已超过频率限制",
  "使用量已超过频率限制",
  "已超过使用上限",
  "已达到使用上限",
  "quota exceeded",
  "quota_exhausted",
  "usage limit reached",
];

/**
 * Shorter phrases that only prove a quota when they come from one of
 * WorkBuddy's own notice elements, where an answer cannot forge them.
 */
export const WEAK_MARKERS: readonly string[] = [
  "超过频率限制",
  "超出频率限制",
  "频率限制",
];

export type QuotaStatus = "available" | "quota_exhausted";

export type QuotaDetection = {
  status: QuotaStatus;
  /** Model the notice is about, from the selector trigger. Null if unknown. */
  modelLabel: string | null;
  /** Absolute ISO instant the block expires; null when the notice gave none. */
  resetAt: string | null;
  /** The matched notice/turn snippet, kept for the audit trail. */
  reason: string | null;
  /** Where the marker was seen. Null unless status is quota_exhausted. */
  source: "notice" | "turn" | null;
};

export const AVAILABLE_DETECTION: QuotaDetection = Object.freeze({
  status: "available",
  modelLabel: null,
  resetAt: null,
  reason: null,
  source: null,
});

/** Everything the browser side can hand to `detectQuota()`. */
export type QuotaSignals = {
  modelLabel: string | null;
  /** Text of elements whose class contains quota / credit usage. */
  noticeTexts: readonly string[];
  /** The current turn's full text, including any quota notice WorkBuddy wrote. */
  turnText: string;
};

function isMarkerHit(text: string, markers: readonly string[]): boolean {
  return markers.some((marker) => text.indexOf(marker) >= 0);
}

function matchesStrong(text: string): boolean {
  return isMarkerHit(text, STRONG_MARKERS);
}

/** The snippet around a marker, so an operator can read what matched. */
function snippetAround(text: string, limit = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * Absolute instant a quota block ends, for a notice that may or may not
 * carried one.
 *
 * The result is ALWAYS in the future: a block that expired the moment it was
 * written would leave the router free to pick the same model again, and the
 * retry loop would spin on the identical failure.
 */
export function quotaBlockUntil(
  now: Date,
  resetAt: string | null,
  fallbackMs: number,
): Date {
  const parsed = resetAt === null ? null : Date.parse(resetAt);
  const candidate =
    parsed === null || Number.isNaN(parsed) ? null : new Date(parsed);

  if (candidate && candidate.getTime() > now.getTime()) return candidate;

  return new Date(now.getTime() + Math.max(1, fallbackMs));
}

/** `HH:MM` on today, or tomorrow when that instant has already passed. */
function clockToday(now: Date, hours: number, minutes: number): Date | null {
  const rolled = new Date(now.getTime());
  rolled.setHours(hours, minutes, 0, 0);
  if (rolled.getTime() > now.getTime()) return rolled;

  rolled.setDate(rolled.getDate() + 1);
  return rolled;
}

/**
 * Best-effort parse of a reset instant out of free-form Chinese/English text.
 *
 * Accepted forms, strongest first:
 *   - `2026-10-02 04:00` / ISO with a `T`
 *   - relative durations: "23 小时 24 分钟", "30 分钟", "45 秒"
 *   - clock time: "04:00", "23:59" (today, or tomorrow when it already passed)
 *
 * Returns null rather than guessing: a wrong reset time would block a usable
 * model, or unblock one that is still exhausted.
 */
export function parseResetAt(text: string, now: Date): string | null {
  if (typeof text !== "string" || text.trim() === "") return null;

  const absolute =
    /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:[Zz]|[+-]\d{2}:?\d{2})?/.exec(
      text,
    );
  if (absolute) {
    // A trailing Z/offset must survive: without it `new Date` would read the
    // timestamp as local time and shift the instant by the machine's offset.
    const date = new Date(absolute[0].replace(" ", "T"));
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }

  const hoursMatch = /(\d+)\s*(?:小时|时)/.exec(text);
  const minutesMatch = /(\d+)\s*(?:分钟|分)/.exec(text);
  const secondsMatch = /(\d+)\s*秒/.exec(text);

  if (hoursMatch || minutesMatch || secondsMatch) {
    const offsetMs =
      (hoursMatch ? Number(hoursMatch[1]) : 0) * 3_600_000 +
      (minutesMatch ? Number(minutesMatch[1]) : 0) * 60_000 +
      (secondsMatch ? Number(secondsMatch[1]) : 0) * 1000;

    const date = new Date(now.getTime() + offsetMs);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }

  const clock = /(\d{1,2}):(\d{2})/.exec(text);
  if (clock) {
    const hours = Number(clock[1]);
    const minutes = Number(clock[2]);
    if (hours <= 23 && minutes <= 59) {
      const date = clockToday(now, hours, minutes);
      if (date) return date.toISOString();
    }
  }

  return null;
}

/** Picks the reset instant out of the sentence that carries the marker. */
export function detectResetAt(text: string, now: Date): string | null {
  const cue =
    /(?:重置|恢复|解禁|可用)[^。；;\n]{0,80}/.exec(text) ??
    /(?:可在|将于|下次)[^。；;\n]{0,80}/.exec(text);

  if (cue) {
    const parsed = parseResetAt(cue[0], now);
    if (parsed) return parsed;
  }

  return parseResetAt(text, now);
}

/**
 * The verdict Relay acts on.
 *
 * Notice elements win over the turn text: they are WorkBuddy's own status
 * chrome, so they cannot be confused with an answer that merely discusses
 * rate limits. The turn text is only consulted when nothing structural
 * matched, which is exactly the production case - the limit notice is written
 * into the answer.
 */
export function detectQuota(
  signals: QuotaSignals,
  now: Date = new Date(),
): QuotaDetection {
  const modelLabel =
    typeof signals.modelLabel === "string" && signals.modelLabel.trim() !== ""
      ? signals.modelLabel.trim()
      : null;

  for (const notice of signals.noticeTexts ?? []) {
    if (!isMarkerHit(notice, [...STRONG_MARKERS, ...WEAK_MARKERS])) continue;
    return {
      status: "quota_exhausted",
      modelLabel,
      resetAt: detectResetAt(notice, now),
      reason: snippetAround(notice),
      source: "notice",
    };
  }

  const turnText = typeof signals.turnText === "string" ? signals.turnText : "";
  if (matchesStrong(turnText)) {
    return {
      status: "quota_exhausted",
      modelLabel,
      resetAt: detectResetAt(turnText, now),
      reason: snippetAround(turnText),
      source: "turn",
    };
  }

  return { ...AVAILABLE_DETECTION, modelLabel };
}

/**
 * One CDP round trip: model label + quota/credit notice elements + the current
 * turn text.
 *
 * The notice selectors below were chosen from the real page, not invented:
 *   button.cr-model-selector__trigger            current model (label inside
 *                                                span.cr-model-selector__trigger-label)
 *   [class*='quota'], [class*='rate-limit']      WorkBuddy's own limit chrome
 *   .cb-credit-usage-text                        credit-usage line, carries the
 *                                                model name alongside the usage
 * Scope note, measured on the live page: the probe reads the LAST `.cr-agent`
 * only and deliberately never the whole document. Scanning the whole page
 * would match user bubbles too - the pinned conversation contains the quota
 * sentence pasted verbatim into a user message
 * (`div.cr-self-message__content`), which is not a quota at all.
 *
 * Attribute selectors MUST use single quotes inside the double-quoted JS
 * string; using double quotes on both levels makes the expression return
 * undefined without any error.
 */

/**
 * Candidate notice selectors, checked before the answer body.
 *
 * Measured on the live page while no quota was active, none of these were
 * mounted - so the answer-body path (STRONG_MARKERS) is the one that fires in
 * production. They are kept because WorkBuddy's credit chrome
 * (`.cb-credit-usage-text`, `.cr-model-selector__item-credits`) and any quota
 * banner are expected to appear under exactly these shapes.
 */
export const QUOTA_NOTICE_SELECTORS: readonly string[] = [
  "[class*='quota']",
  "[class*='rate-limit']",
  ".cb-credit-usage-text",
  ".cr-model-selector__item-credits",
];
export const COLLECT_QUOTA_SIGNALS_EXPRESSION = `(() => {
  const trigger = document.querySelector("button.cr-model-selector__trigger");
  const labelEl = trigger ? trigger.querySelector(".cr-model-selector__trigger-label") : null;
  const rawLabel = labelEl ? (labelEl.textContent || "") : (trigger ? (trigger.getAttribute("title") || "") : "");
  const modelLabel = rawLabel.trim() || null;

  const turnEls = Array.from(document.querySelectorAll(".cr-agent"));
  let turnText = "";
  if (turnEls.length) {
    turnText = String(turnEls[turnEls.length - 1].innerText || "").trim();
  }

  const selectors = ${JSON.stringify(QUOTA_NOTICE_SELECTORS)};
  const noticeTexts = [];
  for (const selector of selectors) {
    let nodes = [];
    try { nodes = Array.from(document.querySelectorAll(selector)); } catch (e) { nodes = []; }
    for (const node of nodes) {
      const value = String(node.innerText || "").trim();
      if (value) noticeTexts.push(value);
    }
  }

  return JSON.stringify({ found: true, modelLabel: modelLabel, turnText: turnText, noticeTexts: noticeTexts });
})()`;

/** Parses the payload of COLLECT_QUOTA_SIGNALS_EXPRESSION. */
export function parseQuotaSignalsPayload(raw: unknown): QuotaSignals {
  if (typeof raw !== "string") return { modelLabel: null, noticeTexts: [], turnText: "" };

  try {
    const payload = JSON.parse(raw) as Partial<{
      modelLabel: unknown;
      turnText: unknown;
      noticeTexts: unknown;
    }>;

    const notices = Array.isArray(payload.noticeTexts)
      ? payload.noticeTexts.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [];

    return {
      modelLabel:
        typeof payload.modelLabel === "string" && payload.modelLabel.trim() !== ""
          ? payload.modelLabel
          : null,
      noticeTexts: notices,
      turnText:
        typeof payload.turnText === "string" ? payload.turnText : "",
    };
  } catch {
    return { modelLabel: null, noticeTexts: [], turnText: "" };
  }
}
