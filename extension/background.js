const DEFAULT_SETTINGS = {
  relayUrl: "ws://127.0.0.1:8787",
  relaySharedSecret: "",
  enabled: true,
  autoSendToChatGPT: false,
  targetTabId: null,
  targetTabTitle: ""
};


let ws = null;

let reconnectTimer = null;

let heartbeatTimer = null;

let reconnectDelay = 1000;


/*
 * 记录“我们主动关闭”的 socket。
 * 防止点击“重新连接”以后：
 *
 * old socket close
 *   ↓
 * scheduleReconnect()
 *   ↓
 * 又创建一个额外 websocket
 */
const manuallyClosedSockets = new WeakSet();


let lastStatus = {
  connected: false,
  authenticated: false,
  enabled: true,
  relayUrl: DEFAULT_SETTINGS.relayUrl,
  lastError: null,
  lastMessageAt: null
};



async function getSettings() {

  const stored =
    await chrome.storage.local.get(
      DEFAULT_SETTINGS
    );

  return {
    ...DEFAULT_SETTINGS,
    ...stored
  };

}



async function saveStatus(patch) {

  lastStatus = {
    ...lastStatus,
    ...patch
  };

  await chrome.storage.local.set({
    bridgeStatus: lastStatus
  });

}



function isChatGPTUrl(url = "") {

  return (
    url.startsWith("https://chatgpt.com/") ||
    url.startsWith("https://chat.openai.com/")
  );

}



function stopHeartbeat() {

  if (heartbeatTimer) {

    clearInterval(
      heartbeatTimer
    );

    heartbeatTimer = null;

  }

}



function startHeartbeat(socket) {

  stopHeartbeat();


  heartbeatTimer =
    setInterval(() => {

      /*
       * 只允许当前活动 socket 发 heartbeat。
       */
      if (
        ws === socket &&
        socket.readyState === WebSocket.OPEN
      ) {

        try {

          socket.send(
            JSON.stringify({
              type: "bridge_ping",
              bridge: "zhixing-relay-extension",
              ts: Date.now()
            })
          );

        }
        catch (error) {

          console.error(
            "[Zhixing Bridge] heartbeat failed:",
            error
          );

        }

      }

    }, 20000);

}



async function sendToTargetTab(message) {

  const settings =
    await getSettings();


  if (!settings.targetTabId) {

    throw new Error(
      "No ChatGPT tab is pinned. Open the extension and click 'Use current tab'."
    );

  }


  const tab =
    await chrome.tabs.get(
      settings.targetTabId
    );


  if (!isChatGPTUrl(tab.url || "")) {

    throw new Error(
      "Pinned tab is no longer a ChatGPT page."
    );

  }


  return chrome.tabs.sendMessage(
    settings.targetTabId,
    message
  );

}



async function sendToRelay(payload) {

  if (
    !ws ||
    ws.readyState !== WebSocket.OPEN
  ) {

    return {
      ok: false,
      error: "Relay WebSocket is not connected"
    };

  }


  ws.send(
    JSON.stringify({
      ...payload,
      bridge: "zhixing-relay-extension",
      ts: Date.now()
    })
  );


  await saveStatus({
    lastMessageAt: Date.now()
  });


  return {
    ok: true
  };

}



function clearReconnectTimer() {

  if (reconnectTimer) {

    clearTimeout(
      reconnectTimer
    );

    reconnectTimer = null;

  }

}



function scheduleReconnect() {

  /*
   * 已经有重连计划就不要再创建第二个。
   */
  if (reconnectTimer) {
    return;
  }


  const delay =
    reconnectDelay;


  console.log(
    "[Zhixing Bridge] reconnect scheduled:",
    delay,
    "ms"
  );


  reconnectTimer =
    setTimeout(async () => {

      reconnectTimer = null;

      await connect();

    }, delay);


  reconnectDelay =
    Math.min(
      reconnectDelay * 2,
      15000
    );

}



