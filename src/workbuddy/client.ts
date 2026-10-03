import { CDPClient } from "./cdp.js";
import {
  COLLECT_QUOTA_SIGNALS_EXPRESSION,
  detectQuota,
  parseQuotaSignalsPayload,
  type QuotaDetection,
  type QuotaSignals,
} from "./quota.js";
import {
  decideTurnState,
  type WorkBuddyState,
  type WorkBuddyTurnSignals,
} from "./turn-state.js";
import { type ObservedTurn, type TurnRole, type TurnSnapshot } from "./turn-ack.js";
import { CLASSIFY_TURN_NODE_SOURCE, TURN_TEXT_FACTS_SOURCE } from "./turn-roles.js";

export type { WorkBuddyState } from "./turn-state.js";
export type { QuotaDetection, QuotaSignals } from "./quota.js";

/*
 * Harvests STRUCTURAL signals for the current WorkBuddy turn only.
 *
 * This expression intentionally makes no completion / cancellation decision
 * and performs no free-form keyword search over the answer body. All verdicts
 * are produced by decideTurnState() in Node, which is unit-testable.
 *
 * See src/workbuddy/turn-state.ts for the live DOM evidence behind every
 * selector below. Selectors that matter:
 *
 *   .cr-agent                      one WorkBuddy turn
 *   .cr-agent--processing          only while the turn is still working
 *   [data-message-processing]      ditto
 *   .cr-agent__processing-status   live "已处理 3m8s" label
 *   .cr-agent__completion-status   terminal label ("已取消 1s" / "已完成 Xs")
 *   .cr-cancelled-indicator        dedicated cancellation banner
 *   .cr-collapse--completed        completed step summary section
 *   .conversation-finished-footer  footer mounted once a turn is terminal
 *   .cr-markdown                   the answer body itself
 */
