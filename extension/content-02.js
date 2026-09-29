console.log("[Zhixing Relay] content loaded");


/*
 * ============================================================
 * Config
 * ============================================================
 */

const ASSISTANT_BODY_SELECTOR =
  '[data-markdown-text-style="assistant-message"]';

const ASSISTANT_MESSAGE_ID_SELECTOR =
  '[data-chatgpt-selection-message-id]';

const ASSISTANT_UNIT_SELECTOR =
  '[data-content-search-unit-key$=":assistant"],' +
  '[data-chatgpt-search-unit-key$=":assistant"]';

const OBSERVER_QUIET_MS = 1200;

const COMPLETION_CONFIRM_MS = 900;

const FALLBACK_SCAN_MS = 2500;


/*
 * ============================================================
 * State
 * ============================================================
 */

let observer = null;

let scanTimer = null;

let fallbackTimer = null;

let urlWatchTimer = null;

let lastPageUrl = location.href;


/*
 * 已经成功发送给 Relay 的 assistant message。
 */
const sentAssistantFingerprints =
  new Set();


/*
 * 用于确认最终文本已经稳定。
 *
 * 避免 GPT 流式输出时，
 * MutationObserver 每一小段都发一次。
 */
let candidateFingerprint = null;

let candidateText = "";

let candidateStableCount = 0;



/*
 * ============================================================
 * Utils
 * ============================================================
 */

function sleep(ms) {

  return new Promise(
    resolve => setTimeout(resolve, ms)
  );

}



function hashText(text) {

  let hash = 2166136261;


  for (
    let i = 0;
    i < text.length;
    i++
  ) {

    hash ^=
      text.charCodeAt(i);


    hash =
      Math.imul(
        hash,
        16777619
      );

  }


  return (
    hash >>> 0
  ).toString(16);

}



function isVisible(element) {

  if (!element) {
    return false;
  }


  const style =
    window.getComputedStyle(
      element
    );


  if (
    style.display === "none" ||
    style.visibility === "hidden"
  ) {

    return false;

  }


  const rect =
    element.getBoundingClientRect();


  return (
    rect.width > 0 &&
    rect.height > 0
  );

}



/*
 * ============================================================
 * content.js -> background.js -> Relay
 * ============================================================
 */

function sendToRelay(payload) {

  return new Promise(
    resolve => {

      try {

        chrome.runtime.sendMessage(
          {
            type:
              "ZHIXING_TO_RELAY",

            payload
          },

          response => {

            if (
              chrome.runtime.lastError
            ) {

              console.warn(
                "[Zhixing Relay] sendToRelay runtime error:",
                chrome.runtime.lastError.message
              );


              resolve({
                ok: false,
                error:
                  chrome.runtime.lastError.message
              });

              return;

            }


            resolve(
              response || {
                ok: false
              }
            );

          }
        );

      }
      catch (error) {

        console.error(
          "[Zhixing Relay] sendToRelay failed:",
          error
        );


        resolve({
          ok: false,
          error: String(error)
        });

      }

    }
  );

}



/*
 * ============================================================
 * Relay -> ChatGPT
 * ============================================================
 */

function findChatGPTInput() {

  /*
   * 当前 ChatGPT composer。
   */
  let box =
    document.querySelector(
      '#prompt-textarea[contenteditable="true"]'
    );


  if (box) {
    return box;
  }


  /*
   * contenteditable fallback。
   */
  const editables =
    Array.from(
      document.querySelectorAll(
        '[contenteditable="true"]'
      )
    );


  box =
    editables.find(
      element => {

        /*
         * 排除聊天正文内部可能存在的
         * contenteditable。
         */
        if (
          element.closest(
            ASSISTANT_BODY_SELECTOR
          )
        ) {

          return false;

        }


        return isVisible(
          element
        );

      }
    );


  if (box) {
    return box;
  }


  /*
   * textarea fallback。
   */
  return document.querySelector(
    "textarea"
  );

}



async function focusInput(box) {

  box.focus();


  await sleep(100);


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



async function insertText(
  box,
  text
) {

  await focusInput(
    box
  );


  console.log(
    "[Zhixing Relay] insert text:",
    text
  );


  /*
   * 清空已有内容。
   */
  document.execCommand(
    "selectAll",
    false
  );


  document.execCommand(
    "delete",
    false
  );


  /*
   * 当前已验证能写入 ChatGPT composer。
   */
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


  await sleep(500);

}



function findSendButton() {

  const selectors = [

    'button[data-testid="send-button"]',

    'button[aria-label="Send prompt"]',

    'button[aria-label*="Send"]',

    'button[aria-label*="发送"]'

  ];


  for (
    const selector of selectors
  ) {

    const button =
      document.querySelector(
        selector
      );


    if (
      button &&
      isVisible(button)
    ) {

      return button;

    }

  }


  return null;

}



async function pressEnter(box) {

  await focusInput(
    box
  );


  const options = {

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
      options
    )
  );


  await sleep(40);


  box.dispatchEvent(
    new KeyboardEvent(
      "keypress",
      options
    )
  );


  await sleep(40);


  box.dispatchEvent(
    new KeyboardEvent(
      "keyup",
      options
    )
  );

}



