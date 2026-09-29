import WebSocket from "ws";


export interface CDPResponse {
    id:number;
    result?:any;
    error?:any;
}


export class CDPClient {

    private ws?: WebSocket;

    private id = 0;


    constructor(
        private url:string
    ){}



    async connect(){

        if(
            this.ws &&
            this.ws.readyState === WebSocket.OPEN
        ){
            return;
        }


        this.ws = new WebSocket(
            this.url
        );


        await new Promise<void>((resolve,reject)=>{


            this.ws!.once(
                "open",
                ()=>{
                    resolve();
                }
            );


            this.ws!.once(
                "error",
                reject
            );


        });

    }



    async evaluate(
        expression:string
    ){

        await this.connect();


        const id =
        ++this.id;


        return new Promise<any>(
            (resolve,reject)=>{


                const handler =
                (data:WebSocket.RawData)=>{


                    const msg:
                    CDPResponse =
                    JSON.parse(
                        data.toString()
                    );


                    if(
                        msg.id !== id
                    ){
                        return;
                    }


                    this.ws!.off(
                        "message",
                        handler
                    );


                    if(msg.error){

                        reject(
                            msg.error
                        );

                    }else{

                        resolve(
                            msg.result.result.value
                        );

                    }

                };


                this.ws!.on(
                    "message",
                    handler
                );



                this.ws!.send(
                    JSON.stringify({

                        id,

                        method:
                        "Runtime.evaluate",

                        params:{
                            expression
                        }

                    })
                );

            }
        );

    }

}