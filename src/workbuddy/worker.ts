import {
    WorkBuddyClient
} from "./client";


import {
    WorkBuddyReader
} from "./reader";



function sleep(ms:number){

    return new Promise(
        resolve => setTimeout(resolve, ms)
    );

}




export class WorkBuddyWorker {


    private client: WorkBuddyClient;

    private reader: WorkBuddyReader;



    constructor(
        websocketUrl:string
    ){

        this.client =
        new WorkBuddyClient(
            websocketUrl
        );


        this.reader =
        new WorkBuddyReader(
            websocketUrl
        );

    }





    async run(
        task:string
    ){


        console.log(
            "[Worker] snapshot old result"
        );



        const oldResult =
        await this.reader.getLatestMessage();



        console.log(
            "[Worker] old:",
            oldResult.slice(0,100)
        );




        console.log(
            "[Worker] send task:",
            task
        );



        await this.client.sendMessage(
            task
        );



        console.log(
            "[Worker] waiting new result..."
        );



        let candidate = "";

        let stableCount = 0;



        for(
            let i = 0;
            i < 120;
            i++
        ){


            await sleep(2000);



            const result =
            await this.reader.getLatestMessage();



            if(
                !result ||
                result === "NO_MESSAGE"
            ){

                continue;

            }



            // 忽略旧消息

            if(
                result === oldResult
            ){

                continue;

            }





            // 内容发生变化

            if(
                result !== candidate
            ){

                candidate = result;

                stableCount = 0;


                console.log(
                    "[Worker] candidate:",
                    result.slice(0,100)
                );


                continue;

            }




            // 内容连续一致

            stableCount++;


            console.log(
                "[Worker] stable check:",
                stableCount
            );





            if(
                stableCount >= 2
            ){


                console.log(
                    "[Worker] waiting final confirm..."
                );



                await sleep(3000);



                const finalResult =
                await this.reader.getLatestMessage();



                if(
                    finalResult === result
                ){

                    console.log(
                        "[Worker] final stable result"
                    );


                    return finalResult;

                }



                console.log(
                    "[Worker] content still changing"
                );



                candidate = finalResult;

                stableCount = 0;


            }


        }



        throw new Error(
            "WorkBuddy timeout waiting result"
        );


    }


}