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

const input =
document.querySelector(
'[contenteditable="true"][role="textbox"]'
);


return input.outerHTML;


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