async function connect() {

  const settings =
    await getSettings();


  await saveStatus({
    enabled: settings.enabled,
    relayUrl: settings.relayUrl
  });


  if (!settings.enabled) {

    await disconnect();

    return;

  }


  /*
   * 防止重复 connect()。
   */
  if (
    ws &&
    (
      ws.readyState === WebSocket.OPEN ||
      ws.readyState === WebSocket.CONNECTING
    )
  ) {

    console.log(
      "[Zhixing Bridge] already connected/connecting"
    );

    return;

  }


  clearReconnectTimer();


  console.log(
    "[Zhixing Bridge] connecting:",
    settings.relayUrl
  );


  let socket;


  try {

    socket =
      new WebSocket(
        settings.relayUrl
      );

  }
  catch (error) {

    console.error(
      "[Zhixing Bridge] create socket failed:",
      error
    );


    await saveStatus({
      connected: false,
      authenticated: false,
      lastError: String(error)
    });


    scheduleReconnect();

    return;

  }


  ws = socket;



  socket.onopen = async () => {

    /*
     * 如果这已经不是当前 socket，
     * 就忽略这个迟到的 open。
     */
    if (ws !== socket) {
      return;
    }


    console.log(
      "[Zhixing Bridge] connected"
    );


    reconnectDelay = 1000;


    await saveStatus({
      connected: true,
      authenticated: false,
      lastError: null
    });


    const helloResult =
      await sendToRelay({
        type: "bridge_hello",
        source: "chrome_extension",
        sharedSecret:
          settings.relaySharedSecret || "",
        capabilities: [
          "chatgpt.assistant_message",
          "chatgpt.user_message",
          "chatgpt.send_message",
          "chatgpt.pin_single_tab"
        ]
      });


    if (!helloResult.ok) {

      await saveStatus({
        authenticated: false,
        lastError: helloResult.error || "bridge_hello failed"
      });

      return;

    }


    /*
     * 当前 Relay 没有单独 hello ACK，
     * 所以成功发出 hello 后标记 authenticated。
     */
    await saveStatus({
      authenticated: true
    });


    startHeartbeat(
      socket
    );

  };



  socket.onmessage = async (event) => {

    if (ws !== socket) {
      return;
    }


    let message;


    try {

      message =
        JSON.parse(
          event.data
        );

    }
    catch {

      console.warn(
        "[Zhixing Bridge] invalid JSON from Relay"
      );

      return;

    }


    console.log(
      "[Zhixing Bridge] received:",
      message.type
    );


    if (
      message.type === "bridge_pong"
    ) {

      return;

    }



    if (
      message.type === "fetch_recent_assistant_messages"
    ) {

      /*
       * Read-only: the page is asked what it currently shows and the answer
       * goes straight back. Nothing is typed, nothing is clicked, and no
       * business decision is taken here - Relay owns the parser.
       */
      try {

        const contentResult =
          await sendToTargetTab({
            type:
              "ZHIXING_FETCH_RECENT_ASSISTANT_MESSAGES",
            requestId:
              message.requestId || null,
            limit:
              message.limit || 5
          });


        await sendToRelay({
          type:
            "recent_assistant_messages",
          requestId:
            message.requestId || null,
          limit:
            message.limit || 5,
          messages:
            contentResult?.messages || []
        });

      }
      catch (error) {

        console.error(
          "[Zhixing Bridge] recent assistant messages failed:",
          error
        );

        await sendToRelay({
          type:
            "recent_assistant_messages",
          requestId:
            message.requestId || null,
          messages: []
        });

      }

      return;

    }


    if (
      message.type === "send_to_chatgpt" &&
      typeof message.text === "string"
    ) {

      const settingsNow =
        await getSettings();


      try {

        const contentResult =
          await sendToTargetTab({
            type: "ZHIXING_SEND_TO_CHATGPT",
            text: message.text,
            requestId:
              message.requestId || null,
            deliveryId:
              message.deliveryId || null,
            autoSend: Boolean(
              message.autoSend ??
              settingsNow.autoSendToChatGPT
            )
          });


        await sendToRelay({
          type: "chatgpt_send_result",
          requestId:
            message.requestId || null,
          ok:
            contentResult?.ok !== false,
          error:
            contentResult?.error || null
        });

      }
      catch (error) {

        console.error(
          "[Zhixing Bridge] send to ChatGPT failed:",
          error
        );


        await sendToRelay({
          type: "chatgpt_send_result",
          requestId:
            message.requestId || null,
          ok: false,
          error: String(error)
        });

      }

    }

  };



  socket.onclose = async (event) => {

    console.log(
      "[Zhixing Bridge] closed:",
      event.code,
      event.reason || ""
    );


    const wasManual =
      manuallyClosedSockets.has(
        socket
      );


    /*
     * 只有当前 socket 关闭时，
     * 才清空全局 ws。
     */
    if (ws === socket) {

      ws = null;

      stopHeartbeat();


      await saveStatus({
        connected: false,
        authenticated: false,
        lastError:
          event.reason || null
      });

    }


    if (!wasManual) {

      scheduleReconnect();

    }

  };



  socket.onerror = async () => {

    console.error(
      "[Zhixing Bridge] WebSocket error"
    );


    if (ws === socket) {

      await saveStatus({
        connected: false,
        authenticated: false,
        lastError:
          "WebSocket connection error"
      });

    }

  };

}



