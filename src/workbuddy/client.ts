import { CDPClient } from "./cdp.js";
import {
  decideTurnState,
  type WorkBuddyState,
  type WorkBuddyTurnSignals,
} from "./turn-state.js";

export type { WorkBuddyState } from "./turn-state.js";

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





  async sendMessage(
    text:string
  ):Promise<void>{


    console.log(
      "[WorkBuddy] inserting:",
      text
    );



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




        /*
          Slate Editor 输入模拟
        */



        input.dispatchEvent(
          new KeyboardEvent(
            "keydown",
            {
              key:"",
              bubbles:true
            }
          )
        );



        input.dispatchEvent(
          new InputEvent(
            "beforeinput",
            {
              bubbles:true,
              inputType:"insertText",
              data:value
            }
          )
        );



        input.dispatchEvent(
          new InputEvent(
            "input",
            {
              bubbles:true,
              inputType:"insertText",
              data:value
            }
          )
        );



        input.dispatchEvent(
          new KeyboardEvent(
            "keyup",
            {
              key:"",
              bubbles:true
            }
          )
        );



        return "INPUT_OK";



      })()

      `);



    console.log(
      "[WorkBuddy] input:",
      inputResult
    );



    if(inputResult !== "INPUT_OK"){

      throw new Error(
        inputResult
      );

    }





    const check =
      await this.cdp.evaluate(`


      (()=>{


        const input =
          document.querySelector(
            '[contenteditable="true"][role="textbox"]'
          );



        const button =
          document.querySelector(
            "button.cr-send-button"
          );



        return JSON.stringify({

          text:
            input?.innerText || "",


          html:
            input?.innerHTML || "",


          disabled:
            button?.disabled ?? null,


          ariaDisabled:
            button?.getAttribute(
              "aria-disabled"
            )

        });



      })()


      `);



    console.log(
      "[CHECK INPUT]",
      check
    );







    await new Promise(
      resolve =>
        setTimeout(
          resolve,
          1500
        )
    );







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



        console.log(
          "[WorkBuddy] clicking send"
        );



        button.dispatchEvent(
          new MouseEvent(
            "mousedown",
            {
              bubbles:true
            }
          )
        );



        button.dispatchEvent(
          new MouseEvent(
            "mouseup",
            {
              bubbles:true
            }
          )
        );



        button.dispatchEvent(
          new MouseEvent(
            "click",
            {
              bubbles:true
            }
          )
        );



        button.click();



        return "CLICK_OK";



      })()


      `);




    console.log(
      "[WorkBuddy] send:",
      sendResult
    );



    if(sendResult !== "CLICK_OK"){

      throw new Error(
        sendResult
      );

    }



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



}