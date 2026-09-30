import { WorkBuddyClient as CDPWorkBuddyClient } from "./workbuddy/client.js";
import type { AppConfig } from "./config.js";
import type { WorkBuddyMessage } from "./types.js";
import { waitForTurn } from "./workbuddy/turn-state.js";


export class WorkBuddyClient {


  private cdpClient: CDPWorkBuddyClient;



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