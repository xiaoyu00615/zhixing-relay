/**
 * The WorkBuddy delivery acknowledgements, as PURE logic.
 *
 * Relay Core is not allowed to know selectors, and it is not allowed to guess.
 * This module is the middle ground: the browser collects the facts, the CDP
 * adapter hands them over as plain values, and every verdict below is made
 * from those values with no DOM and no clock of its own.
 *
 * The four confirmations asked for by the protocol are separate on purpose:
 *
 *   INPUT_CONFIRMED  the composer really holds this exact payload
 *   SEND_CONFIRMED   clicking produced a NEW turn carrying this task id
 *   RUNNING_CONFIRMED  WorkBuddy is processing, not merely showing a message
 *   RESULT_RECEIVED  a fresh answer belonging to THIS dispatch
 *
 * "The click succeeded" is never SEND_CONFIRMED, and "a message is on screen"
 * is never RUNNING_CONFIRMED. Both look identical from a log and are completely
 * different facts.
 */

/**
 * Who authored a rendered node.
 *
 * `assistant` is WorkBuddy's own answer, its processing card, its status
 * chrome and anything else on the assistant side. `unknown` is a container
 * the page has not identified either way.
 *
 * Only `user` can prove that the relay's own text went out: the assistant
 * side is always on screen and always moving, and treating it as a new
 * outbound turn is what made the production relay answer
 * `new_turn_wrong_task` for a send that had in fact succeeded.
 */
export type TurnRole = "user" | "assistant" | "unknown";

/** One rendered turn/message container on the page. */
export type ObservedTurn = {
  /** Stable enough to tell "the same turn" from "a new one" between polls. */
  signature: string;
  /** Who wrote it. A send is only ever proven by a `user` turn. */
  role: TurnRole;
  /** Whether this turn carries the task's identifier in its text. */
  containsTaskId: boolean;
};

/** Everything the adapter knows about the page at one instant. */
export type TurnSnapshot = {
  /** What the composer still holds. Empty means it was cleared by a send. */
  inputText: string;
  /**
   * The outbound turns, and only those.
   *
   * Everything that is not a user-authored turn is filtered out here, in the
   * page, so the rest of the module can never have to ask "is this node a
   * status row?" - the answer is already `false` by the time it gets here.
   */
  turns: ObservedTurn[];
};

export type InputConfirmation = {
  ok: boolean;
  reason: "confirmed" | "empty_composer" | "readback_mismatch" | "no_composer";
  /** Fingerprint of the text the relay meant to send. */
  expectedFingerprint: string;
  /** Fingerprint of what came back out of the composer. */
  observedFingerprint: string;
  expectedLength: number;
  observedLength: number;
  /** Exact match after normalising line endings and trailing spaces. */
  exactMatch: boolean;
  /** Match after whitespace is collapsed, for a renderer that reflows text. */
  normalizedMatch: boolean;
};

export type SendConfirmation = {
  ok: boolean;
  reason: "confirmed" | "no_new_turn" | "new_turn_wrong_task" | "input_not_confirmed" | "timeout";
  /** Identity of the new turn, when one was observed. */
  observedMessageId: string | null;
  /** How many outbound turns the page had before and after the click. */
  beforeTurnCount: number;
  afterTurnCount: number;
  /** Non-outbound nodes seen after the click, as evidence of what was ignored. */
  ignoredRoles: string[];
  detail: string;
};

/**
 * Normalises the differences a contenteditable composer introduces.
 *
 * Slate inserts its own paragraph breaks and trailing spaces, so a byte
 * comparison against the envelope would fail for no real reason. The two
 * normalisations below are the ones WorkBuddy actually produces; anything
 * else would start hiding a genuine difference.
 */
export function normalizeComposerText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

/** Collapses every run of whitespace so a reflow cannot look like new text. */
export function collapseWhitespace(text: string): string {
  return normalizeComposerText(text).replace(/\s+/g, " ");
}

