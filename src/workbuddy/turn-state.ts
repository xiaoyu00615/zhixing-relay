import type { WorkBuddyMessage } from "../types.js";

/*
 * WorkBuddy turn lifecycle lives here as PURE logic.
 *
 * Everything below is deliberately free of DOM APIs:
 * the browser side only *collects* structural signals, and every decision
 * is made by decideTurnState() against those signals.
 *
 * Why this shape exists:
 *
 * The previous implementation derived completion from the whole turn text:
 *
 *   completed = agent.innerText.includes("已完成")
 *   cancelled = agent.innerText.includes("已取消")
 *
 * That is unsafe, because the answer body is arbitrary user content.
 * A single WorkBuddy reply quoted its own detection code, so its markdown
 * contained the literal strings "已完成" and "已取消" inside a
 * <code class="cr-inline-code"> element. The same turn was simultaneously
 * scored completed=true AND cancelled=true, and the wait loop threw
 * "WorkBuddy task cancelled", so the RESULT was never relayed back to GPT.
 *
 * Real DOM evidence (CDP, three agents on one live page):
 *
 *   cancelled turn  -> class=cr-agent cr-agent--with-status
 *                      .cr-agent__completion-status = "已取消 1s"
 *                      .cr-cancelled-indicator      = "用户已取消"
 *                      .conversation-finished-footer present
 *
 *   completed turn  -> class=cr-agent (no status modifiers)
 *                      .cr-collapse--completed      present
 *                      .cr-collapse__title          = "已完成 7m22s"
 *                      .conversation-finished-footer present
 *                      .cr-agent__completion-status  ABSENT
 *
 *   running turn    -> class=cr-agent cr-agent--with-status cr-agent--processing
 *                      [data-message-processing="true"]
 *                      .cr-agent__processing-status  = "已处理 7m12s"
 *                      .conversation-finished-footer ABSENT
 *
 * Note the cancelled turn *also* carries .conversation-finished-footer,
 * which is why cancellation must be evaluated before completion.
 */

/** Label prefixes WorkBuddy itself renders in .cr-agent__completion-status. */
export const CANCELLED_TEXT_PREFIXES = ["已取消"];
export const COMPLETED_TEXT_PREFIXES = ["已完成"];

/** The process requests stability before treating a finished turn as final. */
export const STABLE_REQUIRED = 2;

/**
 * Structural signals harvested from exactly ONE agent container:
 * the current turn. Never contains free-form answer text, so answer content
 * can no longer influence the verdict.
 */
export type WorkBuddyTurnSignals = {
  found: boolean;
  cls: string;
  processingClass: boolean;
  processingAttr: string | null;
  hasProcessingStatus: boolean;
  processingStatusText: string;
  hasCompletionStatus: boolean;
  completionStatusText: string;
  hasCancelledIndicator: boolean;
  hasFinishedFooter: boolean;
  hasCompletedCollapse: boolean;
  markdownCount: number;
};

export type WorkBuddyState = {
  /** Whole visible turn text, including WorkBuddy UI chrome. Debug/stability only. */
  text: string;
  /** Clean answer body, .cr-markdown only. This is what Relay relays to GPT. */
  markdownText: string;
  running: boolean;
  completed: boolean;
  cancelled: boolean;
  debug?: string;
};

export const EMPTY_WORK_BUDDY_STATE: WorkBuddyState = {
  text: "",
  markdownText: "",
  running: true,
  completed: false,
  cancelled: false,
  debug: "no-agent",
};

function startsWithAny(value: string, prefixes: string[]): boolean {
  if (!value) return false;
  return prefixes.some((prefix) => value.indexOf(prefix) === 0);
}

/**
 * Turn away from dangling and to the terminal states of one WorkBuddy turn.
 *
 * Guaranteed invariant: completed and cancelled are never both true.
 * The branches form an ordered if/else chain over mutually exclusive
 * structural markers, so the old "double true" cannot be expressed anymore.
 */
export function decideTurnState(signals: WorkBuddyTurnSignals): {
  running: boolean;
  completed: boolean;
  cancelled: boolean;
} {
  // Nothing mounted yet. Never report a terminal state for a missing turn,
  // otherwise a slow hydration would look like a finished task.
  if (!signals.found) {
    return { running: true, completed: false, cancelled: false };
  }

  // 1. Dedicated processing markers win unconditionally. They are only
  //    mounted while this turn is still working, which is what keeps a long
  //    silent task alive: no text growth required.
  if (
    signals.processingClass ||
    signals.processingAttr === "true" ||
    signals.hasProcessingStatus
  ) {
    return { running: true, completed: false, cancelled: false };
  }

  // 2. Cancellation, checked BEFORE completion: a cancelled turn also mounts
  //    .conversation-finished-footer, so reversing this order would leak it
  //    into the completed branch.
  if (
    signals.hasCancelledIndicator ||
    startsWithAny(signals.completionStatusText, CANCELLED_TEXT_PREFIXES)
  ) {
    return { running: false, completed: false, cancelled: true };
  }

  // 3. Completion, from structured markers only.
  if (
    signals.hasCompletedCollapse ||
    signals.hasFinishedFooter ||
    startsWithAny(signals.completionStatusText, COMPLETED_TEXT_PREFIXES)
  ) {
    return { running: false, completed: true, cancelled: false };
  }

  // 4. Turn mounted but not yet terminal -> keep waiting.
  return { running: true, completed: false, cancelled: false };
}

/**
 * The body Relay hands to GPT: clean markdown when available, whole text as
 * a last resort. This keeps WorkBuddy / "已完成 7m22s" / model tag / time tip
 * out of the RESULT payload.
 */
export function turnBody(state: WorkBuddyState): string {
  return state.markdownText || state.text;
}

export type WaitForTurnOptions = {
  pollIntervalMs: number;
  maxWaitMs: number;
  signal?: AbortSignal;
  /** Injectable so tests never need real waiting. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type WaitForTurnResult = {
  text: string;
  lastState: WorkBuddyState;
};

export type WaitForAssistantReplyResult = {
  text: string;
  lastMessageId: string;
  assistantMessages: WorkBuddyMessage[];
};

/**
 * Poll until the current WorkBuddy turn reaches a stable terminal state.
 *
 * Preserves the intended long-task semantics:
 *   - while running -> keep waiting, no text growth required
 *   - cancelled     -> throw
 *   - completed     -> wait for the body to stabilise, then return it
 */
export async function waitForTurn(
  read: () => Promise<WorkBuddyState>,
  options: WaitForTurnOptions,
): Promise<WaitForTurnResult> {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const startedAt = now();
  const before = await read();
  const baselineText = turnBody(before);

  let previousText = "";
  let stableCount = 0;

  while (now() - startedAt < options.maxWaitMs) {
    if (options.signal?.aborted) {
      throw new Error("WorkBuddy wait aborted");
    }

    const state = await read();

    if (state.cancelled) {
      throw new Error("WorkBuddy task cancelled");
    }

    if (state.running) {
      await sleep(options.pollIntervalMs);
      continue;
    }

    const text = turnBody(state);

    if (state.completed && text && text !== baselineText) {
      if (text === previousText) {
        stableCount += 1;
      } else {
        previousText = text;
        stableCount = 0;
      }

      if (stableCount >= STABLE_REQUIRED) {
        return { text, lastState: state };
      }
    }

    await sleep(options.pollIntervalMs);
  }

  throw new Error(
    `Timed out waiting WorkBuddy after ${options.maxWaitMs}ms`,
  );
}
