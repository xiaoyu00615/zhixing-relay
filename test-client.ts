import {
    WorkBuddyClient
}
from "./src/workbuddy/client";


const workbuddy =
new WorkBuddyClient(

"ws://127.0.0.1:9222/devtools/page/38153EABA25F998384D7FE23A4060F74"

);



await workbuddy.sendMessage(
"你好"
);


console.log(
"发送完成"
);