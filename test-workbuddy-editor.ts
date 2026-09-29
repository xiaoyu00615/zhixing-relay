import WebSocket from "ws";


const ws = new WebSocket(
"ws://127.0.0.1:9222/devtools/page/38153EABA25F998384D7FE23A4060F74"
);


ws.on("open",()=>{

    ws.send(JSON.stringify({

        id:1,

        method:"Runtime.evaluate",

        params:{
            expression:`

            (()=>{

                const result=[];


                document
                .querySelectorAll("*")
                .forEach(e=>{


                    const ce =
                    e.getAttribute(
                    "contenteditable"
                    );


                    const role =
                    e.getAttribute(
                    "role"
                    );


                    if(
                       ce ||
                       role==="textbox" ||
                       e.tagName==="TEXTAREA" ||
                       e.tagName==="INPUT"
                    ){

                        result.push({

                            tag:e.tagName,

                            ce,

                            role,

                            class:
                            e.className,

                            text:
                            e.innerText?.slice(0,50)

                        });

                    }

                });


                return JSON.stringify(result);


            })()

            `
        }

    }));

});


ws.on("message",(data)=>{

 console.log(data.toString());

});