import { WorkBuddyClient as CDPWorkBuddyClient } from "./workbuddy/client.js";
import type { AppConfig } from "./config.js";
import type { WorkBuddyMessage } from "./types.js";
import { sleep } from "./utils.js";


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
    startingMessageId:string,
    options?:{
      onProgress?:
      (
        message:WorkBuddyMessage
      )=>Promise<void>|void;

      signal?:AbortSignal;
    }

  ):Promise<{

    text:string;

    lastMessageId:string;

    assistantMessages:
    WorkBuddyMessage[];

  }>{



    const startedAt =
Date.now();


const before =
await this.cdpClient.readState();


const oldText =
before.text;


console.log(
 "[WB BEFORE]",
 {
   oldText,
   length: oldText.length
 }
);


let previousText="";

    let stableCount = 0;



    console.log(
      "[WB] waiting reply:",
      startingMessageId
    );





    while(
      Date.now()
      -
      startedAt
      <
      this.config.maxWaitMs
    ){



      if(
        options?.signal?.aborted
      ){

        throw new Error(
          "WorkBuddy wait aborted"
        );

      }






      const state =
        await this.cdpClient.readState();



      console.log(
        "[WB STATE]",
        {
          running:
            state.running,

          completed:
            state.completed,

          cancelled:
            state.cancelled,

          length:
            state.text.length
        }
      );






      if(
        state.cancelled
      ){

        throw new Error(
          "WorkBuddy task cancelled"
        );

      }






      /*
        还在执行：

        继续等待

        即使10分钟没有文字
        也不会结束
      */

      if(
        state.running
      ){

        await sleep(
          this.config.pollIntervalMs
        );

        continue;

      }








      /*
        已完成：

        等待文本稳定两轮

        防止最后一句还在刷新
      */

      if(
 state.completed
 &&
 state.text
 &&
 state.text !== oldText
){



        if(
          state.text === previousText
        ){

          stableCount++;

        }
        else{

          previousText =
            state.text;

          stableCount = 0;

        }






        if(
          stableCount >= 2
        ){


          console.log(
            "[WB] final result confirmed"
          );



          return {

            text:
              state.text,

            lastMessageId:
              startingMessageId,

            assistantMessages:[]

          };

        }


      }






      await sleep(
        this.config.pollIntervalMs
      );


    }





    throw new Error(
      `Timed out waiting WorkBuddy after ${this.config.maxWaitMs}ms`
    );


  }


}