const COLLECT_TURN_SIGNALS_EXPRESSION = [
  "(() => {",
  "  const els = Array.from(document.querySelectorAll('.cr-agent'));",
  "  if (!els.length) return JSON.stringify({ found: false });",
  "  const collect = (el) => {",
  "    const completion = el.querySelector('.cr-agent__completion-status');",
  "    const processing = el.querySelector('.cr-agent__processing-status');",
  "    const cancelledIndicator = el.querySelector('.cr-cancelled-indicator');",
  "    const rect = el.getBoundingClientRect();",
  "    return {",
  "      cls: String(el.className || ''),",
  "      processingClass: el.classList.contains('cr-agent--processing'),",
  "      processingAttr: el.getAttribute('data-message-processing'),",
  "      hasProcessingStatus: !!processing,",
  "      processingStatusText: processing ? String(processing.innerText || '').trim() : '',",
  "      hasCompletionStatus: !!completion,",
  "      completionStatusText: completion ? String(completion.innerText || '').trim() : '',",
  "      hasCancelledIndicator: !!cancelledIndicator,",
  "      hasFinishedFooter: !!el.querySelector('.conversation-finished-footer'),",
  "      hasCompletedCollapse: !!el.querySelector('.cr-collapse--completed'),",
  "      markdownCount: el.querySelectorAll('.cr-markdown').length,",
  "      bottom: rect.bottom,",
  "      height: rect.height",
  "    };",
  "  };",
  "  const isProcessing = (s) => s.processingClass || s.processingAttr === 'true' || s.hasProcessingStatus;",
  "  const items = els.map((el) => ({ el: el, s: collect(el) }));",
  "  let target = null;",
  "  let signals = null;",
  "  const processingItems = items.filter((it) => isProcessing(it.s));",
  "  if (processingItems.length) {",
  "    const picked = processingItems[processingItems.length - 1];",
  "    target = picked.el;",
  "    signals = picked.s;",
  "  } else {",
  "    const sorted = items.slice().sort((x, y) => y.s.bottom - x.s.bottom);",
  "    target = sorted[0].el;",
  "    signals = sorted[0].s;",
  "  }",
  "  const bodies = Array.from(target.querySelectorAll('.cr-markdown'))",
  "    .filter((m) => !m.closest('.cr-collapse'))",
  "    .map((m) => String(m.innerText || '').trim())",
  "    .filter(Boolean);",
  "  return JSON.stringify({",
  "    found: true,",
  "    cls: signals.cls,",
  "    processingClass: signals.processingClass,",
  "    processingAttr: signals.processingAttr,",
  "    hasProcessingStatus: signals.hasProcessingStatus,",
  "    processingStatusText: signals.processingStatusText,",
  "    hasCompletionStatus: signals.hasCompletionStatus,",
  "    completionStatusText: signals.completionStatusText,",
  "    hasCancelledIndicator: signals.hasCancelledIndicator,",
  "    hasFinishedFooter: signals.hasFinishedFooter,",
  "    hasCompletedCollapse: signals.hasCompletedCollapse,",
  "    markdownCount: signals.markdownCount,",
  "    fullText: String(target.innerText || '').trim(),",
  "    markdownText: bodies.join('\\n\\n')",
  "  });",
  "})()",
].join("\n");

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/*
 * What the page currently contains, for the delivery acknowledgements.
 *
 * The relay only ever sees plain values out of this: turn signatures, whether
 * a turn carries the task's id, who authored it, and what the composer holds.
 * Deciding what any of it *means* stays in turn-ack.ts, which is unit-testable.
 *
 * Selectors that matter:
 *
 *   [contenteditable="true"][role="textbox"]  the composer
 *   .cr-agent                                 one rendered assistant round
 *   .cr-self-message                          one user-authored message
 *
 * THE USER ROW, NOT THE ROUND, IS THE SEND PROOF.
 *
 * Measured on the live page (CDP, three rows + the opened composer): a
 * `.cr-agent` is WorkBuddy's side only - its header says "WorkBuddy", its body
 * is the answer, and the status chrome (`cr-agent__processing-status`,
 * `conversation-finished-footer`, `cr-collapse--completed`) rides along with
 * it. The text the relay typed lives in a `.cr-self-message` sibling, under
 * `.cr-frame--right`, and the document virtualiser can render that bubble more
 * than once with a different `data-user-message-id` each time.
 *
 * So collecting only `.cr-agent` made a fresh user turn invisible, and every
 * send was scored `no_new_turn` even when the message was on screen, executed
 * and answered. Both node families are collected now, in page order, and each
 * family carries the identity of the text that actually belongs to it.
 *
 * A turn signature for a user row is the fingerprint of the *message*, never
 * the text of the round around it: the assistant side keeps growing and
 * changing state, and a signature that moves with it describes nothing stable.
 *
 * THE SET, NOT JUST THE PREDICATE, IS THE FIX.
 *
 * The previous snapshot collected every `.cr-agent` and let the verdict find
 * the new one by task id. On the real page the node that appears first after
 * the click is WorkBuddy's own processing/status card - a `.cr-agent` that
 * carries no task id at all - so the first verdict of the poll was
 * `new_turn_wrong_task` for a send that had in fact gone out, and the task
 * went to reconciliation with a false failure.
 *
 * So every container is classified here, and `turns` carries all of them -
 * classified, not filtered. The page reports what it saw; which of those
 * nodes may vote for a send is the verdict layer's decision alone, and a node
 * the page discarded would be a node the relay can never explain having
 * ignored. The classification uses the measured facts the relay already
 * trusts, in this order:
 *
 *   1. user-authored content (`.cr-self-message__content`, measured on the
 *      live page in src/workbuddy/quota.ts)                        -> user
 *   2. assistant-side chrome: processing status, completion status,
 *      cancelled indicator, finished footer, completed collapse, or the
 *      processing class                                             -> assistant
 *   3. the labels WorkBuddy renders for its own status card
 *      ("已处理" / "思考中" / ...)                                    -> assistant
 *   4. the outbound payload itself, collapsed                       -> user
 *
 * Only rule 4 can still go wrong by calling an answer a send, and it needs the
 * relay's own payload text to appear inside the node - an answer that starts
 * with 80 characters of the message it is answering could only do that by
 * quoting it.
 */
