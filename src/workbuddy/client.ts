import { CDPClient } from "./cdp.js";


export type WorkBuddyState = {
  text: string;
  running: boolean;
  completed: boolean;
  cancelled: boolean;
  debug?: string;
};



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









  async readState():Promise<WorkBuddyState>{



    const raw =
      await this.cdp.evaluate(`


      (()=>{


        const agents =
          Array.from(
            document.querySelectorAll(
              ".cr-agent"
            )
          );



        const current =
          agents.length
          ?
          agents[
            agents.length - 1
          ]
          :
          null;




        const text =
          current
          ?
          (
            current.innerText || ""
          ).trim()
          :
          "";




        const completed =
          text.includes(
            "已完成"
          );



        const cancelled =
          text.includes(
            "已取消"
          );



        const running =
          !completed &&
          !cancelled;



        return JSON.stringify({

          text,

          running,

          completed,

          cancelled,

          debug:
            current?.className || ""

        });



      })()


      `);




    if(
      typeof raw !== "string"
    ){

      throw new Error(
        "Invalid WorkBuddy state response"
      );

    }




    return JSON.parse(
      raw
    ) as WorkBuddyState;



  }



}