function fingerprintOf(text: string): string {
  // A short, stable digest: enough to compare, never used as an identity.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

/**
 * Compares what came back out of the composer with what was meant to go in.
 *
 * `exactMatch` is the strict verdict, `normalizedMatch` is the forgiving one;
 * either is enough to confirm the input, and `ok` is the only field a caller
 * should branch on.
 */
export function confirmInputReadback(input: {
  expected: string;
  observed: string;
  composerFound?: boolean;
}): InputConfirmation {
  const expected = input.expected ?? "";
  const observed = input.observed ?? "";
  const exactMatch = normalizeComposerText(observed) === normalizeComposerText(expected);

  const base = {
    expectedFingerprint: fingerprintOf(expected),
    observedFingerprint: fingerprintOf(observed),
    expectedLength: normalizeComposerText(expected).length,
    observedLength: normalizeComposerText(observed).length,
    exactMatch,
    normalizedMatch: exactMatch || collapseWhitespace(observed) === collapseWhitespace(expected),
  };

  if (input.composerFound === false) {
    return { ...base, ok: false, reason: "no_composer" };
  }

  if (observed.trim() === "") {
    return { ...base, ok: false, reason: "empty_composer" };
  }

  if (!base.normalizedMatch) {
    return { ...base, ok: false, reason: "readback_mismatch" };
  }

  return { ...base, ok: true, reason: "confirmed" };
}

/**
 * The prefix of the outbound text the page has to show for a node to be
 * identified as the relay's own turn.
 *
 * The task id alone is too loose for a page that streams answers: a reply can
 * quote the id of the task it answers. The first characters of the payload -
 * which the relay typed into the composer a moment ago, and which the composer
 * read back - are the send's own identity.
 */
export const OUTBOUND_PREFIX_LENGTH = 80;

export function outboundPayloadPrefix(text: string, length = OUTBOUND_PREFIX_LENGTH): string {
  return collapseWhitespace(text).slice(0, length);
}

/**
 * Was the click enough? No.
 *
 * A *user-authored* turn that was not there before the click and that carries
 * this task's identifier is the only proof that WorkBuddy accepted the
 * payload. WorkBuddy's own processing card, answer, status row or system line
 * may appear right after the click and must simply be waited out: seeing one
 * is not a send, and calling it one is the production bug this rule exists to
 * keep out.
 *
 * A new user turn that carries a different task means the page moved on on its
 * own, and no new user turn at all means the send is in an unknown state -
 * which is a reconciliation case, never an implicit success.
 */
export function confirmSend(input: {
  before: TurnSnapshot;
  after: TurnSnapshot;
  expectedTaskId: string;
}): SendConfirmation {
  const before = input.before.turns ?? [];
  const after = input.after.turns ?? [];
  const beforeSignatures = new Set(before.map((turn) => turn.signature));

  const fresh = after.filter((turn) => !beforeSignatures.has(turn.signature));
  const freshUser = fresh.find((turn) => turn.role === "user");
  /*
   * Kept as evidence, never as a verdict: an operator has to be able to see
   * that the page really did move after the click, and which nodes the relay
   * decided were not the relay's message going out.
   */
  const ignoredRoles = fresh.filter((turn) => turn.role !== "user").map((turn) => turn.role);

  if (freshUser === undefined) {
    return {
      ok: false,
      reason: "no_new_turn",
      observedMessageId: null,
      beforeTurnCount: before.length,
      afterTurnCount: after.length,
      ignoredRoles,
      detail:
        `the page rendered ${after.length} outbound turn(s) after the click and none of them is new, ` +
        (ignoredRoles.length > 0
          ? `${ignoredRoles.length} non-outbound node(s) were seen and ignored (${ignoredRoles.join(", ")}), ` +
            `so whether the task was sent is unknown`
          : `so whether the task was sent is unknown`),
    };
  }

  if (!freshUser.containsTaskId) {
    return {
      ok: false,
      reason: "new_turn_wrong_task",
      observedMessageId: freshUser.signature,
      beforeTurnCount: before.length,
      afterTurnCount: after.length,
      ignoredRoles,
      detail:
        `a new outbound turn appeared but it does not carry task ${input.expectedTaskId}, ` +
        `so it is not this dispatch going out`,
    };
  }

  return {
    ok: true,
    reason: "confirmed",
    observedMessageId: freshUser.signature,
    beforeTurnCount: before.length,
    afterTurnCount: after.length,
    ignoredRoles,
    detail: `a new outbound turn carrying task ${input.expectedTaskId} appeared after the click`,
  };
}

/** Polls the page until a new turn for this task shows up, or the window closes. */
export async function waitForSendConfirmation(
  read: () => Promise<TurnSnapshot>,
  options: {
    before: TurnSnapshot;
    expectedTaskId: string;
    pollIntervalMs: number;
    timeoutMs: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<SendConfirmation> {
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = now();

  let latest = options.before;

  while (now() - startedAt < Math.max(0, options.timeoutMs)) {
    latest = await read();
    const confirmed = confirmSend({
      before: options.before,
      after: latest,
      expectedTaskId: options.expectedTaskId,
    });

    // A wrong-task new turn will never become the right one by waiting.
    if (confirmed.reason !== "no_new_turn") return confirmed;

    await sleep(options.pollIntervalMs);
  }

  return confirmSend({
    before: options.before,
    after: latest,
    expectedTaskId: options.expectedTaskId,
  });
}

export type RunningOutcome = "running" | "result_ready" | "cancelled" | "timeout";

export type RunningConfirmation = {
  outcome: RunningOutcome;
  /** True only when WorkBuddy was seen processing this turn. */
  ok: boolean;
  reason: string;
  /** What the adapter last saw, kept as evidence rather than a verdict. */
  evidence: { running: boolean; completed: boolean; cancelled: boolean };
};

/** The structural signals the turn reader already produces. */
export type RunningSignals = {
  running: boolean;
  completed: boolean;
  cancelled: boolean;
};

function outcomeFor(signals: RunningSignals): RunningOutcome {
  // Processing wins: it is only mounted while the turn is really working.
  if (signals.running) return "running";
  if (signals.cancelled) return "cancelled";
  if (signals.completed) return "result_ready";
  // Turn mounted but neither processing nor terminal yet.
  return "timeout";
}

/**
 * Watches a bounded window for real execution.
 *
 * A result that arrives without ever being observed processing is allowed:
 * WorkBuddy can finish inside one poll. Neither processing nor a terminal
 * state is a stall - that is the one case that must be handed to
 * reconciliation instead of being retried.
 */
export async function waitForRunning(
  read: () => Promise<RunningSignals>,
  options: {
    pollIntervalMs: number;
    timeoutMs: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<RunningConfirmation> {
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = now();

  let latest: RunningSignals = { running: false, completed: false, cancelled: false };

  while (now() - startedAt < options.timeoutMs) {
    latest = await read();
    const outcome = outcomeFor(latest);

    if (outcome !== "timeout") {
      return {
        outcome,
        ok: outcome === "running",
        reason: `workbuddy reports ${outcome} after ${now() - startedAt}ms`,
        evidence: latest,
      };
    }

    await sleep(options.pollIntervalMs);
  }

  latest = await read();
  const outcome = outcomeFor(latest);

  return {
    outcome,
    ok: outcome === "running",
    reason:
      outcome === "timeout"
        ? `neither processing nor a result appeared within ${options.timeoutMs}ms`
        : `workbuddy reports ${outcome}`,
    evidence: latest,
  };
}

/** Result of waiting for the answer itself. */
export type TurnWaitOutcome =
  | { kind: "result"; text: string }
  | { kind: "cancelled"; detail: string }
  | { kind: "timeout"; detail: string }
  | { kind: "error"; detail: string };

/**
 * Sorts a failure thrown by the turn wait into the three things it can be.
 *
 * The wait itself already knows the difference; this only keeps the relay from
 * having to pattern-match on error text in a second place.
 */
export function classifyTurnFailure(error: unknown): Exclude<TurnWaitOutcome["kind"], "result"> {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("cancelled")) return "cancelled";
  if (message.includes("Timed out") || message.includes("timed out")) return "timeout";
  return "error";
}
