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