/** Exported so the expression itself, not a copy of it, is under test. */
export const TURN_SNAPSHOT_EXPRESSION = (request: {
  taskId: string;
  payloadPrefix: string;
}) => `
  (() => {
    ${CLASSIFY_TURN_NODE_SOURCE}
    ${TURN_TEXT_FACTS_SOURCE}
    const input = document.querySelector('[contenteditable="true"][role="textbox"]');
    const taskId = ${JSON.stringify(request.taskId)};
    const payloadPrefix = ${JSON.stringify(request.payloadPrefix)};

    // One row per rendered turn. The selector walks the document, so the rows
    // come back in page order without sorting.
    const nodes = Array.from(
      document.querySelectorAll('.cr-agent, .cr-self-message')
    ).filter(function (el) {
      // A user bubble rendered inside an assistant round is that round's own
      // echo of the prompt, not a turn of its own going out.
      return !el.matches('.cr-agent .cr-self-message');
    });

    const seen = {};
    const observed = [];

    for (var n = 0; n < nodes.length; n++) {
      const el = nodes[n];
      const isUserRow = el.classList.contains('cr-self-message');
      // The user row's own message, never the round around it.
      const messageEl = el.querySelector('.cr-self-message__content') ||
        el.querySelector('.cr-user-content');
      const messageText = isUserRow && messageEl
        ? String(messageEl.innerText || '')
        : '';
      const roundText = String(el.innerText || '');
      const collapsed = roundText.replace(/\\s+/g, ' ').trim();

      // A user row identifies as its message; a round identifies as the text
      // it renders, because that is what its chrome travels with.
      const signature = isUserRow
        ? turnTextSignature(messageText)
        : roundText.length + '|' + roundText.slice(0, 64);
      const containsTaskId = isUserRow
        ? turnTextContainsTaskId(messageText, taskId)
        : turnTextContainsTaskId(roundText, taskId);

      // The virtualiser renders the same message more than once. One row per
      // message: an identity that names the same message twice is not new.
      if (seen[signature]) continue;
      seen[signature] = true;

      const userContent = el.querySelector('.cr-self-message__content');
      const processingStatus = el.querySelector('.cr-agent__processing-status');
      const completionStatus = el.querySelector('.cr-agent__completion-status');
      const cancelledIndicator = el.querySelector('.cr-cancelled-indicator');
      const finishedFooter = el.querySelector('.conversation-finished-footer');
      const completedCollapse = el.querySelector('.cr-collapse--completed');
      const processingClass = el.classList.contains('cr-agent--processing');

      // The page only collects; the verdict is classifyTurnNode's, and it is
      // the same function the unit tests call.
      const role = classifyTurnNode({
        hasUserContent: !!userContent,
        hasAssistantChrome: !!(
          processingStatus ||
          completionStatus ||
          cancelledIndicator ||
          finishedFooter ||
          completedCollapse ||
          processingClass
        ),
        hasStatusLabel: /已处理|思考中|正在思考|已取消|已完成/.test(collapsed),
        carriesPayload: collapsed.indexOf(payloadPrefix) !== -1,
      });

      observed.push({
        signature: signature,
        role: role,
        // Identity, kept on every node: whichever of them the verdict layer
        // listens to still has to prove which task it carries.
        containsTaskId: containsTaskId,
        index: n,
      });
    }

    return JSON.stringify({
      inputText: String(input ? (input.innerText || '') : ''),
      turnCount: observed.length,
      // Every classified node, in page order. Nothing is deleted here: a
      // status card the page had dropped would be a status card the relay
      // could not report having waited out.
      turns: observed,
    });
  })()`;

const TURN_ROLES: readonly TurnRole[] = ["user", "assistant", "unknown"];

/**
 * Turns the page's answer into the snapshot the verdict layer judges.
 *
 * The page is a browser and the payload crosses a debugger connection, so
 * nothing here trusts its shape. A node with no signature cannot be told
 * apart between two polls and is dropped; a node whose role is not one the
 * classifier emits becomes `unknown`, because an unclassified node must
 * never be able to vote by accident.
 */
