import { WorkBuddyClient as CDPWorkBuddyClient } from "./workbuddy/client.js";
import {
  WorkBuddyModelController,
  type ModelSwitchResult,
} from "./workbuddy/model.js";
import type { AppConfig } from "./config.js";
import type { WorkBuddyMessage } from "./types.js";
import { waitForTurn } from "./workbuddy/turn-state.js";


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








async sendText(
  text:string
):Promise<string>{

  await this.cdpClient.sendMessage(
    text
  );


  const id =
    "cdp-" +
    Date.now();


  return id;

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