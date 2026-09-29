const relayStatus = document.getElementById("relayStatus");
const tabStatus = document.getElementById("tabStatus");
const enabled = document.getElementById("enabled");
const relayUrl = document.getElementById("relayUrl");
const relaySharedSecret = document.getElementById("relaySharedSecret");
const autoSendToChatGPT = document.getElementById("autoSendToChatGPT");
const pinTab = document.getElementById("pinTab");
const save = document.getElementById("save");
const reconnect = document.getElementById("reconnect");
const message = document.getElementById("message");

function showMessage(text, ok = true) {
  message.textContent = text;
  message.className = `message ${ok ? "ok" : "bad"}`;
}

async function load() {
  const result = await chrome.runtime.sendMessage({ type: "ZHIXING_GET_STATUS" });

  if (!result?.ok) {
    relayStatus.textContent = "读取失败";
    relayStatus.className = "bad";
    return;
  }

  const { status, settings } = result;

  enabled.checked = Boolean(settings.enabled);
  relayUrl.value = settings.relayUrl || "ws://127.0.0.1:8787";
  relaySharedSecret.value = settings.relaySharedSecret || "";
  autoSendToChatGPT.checked = Boolean(settings.autoSendToChatGPT);

  relayStatus.textContent = status.connected ? "已连接" : "未连接";
  relayStatus.className = status.connected ? "ok" : "bad";

  tabStatus.textContent = settings.targetTabId
    ? (settings.targetTabTitle || `Tab ${settings.targetTabId}`)
    : "未绑定";

  tabStatus.className = settings.targetTabId ? "ok" : "bad";

  if (status.lastError) {
    showMessage(status.lastError, false);
  }
}

pinTab.addEventListener("click", async () => {
  const result = await chrome.runtime.sendMessage({ type: "ZHIXING_PIN_CURRENT_TAB" });

  if (result?.ok) {
    showMessage("已绑定当前 ChatGPT 标签页");
    await load();
  } else {
    showMessage(result?.error || "绑定失败", false);
  }
});

save.addEventListener("click", async () => {
  const result = await chrome.runtime.sendMessage({
    type: "ZHIXING_UPDATE_SETTINGS",
    settings: {
      enabled: enabled.checked,
      relayUrl: relayUrl.value.trim(),
      relaySharedSecret: relaySharedSecret.value,
      autoSendToChatGPT: autoSendToChatGPT.checked
    }
  });

  if (result?.ok) {
    showMessage("设置已保存");
    setTimeout(load, 400);
  } else {
    showMessage(result?.error || "保存失败", false);
  }
});

reconnect.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "ZHIXING_RECONNECT" });
  showMessage("已请求重新连接");
  setTimeout(load, 600);
});

load();
