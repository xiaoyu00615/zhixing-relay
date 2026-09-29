import {
    WorkBuddyWorker
} from "./src/workbuddy/worker";



const worker =
new WorkBuddyWorker(
"ws://127.0.0.1:9222/devtools/page/38153EABA25F998384D7FE23A4060F74"
);



const result =
await worker.run(
`
请执行自动化测试。

请回复三行：

第一行：确认收到任务
第二行：说明 WorkBuddy 自动化连接成功
第三行：说明当前测试完成
`
);



console.log(
"======== RESULT ========"
);


console.log(result);