export function parseTurnSnapshot(raw: unknown): TurnSnapshot {
  if (typeof raw !== "string") return emptyTurnSnapshot();

  try {
    const payload = JSON.parse(raw) as {
      inputText?: unknown;
      turnCount?: unknown;
      turns?: unknown;
    };

    const turns = Array.isArray(payload.turns) ? payload.turns : [];
    const parsed: ObservedTurn[] = [];

    for (const turn of turns) {
      if (typeof turn !== "object" || turn === null) continue;

      const candidate = turn as {
        signature?: unknown;
        role?: unknown;
        containsTaskId?: unknown;
      };

      if (typeof candidate.signature !== "string") continue;

      parsed.push({
        signature: candidate.signature,
        role: TURN_ROLES.includes(candidate.role as TurnRole) ? (candidate.role as TurnRole) : "unknown",
        containsTaskId: candidate.containsTaskId === true,
      });
    }

    return {
      inputText: typeof payload.inputText === "string" ? payload.inputText : "",
      turns: parsed,
    };
  } catch {
    return emptyTurnSnapshot();
  }
}

/** A snapshot with nothing rendered yet, so callers never see a missing page. */
export function emptyTurnSnapshot(): TurnSnapshot {
  return { inputText: "", turns: [] };
}



export class WorkBuddyClient {


  private readonly cdp: CDPClient;



  constructor(
    websocketUrl: string
  ){

    this.cdp =
      new CDPClient(
        websocketUrl
      );

  }




  /**
   * Pass-through to the shared CDP connection.
   *
   * Sibling adapters (the model selector) need the same page, and opening a
   * second debugger session would be wasteful and could race. Nothing here
   * changes how the existing send / read paths speak to their own endpoints.
   */
  evaluate(
    expression: string
  ): Promise<unknown> {

    return this.cdp.evaluate(
      expression
    );

  }





  /**
   * Puts the task text into the composer.
   *
   * This is deliberately only the typing. Confirming it is a separate call,
   * because the relay has to be able to refuse to click send when what came
   * back out of the composer is not what went in.
   */
  async typeIntoComposer(text: string): Promise<{ ok: boolean; detail: string }> {

    const inputResult =
      await this.cdp.evaluate(`

      (()=>{

        const input =
          document.querySelector(
            '[contenteditable="true"][role="textbox"]'
          );


        if(!input){
          return "INPUT_NOT_FOUND";
        }

        input.focus();

        const value =
          ${JSON.stringify(text)};

        input.dispatchEvent(
          new KeyboardEvent("keydown", { key:"", bubbles:true })
        );

        input.dispatchEvent(
          new InputEvent("beforeinput", {
            bubbles:true,
            inputType:"insertText",
            data:value
          })
        );

        input.dispatchEvent(
          new InputEvent("input", {
            bubbles:true,
            inputType:"insertText",
            data:value
          })
        );

        input.dispatchEvent(
          new KeyboardEvent("keyup", { key:"", bubbles:true })
        );

        return "INPUT_OK";


      })()

      `);

    const ok = inputResult === "INPUT_OK";

    return {
      ok,
      detail: ok ? "input accepted" : String(inputResult),
    };
  }

  /** Reads what the composer currently holds, so it can be compared with intent. */
  async readComposerText(): Promise<string> {

    const raw =
      await this.cdp.evaluate(`

      (()=>{
        const input =
          document.querySelector(
            '[contenteditable="true"][role="textbox"]'
          );
        return String(input ? (input.innerText || '') : '');
      })()

      `);

    return typeof raw === "string" ? raw : "";
  }

  /**
   * What the page renders right now: every classified turn, and what each
   * carries.
   *
   * Both facts it compares against come from the caller - the task id and the
   * outbound payload - because the page cannot say which node is the relay's
   * message; the relay already proved that one when it read the composer back.
   *
   * Nothing is filtered by role here. The page classifies, this returns what
   * the page said, and `confirmSend` decides - which is also what makes the
   * ignored nodes visible in the answer instead of gone before anyone could
   * look at them.
   */
  async readTurnSnapshot(request: {
    taskId: string;
    payloadPrefix: string;
  }): Promise<TurnSnapshot> {

    const raw =
      await this.cdp.evaluate(
        TURN_SNAPSHOT_EXPRESSION({
          taskId: request.taskId,
          payloadPrefix: request.payloadPrefix,
        }),
      );

    return parseTurnSnapshot(raw);
  }

