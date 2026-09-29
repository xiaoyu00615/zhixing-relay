console.log("[Zhixing Relay] content loaded");


function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


// 查找 ChatGPT 输入框
function findChatGPTInput() {

    // 新版 ChatGPT
    let box = document.querySelector(
        '[contenteditable="true"]'
    );

    if (box) {
        return box;
    }


    // 备用 textarea
    box = document.querySelector(
        "textarea"
    );

    return box;
}


// 激活输入框
async function focusInput(box) {

    console.log(
        "[Zhixing Relay] focus input"
    );


    box.focus();


    await sleep(200);


    box.dispatchEvent(
        new MouseEvent(
            "mousedown",
            {
                bubbles: true,
                cancelable: true
            }
        )
    );


    box.dispatchEvent(
        new MouseEvent(
            "mouseup",
            {
                bubbles: true,
                cancelable: true
            }
        )
    );


    box.dispatchEvent(
        new MouseEvent(
            "click",
            {
                bubbles: true
            }
        )
    );
}



// 插入文字
async function insertText(box, text) {

    await focusInput(box);


    console.log(
        "[Zhixing Relay] insert text:",
        text
    );


    // 模拟用户输入
    document.execCommand(
        "insertText",
        false,
        text
    );


    box.dispatchEvent(
        new InputEvent(
            "input",
            {
                bubbles: true,
                inputType: "insertText",
                data: text
            }
        )
    );


    await sleep(800);
}



// 模拟回车提交
async function pressEnter(box) {


    console.log(
        "[Zhixing Relay] press Enter"
    );


    await focusInput(box);


    await sleep(300);



    const eventOptions = {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
    };


    box.dispatchEvent(
        new KeyboardEvent(
            "keydown",
            eventOptions
        )
    );


    await sleep(50);


    box.dispatchEvent(
        new KeyboardEvent(
            "keypress",
            eventOptions
        )
    );


    await sleep(50);


    box.dispatchEvent(
        new KeyboardEvent(
            "keyup",
            eventOptions
        )
    );


    await sleep(500);
}




async function sendChatGPTMessage(
    text,
    autoSend = true
) {


    console.log(
        "[Zhixing Relay] Sending:",
        text
    );


    const box = findChatGPTInput();



    if (!box) {

        console.error(
            "[Zhixing Relay] ChatGPT input not found"
        );

        return false;
    }



    await insertText(
        box,
        text
    );



if (true) {

        console.log(
            "[Zhixing Relay] autoSend enabled"
        );


        await pressEnter(
            box
        );

    } else {

        console.log(
            "[Zhixing Relay] autoSend disabled"
        );
    }



    console.log(
        "[Zhixing Relay] done"
    );


    return true;
}





// 接收 background.js 消息
chrome.runtime.onMessage.addListener(
    (
        message,
        sender,
        sendResponse
    ) => {


        console.log(
            "[Zhixing Relay] received:",
            message
        );



        if (
            message.type === "ZHIXING_SEND_TO_CHATGPT"
        ) {


            sendChatGPTMessage(
                message.text,
                message.autoSend
            )
            .then(
                result => {

                    sendResponse(
                        {
                            ok: result
                        }
                    );

                }
            );


            return true;
        }



        sendResponse(
            {
                ok:false,
                error:"unknown message type"
            }
        );


    }
);