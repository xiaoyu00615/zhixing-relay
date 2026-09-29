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

                return JSON.stringify(

                    [
                        ...document.querySelectorAll("*")
                    ]
                    .filter(
                        e =>
                        e.innerText &&
                        e.innerText.includes(
                            "今天帮你做些什么"
                        )
                    )
                    .map(
                        e=>({

                            tag:e.tagName,

                            contenteditable:
                            e.getAttribute(
                            "contenteditable"
                            ),

                            role:
                            e.getAttribute(
                            "role"
                            ),

                            class:
                            typeof e.className === "string"
                            ? e.className
                            : "",

                            text:
                            e.innerText.slice(0,100)

                        })

                    )
                    .slice(0,20)

                );

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