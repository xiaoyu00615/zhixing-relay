import WebSocket from "ws";


const ws = new WebSocket(
"ws://127.0.0.1:9222/devtools/page/38153EABA25F998384D7FE23A4060F74"
);


ws.on("open",()=>{

console.log("connected");


const text =
"你好，这是 Zhixing Relay 自动发送测试";


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



return "INPUT_OK";


})()

`

}

}));



setTimeout(()=>{


ws.send(JSON.stringify({

id:2,

method:"Runtime.evaluate",

params:{

expression:`

(()=>{


const btn =
document.querySelector(
'button.cr-send-button'
);


if(!btn){

return "BUTTON_NOT_FOUND";

}


btn.click();


return "CLICK_OK";


})()

`

}

}));


},1000);


});



ws.on("message",(data)=>{

console.log(
data.toString()
);

});