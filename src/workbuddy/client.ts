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
import { type TurnSnapshot } from "./turn-ack.js";

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
 * a turn carries the task's id, and what the composer holds. Deciding what any
 * of it *means* stays in turn-ack.ts, which is unit-testable.
 *
 * Selectors that matter:
 *
 *   [contenteditable="true"][role="textbox"]  the composer
 *   .cr-agent                                 one rendered turn/message
 *
 * A turn signature is the rendered length plus the first characters of the
 * turn's own text: enough to tell "the same turn as before the click" from "a
 * new one", and it never carries the whole body out of the page.
 */
const TURN_SNAPSHOT_EXPRESSION = (taskId: string) => `
  (() => {
    const input = document.querySelector('[contenteditable="true"][role="textbox"]');
    const turns = Array.from(document.querySelectorAll('.cr-agent'));

    const observed = turns.map((el, index) => {
      const text = String(el.innerText || '');
      const signature = text.length + '|' + text.slice(0, 64);
      return {
        signature: signature,
        containsTaskId: text.indexOf(${JSON.stringify(taskId)}) !== -1,
        index: index,
      };
    });

    return JSON.stringify({
      inputText: String(input ? (input.innerText || '') : ''),
      turnCount: observed.length,
      turns: observed,
    });
  })()`;

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

  /** What the page renders right now: the turns, and what each of them carries. */
  async readTurnSnapshot(taskId: string): Promise<TurnSnapshot> {

    const raw =
      await this.cdp.evaluate(TURN_SNAPSHOT_EXPRESSION(taskId));

    if (typeof raw !== "string") return emptyTurnSnapshot();

    try {
      const payload = JSON.parse(raw) as {
        inputText?: unknown;
        turnCount?: unknown;
        turns?: unknown;
      };

      const turns = Array.isArray(payload.turns) ? payload.turns : [];

      return {
        inputText: typeof payload.inputText === "string" ? payload.inputText : "",
        turns: turns.filter(
          (turn): turn is TurnSnapshot["turns"][number] =>
            typeof turn === "object" &&
            turn !== null &&
            typeof (turn as { signature?: unknown }).signature === "string",
        ),
      };
    } catch {
      return emptyTurnSnapshot();
    }
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