  /**
   * Clicks the send button.
   *
   * `CLICK_OK` is the weakest fact available here and the caller is expected to
   * treat it as such: a click that lands does not prove the message ever became
   * a turn, which is why it is never returned as a send confirmation.
   */
  async clickSendButton(): Promise<{ clickOk: boolean; detail: string }> {

    const sendResult =
      await this.cdp.evaluate(`

      (()=>{

        const button =
          document.querySelector(
            "button.cr-send-button"
          );


        if(!button){
          return "BUTTON_NOT_FOUND";
        }

        button.dispatchEvent(
          new MouseEvent("mousedown", { bubbles:true })
        );
        button.dispatchEvent(
          new MouseEvent("mouseup", { bubbles:true })
        );
        button.dispatchEvent(
          new MouseEvent("click", { bubbles:true })
        );
        button.click();

        return "CLICK_OK";


      })()


      `);

    const clickOk = sendResult === "CLICK_OK";

    return { clickOk, detail: clickOk ? "send clicked" : String(sendResult) };
  }

  /**
   * Types and clicks in one go.
   *
   * Kept for the standalone worker, which does not need acknowledgements. The
   * relay uses typeIntoComposer / clickSendButton so it can confirm the input
   * before the click and confirm the turn after it.
   */
  async sendMessage(text: string): Promise<void> {

    const typed = await this.typeIntoComposer(text);
    if (!typed.ok) throw new Error(typed.detail);

    const clicked = await this.clickSendButton();
    if (!clicked.clickOk) throw new Error(clicked.detail);
  }

  async readMessage():Promise<string>{


    return await this.cdp.evaluate(`


    (()=>{


      const nodes =
        document.querySelectorAll(
          ".cr-markdown"
        );


      if(!nodes.length){

        return "NO_MESSAGE";

      }



      const last =
        nodes[
          nodes.length - 1
        ];



      return (
        last.innerText || ""
      ).trim()
      ||
      "NO_MESSAGE";



    })()


    `);


  }









  async readState(): Promise<WorkBuddyState> {
    const raw = await this.cdp.evaluate(COLLECT_TURN_SIGNALS_EXPRESSION);

    if (typeof raw !== "string") {
      throw new Error("Invalid WorkBuddy state response");
    }

    const payload = JSON.parse(raw) as Partial<
      WorkBuddyTurnSignals & { fullText?: unknown; markdownText?: unknown }
    >;

    const signals: WorkBuddyTurnSignals = {
      found: payload.found === true,
      cls: asString(payload.cls),
      processingClass: payload.processingClass === true,
      processingAttr:
        typeof payload.processingAttr === "string" ? payload.processingAttr : null,
      hasProcessingStatus: payload.hasProcessingStatus === true,
      processingStatusText: asString(payload.processingStatusText),
      hasCompletionStatus: payload.hasCompletionStatus === true,
      completionStatusText: asString(payload.completionStatusText),
      hasCancelledIndicator: payload.hasCancelledIndicator === true,
      hasFinishedFooter: payload.hasFinishedFooter === true,
      hasCompletedCollapse: payload.hasCompletedCollapse === true,
      markdownCount:
        typeof payload.markdownCount === "number" ? payload.markdownCount : 0,
    };

    const verdict = decideTurnState(signals);

    return {
      text: asString(payload.fullText),
      markdownText: asString(payload.markdownText),
      running: verdict.running,
      completed: verdict.completed,
      cancelled: verdict.cancelled,
      debug: signals.found
        ? `${signals.cls} | processing=${signals.hasProcessingStatus} | completion=${signals.completionStatusText || "none"}`
        : "no-agent",
    };
  }

  /**
   * Reads the model-credit/quota state of the live page.
   *
   * Uses the same shared CDP connection as every other adapter; the whole
   * probe is one round trip and it never mutates the page.
   */
  /** Raw payload of the quota probe; kept for debugging, not used by Relay. */
  async detectQuotaRaw(): Promise<unknown> {
    return this.cdp.evaluate(COLLECT_QUOTA_SIGNALS_EXPRESSION);
  }

  async detectQuota(): Promise<QuotaDetection> {
    const raw = await this.cdp.evaluate(COLLECT_QUOTA_SIGNALS_EXPRESSION);
    const signals = parseQuotaSignalsPayload(raw);
    return detectQuota(signals);
  }
}