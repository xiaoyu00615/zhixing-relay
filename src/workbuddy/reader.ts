import {
    CDPClient
} from "./cdp";



export class WorkBuddyReader {


    private cdp: CDPClient;



    constructor(
        websocketUrl:string
    ){

        this.cdp =
        new CDPClient(
            websocketUrl
        );

    }



    async getLatestMessage(){


        const result =
        await this.cdp.evaluate(`

        (()=>{


            const agents =
            [
                ...document.querySelectorAll(
                    ".cr-agent"
                )
            ];



            for(
                let i = agents.length - 1;
                i >= 0;
                i--
            ){

                const markdown =
                agents[i].querySelector(
                    ".cr-markdown"
                );


                if(
                    markdown &&
                    markdown.innerText.trim()
                ){

                    return markdown.innerText.trim();

                }

            }



            return "NO_MESSAGE";


        })()

        `);



        return result;

    }


}