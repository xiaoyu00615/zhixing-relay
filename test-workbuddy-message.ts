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


                const nodes =
                [...document.querySelectorAll("*")]


                .filter(
                    e =>
                    e.innerText &&
                    e.innerText.length > 20
                )


                .map(
                    e=>({

                        tag:e.tagName,

                        cls:String(e.className)
                        .slice(0,80),

                        text:e.innerText
                        .slice(0,200)

                    })
                )

                .slice(-50);



                return JSON.stringify(nodes);


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