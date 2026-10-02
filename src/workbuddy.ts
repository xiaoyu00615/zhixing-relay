import { WorkBuddyClient as CDPWorkBuddyClient } from "./workbuddy/client.js";
import type { QuotaDetection } from "./workbuddy/quota.js";
import {
  WorkBuddyModelController,
  type ModelSwitchResult,
} from "./workbuddy/model.js";
import type { AppConfig } from "./config.js";
import type { WorkBuddyMessage } from "./types.js";
import { waitForTurn } from "./workbuddy/turn-state.js";
import {
  confirmInputReadback,
  waitForRunning as waitForRunningConfirmation,
  waitForSendConfirmation,
  type InputConfirmation,
  type RunningConfirmation,
  type SendConfirmation,
} from "./workbuddy/turn-ack.js";


/** What the relay gets back from handing a task to WorkBuddy. */
export type SendAck = {
  /** The outbound message WorkBuddy is expected to answer. */
  outboundId: string;
  /** The composer really held this payload before the click. */
  input: InputConfirmation;
  /**
   * The click alone is never enough. `ok` says WorkBuddy grew a new turn
   * carrying this task, which is the only thing a send confirmation can mean.
   */
  send: SendConfirmation;
  /** True when the send button was clicked at all. */
  clickOk: boolean;
};

export class WorkBuddyClient {


  private cdpClient: CDPWorkBuddyClient;

  private modelController: WorkBuddyModelController;



  constructor(
    private readonly config: AppConfig["workbuddy"],
    _tokenUrl: URL,
  ) {


    if(config.mode !== "cdp"){

      throw new Error(
        "Only CDP WorkBuddy mode is supported"
      );

    }



    this.cdpClient =
      new CDPWorkBuddyClient(
        config.cdpUrl
      );

    this.modelController =
      new WorkBuddyModelController(
        this.cdpClient
      );

  }








  async init(): Promise<void>{

    // CDP模式无需初始化token

  }








  async online(): Promise<boolean>{

  console.log(
    "[WORKBUDDY] online check"
  );


  return true;

}








/**
 * Hands one task to WorkBuddy and reports what WorkBuddy admitted to.
 *
 * The order is the whole point and must not be rearranged:
 *
 *   type            the payload goes into the composer
 *   confirmInput    the composer is read back and compared with the payload
 *   click           send is clicked (only after a confirmed input)
 *   confirmSend     the page is watched for a NEW turn carrying this task
 *
 * A click that produced no new turn is reported as `send.ok === false`, never
 * as a success: after the click the world is genuinely unknown, and unknown is
 * a reconciliation case rather than something to retry blindly.
 */
async sendText(
  text:string,
  context: {
    taskId: string;
    pollIntervalMs: number;
    sendConfirmTimeoutMs: number;
  }
):Promise<SendAck>{

  const failed = (
    reason: SendConfirmation["reason"],
    detail: string,
    input: InputConfirmation,
  ): SendAck => ({
    outboundId: "cdp-" + Date.now(),
    input,
    send: {
      ok: false,
      reason,
      observedMessageId: null,
      beforeTurnCount: 0,
      afterTurnCount: 0,
      detail,
    },
    clickOk: false,
  });

  const unconfirmed = (): InputConfirmation => ({
    ...confirmInputReadback({ expected: text, observed: "" }),
    reason: "no_composer",
  });

  /*
   * The composer has to be cleared or at least emptied before the payload can
   * be trusted: whatever was left in it would look part of this task.
   */
  const prepared = await this.cdpClient.typeIntoComposer(text);

  if (!prepared.ok) {
    return failed(
      "input_not_confirmed",
      `the composer could not be addressed: ${prepared.detail}`,
      unconfirmed(),
    );
  }

  const observedText = await this.cdpClient.readComposerText();
  const input = confirmInputReadback({ expected: text, observed: observedText });

  if (!input.ok) {
    return failed("input_not_confirmed", `input readback rejected: ${input.reason}`, input);
  }

  const before = await this.cdpClient.readTurnSnapshot(context.taskId);
  const clicked = await this.cdpClient.clickSendButton();

  const send =
    clicked.clickOk === false
      ? {
          ok: false as const,
          reason: "no_new_turn" as const,
          observedMessageId: null,
          beforeTurnCount: before.turns.length,
          afterTurnCount: before.turns.length,
          detail: `the send button was not clicked (${clicked.detail}); nothing was sent`,
        }
      : await waitForSendConfirmation(
          () => this.cdpClient.readTurnSnapshot(context.taskId),
          {
            before,
            expectedTaskId: context.taskId,
            pollIntervalMs: context.pollIntervalMs,
            timeoutMs: context.sendConfirmTimeoutMs,
          },
        );

  return {
    outboundId: "cdp-" + Date.now(),
    input,
    send,
    clickOk: clicked.clickOk,
  };

}

/**
 * Watches a bounded window for WorkBuddy genuinely starting to work.
 *
 * Seeing the message in the history is not running; a processing indicator is.
 * A result that lands inside the window is reported as such, so the relay can
 * skip the running confirmation instead of dropping a finished answer.
 */
async waitForRunning(
  options: {
    pollIntervalMs: number;
    timeoutMs: number;
    signal?: AbortSignal;
  }
):Promise<RunningConfirmation>{

  const confirmation =
    await waitForRunningConfirmation(
      () => this.cdpClient.readState(),
      {
        pollIntervalMs: options.pollIntervalMs,
        timeoutMs: options.timeoutMs,
      }
    );

  if (options.signal?.aborted) {
    return {
      outcome: "timeout",
      ok: false,
      reason: "the wait for WorkBuddy to start was aborted",
      evidence: confirmation.evidence,
    };
  }

  return confirmation;
}









  /**
   * Model selector control. The relay asks for a label chosen by the model
   * router; the DOM knowledge needed to apply it stays here.
   */
  getCurrentModel(): Promise<string | null> {
    return this.modelController.getCurrentModel();
  }

  listAvailableModels(): Promise<string[]> {
    return this.modelController.listAvailableModels();
  }

  selectModel(label: string): Promise<ModelSwitchResult> {
    return this.modelController.selectModel(label);
  }

  /**
   * Quota/usage state of the model WorkBuddy is currently on.
   *
   * Runs on the shared CDP connection after a turn so the relay can block an
   * exhausted model and let the router fall back, instead of reporting a
   * generic "unknown error" to GPT.
   */
  detectQuota(): Promise<QuotaDetection> {
    return this.cdpClient.detectQuota();
  }

  async waitForAssistantReply(
    startingMessageId: string,
    options?: {
      onProgress?: (message: WorkBuddyMessage) => Promise<void> | void;
      signal?: AbortSignal;
    },
  ): Promise<{
    text: string;
    lastMessageId: string;
    assistantMessages: WorkBuddyMessage[];
  }> {
    /*
     * Completion, cancellation and body extraction now live in
     * workbuddy/turn-state.ts, decided from STRUCTURAL DOM signals rather
     * than from keyword search over the whole turn text.
     */
    const { text } = await waitForTurn(
      () => this.cdpClient.readState(),
      {
        pollIntervalMs: this.config.pollIntervalMs,
        maxWaitMs: this.config.maxWaitMs,
        ...(options?.signal ? { signal: options.signal } : {}),
      },
    );

    return {
      text,
      lastMessageId: startingMessageId,
      assistantMessages: [],
    };
  }


}