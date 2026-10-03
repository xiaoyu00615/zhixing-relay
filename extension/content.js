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

const CAPTURE_ARM_MIN_WAIT_MS = 1500;

const CAPTURE_ARM_STABLE_MS = 1200;

const CAPTURE_ARM_MAX_WAIT_MS = 8000;

const CAPTURE_ARM_POLL_MS = 300;


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

let lastConversationKey = null;

let captureArmed = false;

let captureArmTimer = null;

let captureArmStartedAt = 0;

let captureLastSignature = "";

let captureStableSince = 0;


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



/**
 * Delivery idempotency.
 *
 * The Relay derives a stable `deliveryId` from durable facts (task, dispatch,
 * WorkBuddy message) and sends it on every `send_to_chatgpt`. We remember which
 * delivery ids we have already injected so that a Relay that re-sends the same
 * delivery after a crash or restart cannot put the answer into ChatGPT a second
 * time. Without this gate the only thing between a recovered round and a
 * duplicate user message would be the Relay's own guess, and the Relay cannot
 * know whether a crashed send actually landed.
 */

const DELIVERED_IDS_KEY = "zhixing_delivered_delivery_ids";
const DELIVERED_IDS_CAP = 50;

async function hasDeliveredId(
  deliveryId
) {

  if (!deliveryId) return false;

  try {

    const stored =
      await chrome.storage.local.get(
        DELIVERED_IDS_KEY
      );

    const list =
      Array.isArray(
        stored[DELIVERED_IDS_KEY]
      )
        ? stored[DELIVERED_IDS_KEY]
        : [];

    return list.includes(
      deliveryId
    );

  }
  catch {

    return false;

  }

}


async function recordDeliveredId(
  deliveryId
) {

  if (!deliveryId) return;

  try {

    const stored =
      await chrome.storage.local.get(
        DELIVERED_IDS_KEY
      );

    const list =
      Array.isArray(
        stored[DELIVERED_IDS_KEY]
      )
        ? stored[DELIVERED_IDS_KEY]
        : [];

    if (list.includes(deliveryId)) return;

    const next =
      [
        ...list,
        deliveryId
      ].slice(
        -DELIVERED_IDS_CAP
      );

    await chrome.storage.local.set(
      {
        [DELIVERED_IDS_KEY]: next
      }
    );

  }
  catch {

    // Best effort: a dedupe miss is safer than throwing mid-send.

  }

}


