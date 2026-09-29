import {
 WorkBuddyReader
}
from "./src/workbuddy/reader";



const reader =
new WorkBuddyReader(
"ws://127.0.0.1:9222/devtools/page/38153EABA25F998384D7FE23A4060F74"
);



const text =
await reader.getLatestMessage();


console.log(text);