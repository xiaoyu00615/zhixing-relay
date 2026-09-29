import WebSocket from "ws";


const ws = new WebSocket(
"ws://127.0.0.1:9222/devtools/page/38153EABA25F998384D7FE23A4060F74"
);


ws.on("open",()=>{

    console.log(
        "✅ connected"
    );


    const text =
    "你好，这是 Zhixing Relay 测试";


    ws.send(JSON.stringify({

        id:1,

        method:"Runtime.evaluate",

        params:{

            expression:`

            (()=>{

                const input =
                document.querySelector(
                    '[contenteditable="true"][role="textbox"]'
                );


                if(!input){

                    return "INPUT_NOT_FOUND";

                }


                input.focus();



                document.execCommand(
                    "insertText",
                    false,
                    ${JSON.stringify(text)}
                );



                input.dispatchEvent(
                    new InputEvent(
                        "input",
                        {
                            bubbles:true,
                            inputType:"insertText",
                            data:${JSON.stringify(text)}
                        }
                    )
                );



                return "INSERT_OK";


            })()

            `

        }

    }));

});



ws.on("message",(data)=>{

    console.log(
        data.toString()
    );

});