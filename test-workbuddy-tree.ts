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


const blocks =
[
 ...document.querySelectorAll(
 ".cr-agent__content *"
 )
];


return JSON.stringify(

blocks

.map(
e=>({

tag:e.tagName,

cls:String(e.className),

text:e.innerText?.slice(0,100)

})

)

.filter(
x=>x.text
)

.slice(-30)


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