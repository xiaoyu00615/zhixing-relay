import type { TurnRole } from "./turn-ack.js";

/**
 * Which side of the conversation a rendered node belongs to.
 *
 * This is the whole fix for the production `new_turn_wrong_task` false
 * failure, and it lives next to the page adapter rather than inside the CDP
 * string on purpose: the browser collects the four facts below, and this one
 * function turns them into a role. It is a `function` declaration, not an
 * arrow assigned to a const, so `toString()` gives back exactly the text that
 * is shipped inside the CDP expression - the code under test is the code that
 * runs in the page.
 */
export type TurnNodeFacts = {
  /** The container holds user-authored content (`.cr-self-message__content`). */
  hasUserContent: boolean;
  /** The container carries assistant-side chrome: status rows, footers, collapse. */
  hasAssistantChrome: boolean;
  /** The container only shows WorkBuddy's own status labels ("已处理", "思考中", ...). */
  hasStatusLabel: boolean;
  /** The container renders the outbound payload the relay just typed. */
  carriesPayload: boolean;
};

export function classifyTurnNode(facts: TurnNodeFacts): TurnRole {
  if (facts.hasUserContent) return "user";
  if (facts.hasAssistantChrome) return "assistant";
  if (facts.hasStatusLabel) return "assistant";
  if (facts.carriesPayload) return "user";
  return "unknown";
}

/** The classifier, verbatim, for embedding in the CDP expression. */
export const CLASSIFY_TURN_NODE_SOURCE = classifyTurnNode.toString();

/**
 * The text of one turn, reduced to what a reader can compare.
 *
 * Contenteditable corners and virtualised rows append invisible characters, so
 * the same message can read as a different string from one poll to the next.
 * Zero-width characters go, because they are not part of the message; the rest
 * collapses, so a reflow is not a rewrite.
 *
 * The zero-width class is written out inline rather than pulled from a
 * constant: `toString()` is how this function reaches the browser, and a
 * closure over a module-level regex would not survive that trip.
 */
export function normalizeTurnText(text: string): string {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[​-‍﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A digest of a turn's own text.
 *
 * The whole text, not its head: two different messages that happen to open
 * with the same characters must not become one node identity. That is the
 * difference between "the message went out" and "something else did".
 */
export function turnTextFingerprint(text: string): string {
  const normalized = normalizeTurnText(text);
  let hash = 0x811c9dc5;

  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash.toString(16);
}

/**
 * Marks a signature as a user-authored turn, so it cannot collide with a
 * card's.
 *
 * The literal is written into `turnTextSignature` rather than referenced from
 * here, because `toString()` is how that function reaches the browser and a
 * module-level constant would be left behind.
 */
export const TURN_TEXT_SIGNATURE_PREFIX = "u";

/**
 * The identity of one rendered turn, from its own text only.
 *
 * Used for user-authored rows, where "the same turn" has to mean "the same
 * message" even though WorkBuddy keeps rewriting the assistant side of the
 * round around it. The assistant-side rows keep their own, chrome-driven
 * signature in the page expression; the prefix keeps the two families apart.
 */
export function turnTextSignature(text: string): string {
  return `u${turnTextFingerprint(text)}:${normalizeTurnText(text).length}`;
}

/** Whether a turn's own text carries the task, checked against the message only. */
export function turnTextContainsTaskId(text: string, taskId: string): boolean {
  return normalizeTurnText(text).indexOf(taskId) !== -1;
}

/**
 * The four helpers, verbatim, for embedding in the CDP expression.
 *
 * Shipping the functions themselves is what keeps the browser and the unit
 * tests on one rule: `TURN_TEXT_SIGNATURE_PREFIX` is asserted against by the
 * regression, so a change here cannot quietly become a change only in the page.
 */
export const TURN_TEXT_FACTS_SOURCE = [
  normalizeTurnText.toString(),
  turnTextFingerprint.toString(),
  turnTextSignature.toString(),
  turnTextContainsTaskId.toString(),
].join("\n");