async function sendChatGPTMessage(
  text,
  autoSend = true
) {

  console.log(
    "[Zhixing Relay] Sending:",
    text
  );


  const box =
    findChatGPTInput();


  if (!box) {

    console.error(
      "[Zhixing Relay] ChatGPT input not found"
    );


    return {
      ok: false,
      sent: false,
      staged: false,
      error:
        "ChatGPT input not found"
    };

  }


  await insertText(
    box,
    text
  );


  /*
   * 这里必须真正尊重 autoSend。
   *
   * gpt <text>
   * 就应该只 stage。
   *
   * WorkBuddy result
   * 配置 autoSend=true 时才发送。
   */
  if (!autoSend) {

    console.log(
      "[Zhixing Relay] autoSend disabled"
    );


    return {
      ok: true,
      sent: false,
      staged: true
    };

  }


  const button =
    findSendButton();


  if (
    button &&
    !button.disabled &&
    button.getAttribute(
      "aria-disabled"
    ) !== "true"
  ) {

    console.log(
      "[Zhixing Relay] clicking send button"
    );


    button.click();


    await sleep(400);

  }
  else {

    console.log(
      "[Zhixing Relay] send button unavailable, Enter fallback"
    );


    await pressEnter(
      box
    );


    await sleep(400);

  }


  return {
    ok: true,
    sent: true,
    staged: false
  };

}



/*
 * ============================================================
 * ChatGPT DOM - 当前真实结构
 * ============================================================
 */

/*
 * 当前实测结构：
 *
 * DIV
 *   data-markdown-text-style="assistant-message"
 *
 * ↑
 *
 * DIV
 *   data-chatgpt-selection-message-id="..."
 *
 * ↑
 *
 * DIV
 *   data-content-search-unit-key="...:assistant"
 *
 *
 * 不使用：
 *
 * .Paragraph-xxxx
 * .MarkdownRoot-xxxx
 *
 * 因为这些 class 后缀明显是构建期 hash。
 */

function getAssistantBodies() {

  return Array.from(
    document.querySelectorAll(
      ASSISTANT_BODY_SELECTOR
    )
  );

}



function extractAssistantText(node) {

  if (!node) {
    return "";
  }


  return (
    node.innerText || ""
  ).trim();

}



function getAssistantMessageId(node) {

  if (!node) {
    return null;
  }


  const holder =
    node.closest(
      ASSISTANT_MESSAGE_ID_SELECTOR
    );


  if (!holder) {
    return null;
  }


  return (
    holder.getAttribute(
      "data-chatgpt-selection-message-id"
    ) || null
  );

}



function getAssistantUnitKey(node) {

  if (!node) {
    return null;
  }


  const holder =
    node.closest(
      ASSISTANT_UNIT_SELECTOR
    );


  if (!holder) {
    return null;
  }


  return (
    holder.getAttribute(
      "data-content-search-unit-key"
    )
    ||
    holder.getAttribute(
      "data-chatgpt-search-unit-key"
    )
    ||
    null
  );

}



function makeAssistantFingerprint(
  node,
  text
) {

  /*
   * 第一优先级：
   * ChatGPT 自己的 message UUID。
   *
   * 这是目前最好的唯一标识。
   */
  const messageId =
    getAssistantMessageId(
      node
    );


  if (messageId) {

    return (
      "assistant-message:" +
      messageId
    );

  }


  /*
   * 第二优先级：
   * assistant search unit key。
   */
  const unitKey =
    getAssistantUnitKey(
      node
    );


  if (unitKey) {

    return (
      "assistant-unit:" +
      unitKey
    );

  }


  /*
   * 最后才退回文本 hash。
   */
  return (
    "assistant-text:" +
    hashText(text) +
    ":" +
    text.length
  );

}



/*
 * ============================================================
 * GPT generation detection
 * ============================================================
 */

function isChatGPTGenerating() {

  const selectors = [

    'button[data-testid="stop-button"]',

    'button[aria-label*="Stop"]',

    'button[aria-label*="stop"]',

    'button[aria-label*="停止"]',

    '[data-testid="stop-button"]'

  ];


  for (
    const selector of selectors
  ) {

    const element =
      document.querySelector(
        selector
      );


    if (
      element &&
      isVisible(element)
    ) {

      return true;

    }

  }


  return false;

}