async function sendChatGPTMessage(
  text,
  autoSend = true,
  deliveryId = null
) {

  console.log(
    "[Zhixing Relay] Sending:",
    text
  );


  /*
   * Idempotency gate. If this exact delivery was already injected we must not
   * inject it again: a recovered Relay replaying the same delivery would
   * otherwise create a second user message in the thread.
   */
  if (deliveryId && await hasDeliveredId(deliveryId)) {

    console.log(
      "[Zhixing Relay] delivery " +
      deliveryId +
      " already applied; skipping re-injection"
    );

    return {
      ok: true,
      sent: true,
      staged: false,
      alreadyDelivered: true
    };

  }


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


  // The answer is now in the composer (and sent, if autoSend): remember this
  // delivery so a replay of the same delivery id cannot inject it twice.
  await recordDeliveredId(deliveryId);


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



/*
 * ============================================================
 * Relay -> page: read-only facts for reconciliation.
 * ============================================================
 *
 * This returns what the page shows - identity, fingerprint and raw text in
 * document order. It makes no decision: which message is a task, and whether
 * the task is the one in hand, is decided by Relay's protocol parser.
 */

function readRecentAssistantMessages(
  limit
) {

  const limitNumber =
    Number(limit) > 0
    ?
    Number(limit)
    : 5;


  const nodes =
    getAssistantBodies();


  const messages =
    nodes.map(
      function (
        node
      ) {

        const text =
          extractAssistantText(
            node
          );


        return {
          id:
            getAssistantMessageId(
              node
            ) ||
            getAssistantUnitKey(
              node
            ) ||
            null,
          fingerprint:
            makeAssistantFingerprint(
              node,
              text
            ),
          text:
            text
        };

      }
    )
    .filter(
      function (
        message
      ) {

        return Boolean(
          message.text
        );

      }
    );


  return messages.slice(
    -limitNumber
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
 * Capture arming / hydration barrier
 * ============================================================
 */

function getConversationKey() {

  const match =
    location.pathname.match(
      /\/c\/([^/?#]+)/
    );


  if (match?.[1]) {

    return (
      "conversation:" +
      match[1]
    );

  }


  return (
    "route:" +
    location.pathname +
    location.search
  );

}



function resetAssistantCandidate() {

  candidateFingerprint = null;

  candidateText = "";

  candidateStableCount = 0;

}



function getAssistantBaselineSignature() {

  const nodes =
    getAssistantBodies();


  const parts =
    nodes.map(
      node => {

        const text =
          extractAssistantText(
            node
          );


        const messageId =
          getAssistantMessageId(
            node
          );


        const unitKey =
          getAssistantUnitKey(
            node
          );


        return [
          messageId || "",
          unitKey || "",
          text.length,
          hashText(text)
        ].join(":");

      }
    );


  return (
    parts.length +
    "|" +
    parts.join("|")
  );

}



function scheduleCaptureArmCheck(
  delay = CAPTURE_ARM_POLL_MS
) {

  if (captureArmed) {

    return;

  }


  if (captureArmTimer) {

    clearTimeout(
      captureArmTimer
    );

  }


  captureArmTimer =
    setTimeout(
      () => {

        captureArmTimer = null;

        void tryArmAssistantCapture();

      },
      delay
    );

}



function disarmAssistantCapture(
  reason
) {

  captureArmed = false;


  if (scanTimer) {

    clearTimeout(
      scanTimer
    );

    scanTimer = null;

  }


  if (captureArmTimer) {

    clearTimeout(
      captureArmTimer
    );

    captureArmTimer = null;

  }


  captureArmStartedAt =
    Date.now();

  captureLastSignature = "";

  captureStableSince = 0;


  resetAssistantCandidate();


  console.log(
    "[Zhixing Relay] assistant capture disarmed:",
    reason
  );


  scheduleCaptureArmCheck(
    50
  );

}



async function tryArmAssistantCapture() {

  if (captureArmed) {

    return;

  }


  if (!captureArmStartedAt) {

    captureArmStartedAt =
      Date.now();

  }


  const now =
    Date.now();


  const elapsed =
    now -
    captureArmStartedAt;


  /*
   * 如果 GPT 正在生成，绝不能在此时建立历史基线。
   */
  if (
    isChatGPTGenerating()
  ) {

    captureLastSignature = "";

    captureStableSince = 0;


    scheduleCaptureArmCheck();

    return;

  }


  const nodes =
    getAssistantBodies();


  const signature =
    getAssistantBaselineSignature();


  if (
    signature !==
    captureLastSignature
  ) {

    captureLastSignature =
      signature;

    captureStableSince =
      now;


    /*
     * 任何尚未 armed 时出现的 assistant
     * 都属于当前页面基线，不允许发送给 Relay。
     */
    seedExistingAssistantMessages();


    scheduleCaptureArmCheck();

    return;

  }


  const stableFor =
    captureStableSince
      ? now - captureStableSince
      : 0;


  const hasBaseline =
    nodes.length > 0;


  const minWaitSatisfied =
    elapsed >=
    CAPTURE_ARM_MIN_WAIT_MS;


  const stableSatisfied =
    stableFor >=
    CAPTURE_ARM_STABLE_MS;


  const maxWaitReached =
    elapsed >=
    CAPTURE_ARM_MAX_WAIT_MS;


  /*
   * 已有 /c/<id> 对话时，优先等到至少一个 assistant
   * 真正挂载到 DOM 后再 armed。
   *
   * 空白新会话可能没有历史 assistant，所以保留 max wait。
   */
  const baselineReady =
    hasBaseline ||
    maxWaitReached;


  if (
    !baselineReady ||
    !minWaitSatisfied ||
    (!stableSatisfied && !maxWaitReached)
  ) {

    scheduleCaptureArmCheck();

    return;

  }


  /*
   * armed 前最后再 seed 一次，封住 hydration 末尾竞态。
   */
  seedExistingAssistantMessages();


  captureArmed = true;


  resetAssistantCandidate();


  console.log(
    "[Zhixing Relay] assistant capture armed:",
    {
      assistants:
        getAssistantBodies().length,
      elapsedMs:
        elapsed,
      conversationKey:
        getConversationKey()
    }
  );

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


  if (!captureArmed) {

    return;

  }


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


  observer =
    new MutationObserver(
      () => {

        if (!captureArmed) {

          scheduleCaptureArmCheck();

          return;

        }


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

        if (!captureArmed) {

          scheduleCaptureArmCheck(
            0
          );

          return;

        }


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


  disarmAssistantCapture(
    "startup"
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


  lastConversationKey =
    getConversationKey();


  urlWatchTimer =
    setInterval(
      () => {

        if (
          location.href !==
          lastPageUrl
        ) {

          lastPageUrl =
            location.href;

        }


        const conversationKey =
          getConversationKey();


        /*
         * ChatGPT 会在同一个 conversation 内规范化 URL slug。
         * 这种 href 变化不能触发重新 baseline。
         * 只有真正切换 conversation 才 disarm。
         */
        if (
          conversationKey ===
          lastConversationKey
        ) {

          return;

        }


        lastConversationKey =
          conversationKey;


        console.log(
          "[Zhixing Relay] ChatGPT conversation changed:",
          {
            conversationKey,
            url:
              location.href
          }
        );


        disarmAssistantCapture(
          "conversation_changed"
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
      "ZHIXING_FETCH_RECENT_ASSISTANT_MESSAGES"
    ) {

      sendResponse(
        {
          ok: true,
          messages:
            readRecentAssistantMessages(
              message.limit || 5
            )
        }
      );

      return true;

    }


    if (
      message?.type ===
      "ZHIXING_SEND_TO_CHATGPT"
    ) {

      sendChatGPTMessage(
        message.text,
        Boolean(
          message.autoSend
        ),
        message.deliveryId ?? null
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