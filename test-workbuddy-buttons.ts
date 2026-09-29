import WebSocket from "ws";

const ws = new WebSocket(
  "ws://127.0.0.1:9222/devtools/page/38153EABA25F998384D7FE23A4060F74"
);

ws.on("open", () => {

  console.log("connected");


  ws.send(JSON.stringify({

    id: 1,

    method: "Runtime.evaluate",

    params: {

      expression: `

      (()=>{

        try {

          return JSON.stringify({

            buttons:
            [...document.querySelectorAll("button")]
            .map((b,index)=>({
              index,
              text:b.innerText,
              aria:b.getAttribute("aria-label"),
              title:b.getAttribute("title"),
              cls:String(b.className)
            }))
            .slice(0,50),


            clickable:
            [...document.querySelectorAll("*")]
            .filter(e=>{

              const t =
              (e.innerText || "").trim();

              const c =
              String(e.className);

              return (
                t.includes("发送") ||
                t.includes("提交") ||
                c.includes("send")
              );

            })
            .map(e=>({

              tag:e.tagName,

              text:
              e.innerText?.slice(0,50),

              cls:
              String(e.className)

            }))
            .slice(0,50)

          });


        } catch(e){

          return "ERROR:" + e.message;

        }


      })()

      `

    }

  }));

});


ws.on("message",(data)=>{

  console.log(
    "RESULT:"
  );

  console.log(
    data.toString()
  );

});


ws.on("error",(err)=>{

 console.log(
  "WS ERROR",
  err
 );

});