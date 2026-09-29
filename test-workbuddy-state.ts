import "dotenv/config";

import { WorkBuddyClient } from "./src/workbuddy/client.js";


const url =
process.env.WORKBUDDY_CDP_URL;


if(!url){
    throw new Error(
        "WORKBUDDY_CDP_URL missing"
    );
}


const client =
new WorkBuddyClient(url);



const state =
await client.readState();



console.log(
    JSON.stringify(
        state,
        null,
        2
    )
);