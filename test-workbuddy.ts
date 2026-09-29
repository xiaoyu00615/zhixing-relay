import WebSocket from "ws";


const url =
"ws://127.0.0.1:9222/devtools/page/38153EABA25F998384D7FE23A4060F74";


const ws = new WebSocket(url);


ws.on("open",()=>{

    console.log(
        "✅ WorkBuddy CDP connected"
    );


    ws.send(JSON.stringify({

        id:1,

        method:"Runtime.evaluate",

        params:{
            expression:
            "document.body.innerText"
        }

    }));

});



ws.on("message",(data)=>{

    console.log(
        "----- WorkBuddy -----"
    );

    console.log(
        data.toString()
    );

});