/*
 * ============================================================
 * Existing history seeding
 * ============================================================
 */

function seedExistingAssistantMessages() {

  const nodes =
    getAssistantBodies();


  let seeded = 0;


  for (
    const node of nodes
  ) {

    const text =
      extractAssistantText(
        node
      );


    if (!text) {
      continue;
    }


    const fingerprint =
      makeAssistantFingerprint(
        node,
        text
      );


    sentAssistantFingerprints.add(
      fingerprint
    );


    seeded++;

  }


  /*
   * Route切换后重置当前候选。
   */
  candidateFingerprint = null;

  candidateText = "";

  candidateStableCount = 0;


  console.log(
    "[Zhixing Relay] seeded assistant messages:",
    seeded
  );

}



/*
 * ============================================================
 * Assistant -> Relay
 * ============================================================
 */

async function reportAssistantMessage(
  node,
  text,
  fingerprint
) {

  if (
    sentAssistantFingerprints.has(
      fingerprint
    )
  ) {

    return;

  }


  /*
   * 先标记，避免 observer + fallback
   * 同时触发造成双发。
   */
  sentAssistantFingerprints.add(
    fingerprint
  );


  console.log(
    "[Zhixing Relay] GPT assistant completed:",
    {
      fingerprint,
      messageId:
        getAssistantMessageId(node),
      unitKey:
        getAssistantUnitKey(node),
      length:
        text.length
    }
  );


  const result =
    await sendToRelay({
      type:
        "chatgpt_assistant_message",

      text,

      fingerprint
    });


  console.log(
    "[Zhixing Relay] assistant -> relay:",
    result
  );


  /*
   * 如果只是 Bridge 瞬间断开，
   * 下次扫描允许重试。
   */
  if (
    !result ||
    result.ok === false
  ) {

    sentAssistantFingerprints.delete(
      fingerprint
    );

  }

}



/*
 * ============================================================
 * Completion scan
 * ============================================================
 */

async function scanLatestAssistant() {

  scanTimer = null;


  const nodes =
    getAssistantBodies();


  if (!nodes.length) {

    return;

  }


  /*
   * 不能再使用：
   *
   * nodes[nodes.length - 1]
   *
   * ChatGPT 当前使用虚拟化列表，
   * DOM 顺序不等于消息时间顺序。
   *
   * 所以：
   *
   * 1. 找出所有当前 DOM 中的 assistant
   * 2. 排除已经发送过的 messageId
   * 3. 从剩余候选中找页面位置最靠下的一个
   */

  const candidates =
    nodes
      .map(node => {

        const text =
          extractAssistantText(
            node
          );


        if (!text) {

          return null;

        }


        const fingerprint =
          makeAssistantFingerprint(
            node,
            text
          );


        /*
         * 已经上报过的回复直接排除。
         */
        if (
          sentAssistantFingerprints.has(
            fingerprint
          )
        ) {

          return null;

        }


        const rect =
          node.getBoundingClientRect();


        return {

          node,

          text,

          fingerprint,

          messageId:
            getAssistantMessageId(
              node
            ),

          unitKey:
            getAssistantUnitKey(
              node
            ),

          top:
            rect.top,

          bottom:
            rect.bottom,

          height:
            rect.height

        };

      })
      .filter(Boolean);



  if (!candidates.length) {

    return;

  }


  /*
   * ChatGPT 虚拟 DOM 的 document order
   * 不可靠。
   *
   * 真实聊天布局仍然是：
   * 越新的消息越靠页面下方。
   *
   * 因此按照实际布局位置选择。
   */
  candidates.sort(
    (a, b) => {

      /*
       * 优先排除完全没有布局尺寸的隐藏节点。
       */
      if (
        a.height === 0 &&
        b.height > 0
      ) {

        return 1;

      }


      if (
        b.height === 0 &&
        a.height > 0
      ) {

        return -1;

      }


      return (
        b.bottom -
        a.bottom
      );

    }
  );


  const current =
    candidates[0];


  const latest =
    current.node;


  const text =
    current.text;


  const fingerprint =
    current.fingerprint;



  console.log(
    "[Zhixing Relay] assistant candidate:",
    {
      fingerprint,
      messageId:
        current.messageId,
      unitKey:
        current.unitKey,
      length:
        text.length,
      candidates:
        candidates.length,
      top:
        current.top,
      bottom:
        current.bottom
    }
  );



  /*
   * GPT 仍然处于生成状态：
   *
   * 绝对不能发送半截回答。
   */
  if (
    isChatGPTGenerating()
  ) {

    candidateFingerprint =
      fingerprint;


    candidateText =
      text;


    candidateStableCount = 0;


    console.log(
      "[Zhixing Relay] assistant still generating:",
      {
        fingerprint,
        length:
          text.length
      }
    );


    scheduleAssistantScan(
      1000
    );


    return;

  }



  /*
   * 第一次观察到这个最终候选，
   * 先记下来，不立即发送。
   */
  if (
    candidateFingerprint !==
      fingerprint
    ||
    candidateText !==
      text
  ) {

    candidateFingerprint =
      fingerprint;


    candidateText =
      text;


    candidateStableCount = 1;


    console.log(
      "[Zhixing Relay] assistant completion candidate:",
      {
        fingerprint,
        messageId:
          current.messageId,
        length:
          text.length
      }
    );


    scheduleAssistantScan(
      COMPLETION_CONFIRM_MS
    );


    return;

  }



  /*
   * 同一个 messageId，
   * 同一份正文，
   * 连续再次检查仍然没有变化。
   */
  candidateStableCount++;



  if (
    candidateStableCount < 2
  ) {

    scheduleAssistantScan(
      COMPLETION_CONFIRM_MS
    );


    return;

  }



  console.log(
    "[Zhixing Relay] assistant stable:",
    {
      fingerprint,
      messageId:
        current.messageId,
      length:
        text.length
    }
  );



  await reportAssistantMessage(
    latest,
    text,
    fingerprint
  );



  candidateFingerprint = null;

  candidateText = "";

  candidateStableCount = 0;

}