async function disconnect() {

  clearReconnectTimer();

  stopHeartbeat();


  const socket =
    ws;


  ws = null;


  if (socket) {

    manuallyClosedSockets.add(
      socket
    );


    try {

      socket.close(
        1000,
        "Extension reconnect"
      );

    }
    catch {}

  }


  await saveStatus({
    connected: false,
    authenticated: false
  });

}



/*
 * Extension 安装 / 更新
 */
chrome.runtime.onInstalled.addListener(
  async () => {

    const existing =
      await chrome.storage.local.get(
        DEFAULT_SETTINGS
      );


    await chrome.storage.local.set({
      ...DEFAULT_SETTINGS,
      ...existing
    });


    await connect();

  }
);



/*
 * Chrome 启动
 */
chrome.runtime.onStartup.addListener(
  connect
);



/*
 * Popup / content.js 消息
 */
chrome.runtime.onMessage.addListener(
  (
    message,
    sender,
    sendResponse
  ) => {

    (async () => {


      /*
       * ChatGPT content.js
       * → Relay
       */
      if (
        message?.type ===
        "ZHIXING_TO_RELAY"
      ) {

        const settings =
          await getSettings();


        const senderTabId =
          sender.tab?.id ?? null;


        if (
          !settings.targetTabId ||
          senderTabId !== settings.targetTabId
        ) {

          sendResponse({
            ok: false,
            ignored: true,
            error:
              "Message came from an unpinned ChatGPT tab"
          });

          return;

        }


        const result =
          await sendToRelay({
            ...(message.payload || {}),
            tabId: senderTabId
          });


        sendResponse(
          result
        );

        return;

      }



      /*
       * Popup读取状态
       *
       * 你现在“读取失败”
       * 就是因为上一版漏掉了这个分支。
       */
      if (
        message?.type ===
        "ZHIXING_GET_STATUS"
      ) {

        const settings =
          await getSettings();


        const stored =
          await chrome.storage.local.get(
            "bridgeStatus"
          );


        sendResponse({
          ok: true,
          status:
            stored.bridgeStatus ||
            lastStatus,
          settings
        });

        return;

      }



      /*
       * Popup绑定当前 ChatGPT 标签页
       */
      if (
        message?.type ===
        "ZHIXING_PIN_CURRENT_TAB"
      ) {

        const [tab] =
          await chrome.tabs.query({
            active: true,
            currentWindow: true
          });


        if (
          !tab?.id ||
          !isChatGPTUrl(
            tab.url || ""
          )
        ) {

          sendResponse({
            ok: false,
            error:
              "Current tab is not ChatGPT"
          });

          return;

        }


        await chrome.storage.local.set({
          targetTabId: tab.id,
          targetTabTitle:
            tab.title || ""
        });


        sendResponse({
          ok: true,
          targetTabId:
            tab.id,
          targetTabTitle:
            tab.title || ""
        });

        return;

      }



      /*
       * Popup保存设置
       */
      if (
        message?.type ===
        "ZHIXING_UPDATE_SETTINGS"
      ) {

        const patch =
          message.settings || {};


        const current =
          await getSettings();


        const next = {
          ...current,
          ...patch
        };


        await chrome.storage.local.set(
          next
        );


        await disconnect();


        if (next.enabled) {

          await connect();

        }


        sendResponse({
          ok: true,
          settings: next
        });

        return;

      }



      /*
       * Popup“重新连接”
       */
      if (
        message?.type ===
        "ZHIXING_RECONNECT"
      ) {

        await disconnect();

        await connect();


        sendResponse({
          ok: true
        });

        return;

      }



      sendResponse({
        ok: false,
        error:
          "Unknown message type: " +
          String(message?.type)
      });


    })().catch(
      error => {

        console.error(
          "[Zhixing Bridge] runtime message failed:",
          error
        );


        sendResponse({
          ok: false,
          error: String(error)
        });

      }
    );


    return true;

  }
);



/*
 * Service Worker加载时主动连接。
 */
connect();