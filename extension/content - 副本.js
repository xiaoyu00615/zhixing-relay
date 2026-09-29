(() => {
  if (window.__ZHIXING_RELAY_BRIDGE_LOADED__) return;
  window.__ZHIXING_RELAY_BRIDGE_LOADED__ = true;

  const state = {
    lastAssistantFingerprint: null,
    lastUserFingerprint: null,
    pendingSend: false,
    initialized: false
  };

  const normalizeText = (text) =>
    (text || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

  const fingerprint = (role, text) => {
    let hash = 2166136261;
    const input = `${role}:${text}`;

    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }

    return `${role}:${(hash >>> 0).toString(16)}:${text.length}`;
  };

  function sendToRelay(payload) {
    chrome.runtime.sendMessage({
      type: "ZHIXING_TO_RELAY",
      payload
    }).catch(() => {});
  }

  function extractRole(article) {
    const direct = article.getAttribute("data-message-author-role");
    if (direct === "assistant" || direct === "user") return direct;

    const child = article.querySelector("[data-message-author-role]");
    const nested = child?.getAttribute("data-message-author-role");
    if (nested === "assistant" || nested === "user") return nested;

    const label = (article.getAttribute("aria-label") || "").toLowerCase();
    if (label.includes("assistant") || label.includes("chatgpt")) return "assistant";
    if (label.includes("you") || label.includes("user")) return "user";

    return null;
  }

  function extractText(article) {
    const candidates = [
      article.querySelector("[data-message-author-role]"),
      article.querySelector(".markdown"),
      article.querySelector("[class*='markdown']"),
      article
    ];

    for (const node of candidates) {
      const text = normalizeText(node?.innerText || "");
      if (text) return text;
    }

    return "";
  }

  function isStreaming() {
    return [
      'button[data-testid="stop-button"]',
      'button[aria-label*="Stop"]',
      'button[aria-label*="停止"]'
    ].some((selector) => document.querySelector(selector));
  }

  function scanMessages() {
    const articles = Array.from(document.querySelectorAll("article"));
    if (!articles.length) return;

    let latestAssistant = null;
    let latestUser = null;

    for (const article of articles) {
      const role = extractRole(article);
      if (!role) continue;

      const text = extractText(article);
      if (!text) continue;

      if (role === "assistant") latestAssistant = { text };
      if (role === "user") latestUser = { text };
    }

    if (latestUser) {
      const fp = fingerprint("user", latestUser.text);

      if (!state.initialized) {
        state.lastUserFingerprint = fp;
      } else if (fp !== state.lastUserFingerprint) {
        state.lastUserFingerprint = fp;

        sendToRelay({
          type: "chatgpt_user_message",
          text: latestUser.text,
          fingerprint: fp,
          pageUrl: location.href,
          title: document.title
        });
      }
    }

    if (latestAssistant) {
      const fp = fingerprint("assistant", latestAssistant.text);

      if (!state.initialized) {
        state.lastAssistantFingerprint = fp;
      } else if (fp !== state.lastAssistantFingerprint && !isStreaming()) {
        state.lastAssistantFingerprint = fp;

        sendToRelay({
          type: "chatgpt_assistant_message",
          text: latestAssistant.text,
          fingerprint: fp,
          pageUrl: location.href,
          title: document.title
        });
      }
    }

    state.initialized = true;
  }

  function findComposer() {
    for (const selector of [
      '#prompt-textarea',
      'textarea[data-testid="prompt-textarea"]',
      '[contenteditable="true"][data-lexical-editor="true"]',
      '[contenteditable="true"][role="textbox"]'
    ]) {
      const element = document.querySelector(selector);
      if (element) return element;
    }
    return null;
  }

  function setComposerText(element, text) {
    element.focus();

    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      const prototype = element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;

      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      setter?.call(element, text);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    if (element.isContentEditable) {
      element.textContent = "";
      element.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "deleteContentBackward",
        data: null
      }));

      document.execCommand("insertText", false, text);

      element.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text
      }));
    }
  }

  function findSendButton() {
    for (const selector of [
      'button[data-testid="send-button"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="发送"]'
    ]) {
      const button = document.querySelector(selector);
      if (button && !button.disabled) return button;
    }
    return null;
  }

  async function waitFor(predicate, timeoutMs = 5000, stepMs = 100) {
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
      const value = predicate();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, stepMs));
    }

    return null;
  }

  async function injectMessage(text, autoSend, requestId) {
    if (state.pendingSend) {
      sendToRelay({
        type: "chatgpt_send_result",
        requestId,
        ok: false,
        error: "A ChatGPT send operation is already in progress"
      });
      return;
    }

    state.pendingSend = true;

    try {
      const composer = await waitFor(findComposer, 5000);
      if (!composer) throw new Error("ChatGPT composer was not found");

      setComposerText(composer, text);

      if (!autoSend) {
        sendToRelay({
          type: "chatgpt_send_result",
          requestId,
          ok: true,
          sent: false,
          staged: true
        });
        return;
      }

      const sendButton = await waitFor(findSendButton, 3000);

      if (sendButton) {
        sendButton.click();
      } else {
        composer.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          bubbles: true,
          cancelable: true
        }));

        composer.dispatchEvent(new KeyboardEvent("keyup", {
          key: "Enter",
          code: "Enter",
          bubbles: true,
          cancelable: true
        }));
      }

      sendToRelay({
        type: "chatgpt_send_result",
        requestId,
        ok: true,
        sent: true,
        staged: false
      });
    } catch (error) {
      sendToRelay({
        type: "chatgpt_send_result",
        requestId,
        ok: false,
        error: String(error)
      });
    } finally {
      state.pendingSend = false;
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "ZHIXING_SEND_TO_CHATGPT") {
      injectMessage(
        String(message.text || ""),
        Boolean(message.autoSend),
        message.requestId || null
      );
    }
  });

  const observer = new MutationObserver(() => {
    clearTimeout(observer.__timer);
    observer.__timer = setTimeout(scanMessages, 500);
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true
  });

  window.addEventListener("focus", scanMessages);
  setTimeout(scanMessages, 1500);

  sendToRelay({
    type: "chatgpt_page_ready",
    pageUrl: location.href,
    title: document.title
  });
})();