/*
 * MutationObserver debounce。
 */
function scheduleAssistantScan(
  delay = OBSERVER_QUIET_MS
) {

  if (scanTimer) {

    clearTimeout(
      scanTimer
    );

  }


  scanTimer =
    setTimeout(
      () => {

        void scanLatestAssistant();

      },
      delay
    );

}



/*
 * ============================================================
 * Observer
 * ============================================================
 */

function startAssistantObserver() {

  if (observer) {

    return;

  }


  if (!document.body) {

    setTimeout(
      startAssistantObserver,
      300
    );


    return;

  }


  seedExistingAssistantMessages();


  observer =
    new MutationObserver(
      () => {

        scheduleAssistantScan();

      }
    );


  observer.observe(
    document.body,
    {
      subtree: true,
      childList: true,
      characterData: true
    }
  );


  fallbackTimer =
    setInterval(
      () => {

        void scanLatestAssistant();

      },
      FALLBACK_SCAN_MS
    );


  console.log(
    "[Zhixing Relay] assistant observer started",
    {
      selector:
        ASSISTANT_BODY_SELECTOR
    }
  );

}



/*
 * ============================================================
 * ChatGPT SPA route watcher
 * ============================================================
 */

function startUrlWatcher() {

  if (urlWatchTimer) {

    return;

  }


  urlWatchTimer =
    setInterval(
      () => {

        if (
          location.href ===
          lastPageUrl
        ) {

          return;

        }


        lastPageUrl =
          location.href;


        console.log(
          "[Zhixing Relay] ChatGPT route changed:",
          lastPageUrl
        );


        /*
         * ChatGPT虚拟列表在路由变化后
         * 需要一点时间恢复 DOM。
         */
        setTimeout(
          seedExistingAssistantMessages,
          1400
        );

      },
      1000
    );

}



/*
 * ============================================================
 * Page ready
 * ============================================================
 */

async function reportPageReady() {

  const result =
    await sendToRelay({
      type:
        "chatgpt_page_ready",

      title:
        document.title,

      pageUrl:
        location.href
    });


  console.log(
    "[Zhixing Relay] page ready:",
    result
  );

}



/*
 * ============================================================
 * background.js -> content.js
 * ============================================================
 */

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
      message?.type ===
      "ZHIXING_SEND_TO_CHATGPT"
    ) {

      sendChatGPTMessage(
        message.text,
        Boolean(
          message.autoSend
        )
      )
      .then(
        result => {

          sendResponse(
            result
          );

        }
      )
      .catch(
        error => {

          console.error(
            "[Zhixing Relay] sendChatGPTMessage failed:",
            error
          );


          sendResponse({
            ok: false,
            sent: false,
            staged: false,
            error:
              String(error)
          });

        }
      );


      return true;

    }


    sendResponse({
      ok: false,
      error:
        "unknown message type"
    });


    return false;

  }
);



/*
 * ============================================================
 * Startup
 * ============================================================
 */

startAssistantObserver();

startUrlWatcher();


setTimeout(
  () => {

    void reportPageReady();

  },
  1000
);