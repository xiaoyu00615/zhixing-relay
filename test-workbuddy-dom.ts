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

                const el =
                [...document.querySelectorAll("*")]
                .find(
                    e =>
                    e.innerText &&
                    e.innerText.includes(
                    "今天帮你做些什么"
                    )
                );


                if(!el){
                    return "not found";
                }


                return JSON.stringify({

                    tag:el.tagName,

                    contenteditable:
                    el.getAttribute(
                    "contenteditable"
                    ),

                    class:
                    el.className,

                    role:
                    el.getAttribute("role"),

                    html:
                    el.outerHTML.slice(0,500)

                });

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