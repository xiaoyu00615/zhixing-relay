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
let reconnectDelay = 1000;
let lastStatus = {
  connected: false,
  authenticated: false,
  enabled: true,
  relayUrl: DEFAULT_SETTINGS.relayUrl,
  lastError: null,
  lastMessageAt: null
};

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

async function saveStatus(patch) {
  lastStatus = { ...lastStatus, ...patch };
  await chrome.storage.local.set({ bridgeStatus: lastStatus });
}

function isChatGPTUrl(url = "") {
  return url.startsWith("https://chatgpt.com/") ||
    url.startsWith("https://chat.openai.com/");
}

async function sendToTargetTab(message) {
  const settings = await getSettings();

  if (!settings.targetTabId) {
    throw new Error("No ChatGPT tab is pinned. Open the extension and click 'Use current tab'.");
  }

  const tab = await chrome.tabs.get(settings.targetTabId);
  if (!isChatGPTUrl(tab.url || "")) {
    throw new Error("Pinned tab is no longer a ChatGPT page.");
  }

  return chrome.tabs.sendMessage(settings.targetTabId, message);
}

async function sendToRelay(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return { ok: false, error: "Relay WebSocket is not connected" };
  }

  ws.send(JSON.stringify({
    ...payload,
    bridge: "zhixing-relay-extension",
    ts: Date.now()
  }));

  await saveStatus({ lastMessageAt: Date.now() });
  return { ok: true };
}

async function connect() {
  const settings = await getSettings();

  await saveStatus({
    enabled: settings.enabled,
    relayUrl: settings.relayUrl
  });

  if (!settings.enabled) {
    await disconnect();
    return;
  }

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  clearTimeout(reconnectTimer);

  try {
    ws = new WebSocket(settings.relayUrl);
  } catch (error) {
    await saveStatus({ connected: false, authenticated: false, lastError: String(error) });
    scheduleReconnect();
    return;
  }

  ws.onopen = async () => {
    reconnectDelay = 1000;
    await saveStatus({ connected: true, authenticated: false, lastError: null });

    await sendToRelay({
      type: "bridge_hello",
      source: "chrome_extension",
      sharedSecret: settings.relaySharedSecret || "",
      capabilities: [
        "chatgpt.assistant_message",
        "chatgpt.user_message",
        "chatgpt.send_message",
        "chatgpt.pin_single_tab"
      ]
    });

    await saveStatus({ authenticated: true });
  };

  ws.onclose = async (event) => {
    await saveStatus({
      connected: false,
      authenticated: false,
      lastError: event.reason || null
    });
    ws = null;
    scheduleReconnect();
  };

  ws.onerror = async () => {
    await saveStatus({
      connected: false,
      authenticated: false,
      lastError: "WebSocket connection error"
    });
  };

  ws.onmessage = async (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.type === "send_to_chatgpt" && typeof message.text === "string") {
      const settingsNow = await getSettings();

      try {
        await sendToTargetTab({
          type: "ZHIXING_SEND_TO_CHATGPT",
          text: message.text,
          requestId: message.requestId || null,
          autoSend: Boolean(message.autoSend ?? settingsNow.autoSendToChatGPT)
        });
      } catch (error) {
        await sendToRelay({
          type: "chatgpt_send_result",
          requestId: message.requestId || null,
          ok: false,
          error: String(error)
        });
      }
    }
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 15000);
}

async function disconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;

  if (ws) {
    try { ws.close(); } catch {}
  }

  ws = null;
  await saveStatus({ connected: false, authenticated: false });
}

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(DEFAULT_SETTINGS);
  await chrome.storage.local.set({ ...DEFAULT_SETTINGS, ...existing });
  await connect();
});

chrome.runtime.onStartup.addListener(connect);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === "ZHIXING_TO_RELAY") {
      const settings = await getSettings();
      const senderTabId = sender.tab?.id ?? null;

      if (!settings.targetTabId || senderTabId !== settings.targetTabId) {
        sendResponse({ ok: false, ignored: true, error: "Message came from an unpinned ChatGPT tab" });
        return;
      }

      const result = await sendToRelay({
        ...(message.payload || {}),
        tabId: senderTabId
      });
      sendResponse(result);
      return;
    }

    if (message?.type === "ZHIXING_GET_STATUS") {
      const settings = await getSettings();
      const stored = await chrome.storage.local.get("bridgeStatus");

      sendResponse({
        ok: true,
        status: stored.bridgeStatus || lastStatus,
        settings
      });
      return;
    }

    if (message?.type === "ZHIXING_PIN_CURRENT_TAB") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab?.id || !isChatGPTUrl(tab.url || "")) {
        sendResponse({ ok: false, error: "Current tab is not ChatGPT" });
        return;
      }

      await chrome.storage.local.set({
        targetTabId: tab.id,
        targetTabTitle: tab.title || ""
      });

      sendResponse({
        ok: true,
        targetTabId: tab.id,
        targetTabTitle: tab.title || ""
      });
      return;
    }

    if (message?.type === "ZHIXING_UPDATE_SETTINGS") {
      const patch = message.settings || {};
      const current = await getSettings();
      const next = { ...current, ...patch };

      await chrome.storage.local.set(next);
      await disconnect();

      if (next.enabled) {
        await connect();
      }

      sendResponse({ ok: true, settings: next });
      return;
    }

    if (message?.type === "ZHIXING_RECONNECT") {
      await disconnect();
      await connect();
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: "Unknown message type" });
  })().catch((error) => {
    sendResponse({ ok: false, error: String(error) });
  });

  return true;
});

connect();
