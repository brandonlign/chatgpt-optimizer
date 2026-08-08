(() => {
  "use strict";

  const GOAL_COMPLETE_MARKER = "[CGO_GOAL_COMPLETE]";
  const GOAL_BLOCKED_MARKER = "[CGO_GOAL_BLOCKED]";
  const GOAL_KEY_PREFIX = "cgoGoal:";
  const LEASE_KEY_PREFIX = "cgoGoalLease:";
  const stableDelayMs = 2200;
  const leaseDurationMs = 7000;
  const instanceId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;

  let currentChatId = getConversationId();
  let goal = { enabled: false, text: "" };
  let goalSending = false;
  let candidateKey = "";
  let candidateSignature = "";
  let candidateStableSince = 0;
  let lastPromptedAssistantKey = "";
  let loadedGoalKey = "";

  // Disable the v2.0.0 legacy global Goal Mode. Chat-specific Goal Mode below
  // is the only continuation engine from v2.0.1 onward.
  void chrome.storage.sync.set({ goalEnabled: false, goalText: "" });

  function getConversationId() {
    const match = location.pathname.match(/\/c\/([^/?#]+)/);
    return match?.[1] || "";
  }

  function goalKey(chatId) {
    return `${GOAL_KEY_PREFIX}${chatId}`;
  }

  function leaseKey(chatId) {
    return `${LEASE_KEY_PREFIX}${chatId}`;
  }

  function resetTracking() {
    goalSending = false;
    candidateKey = "";
    candidateSignature = "";
    candidateStableSince = 0;
    lastPromptedAssistantKey = "";
  }

  async function loadGoalForCurrentChat() {
    const chatId = getConversationId();
    currentChatId = chatId;
    resetTracking();

    if (!chatId) {
      loadedGoalKey = "";
      goal = { enabled: false, text: "" };
      return;
    }

    const key = goalKey(chatId);
    loadedGoalKey = key;
    const stored = await chrome.storage.local.get(key);
    const value = stored[key] || {};

    // Ignore a stale async read if SPA navigation moved to another chat.
    if (chatId !== getConversationId()) return;

    goal = {
      enabled: Boolean(value.enabled),
      text: typeof value.text === "string" ? value.text : ""
    };
  }

  function getTurns() {
    return Array.from(document.querySelectorAll('[data-testid^="conversation-turn-"]'));
  }

  function getTurnRole(turn) {
    if (!turn) return "";
    return (
      turn.getAttribute("data-message-author-role") ||
      turn.querySelector("[data-message-author-role]")?.getAttribute("data-message-author-role") ||
      ""
    );
  }

  function getTurnKey(turn, index = 0) {
    if (!turn) return "";
    return (
      turn.getAttribute("data-testid") ||
      turn.getAttribute("data-message-id") ||
      `${index}:${(turn.innerText || turn.textContent || "").slice(0, 120)}`
    );
  }

  function getAssistantSignature(turn) {
    const text = (turn?.innerText || turn?.textContent || "").trim();
    return `${text.length}:${text.slice(-160)}`;
  }

  function isGenerating() {
    return Boolean(
      document.querySelector(
        '[data-testid="stop-button"], button[aria-label*="Stop generating" i], button[aria-label*="Stop streaming" i]'
      )
    );
  }

  function findComposer() {
    const selectors = [
      "#prompt-textarea",
      'textarea[data-testid="prompt-textarea"]',
      '[contenteditable="true"][data-testid="composer-input"]'
    ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) return element;
    }

    return null;
  }

  function readComposerText(composer) {
    if (!composer) return "";
    if ("value" in composer) return composer.value || "";
    return composer.innerText || composer.textContent || "";
  }

  function writeComposerText(composer, text) {
    if (!composer) return false;
    composer.focus();

    if ("value" in composer) {
      const prototype = composer instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(composer, text);
      else composer.value = text;
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      composer.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    let inserted = false;
    try {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(composer);
      selection.removeAllRanges();
      selection.addRange(range);
      inserted = document.execCommand("insertText", false, text);
      selection.removeAllRanges();
    } catch {
      inserted = false;
    }

    if (!inserted) {
      composer.textContent = text;
      try {
        composer.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            inputType: "insertText",
            data: text
          })
        );
      } catch {
        composer.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }

    return true;
  }

  function findSendButton() {
    const selectors = [
      '[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]'
    ];

    for (const selector of selectors) {
      const button = document.querySelector(selector);
      if (button) return button;
    }

    return null;
  }

  function buildGoalPrompt() {
    return `Continue working autonomously toward this goal:\n\n${goal.text.trim()}\n\nTake concrete steps now instead of giving only a status update or plan. Keep making progress until the goal is actually complete or you hit a real blocker. If the goal is fully complete, put ${GOAL_COMPLETE_MARKER} on its own final line. If you cannot continue without new information, access, or a user decision, put ${GOAL_BLOCKED_MARKER} on its own final line.`;
  }

  async function waitForSendButton(timeoutMs = 2500) {
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
      const button = findSendButton();
      if (button && !button.disabled && button.getAttribute("aria-disabled") !== "true") {
        return button;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return null;
  }

  async function acquireLease(chatId) {
    if (!chatId) return false;
    const key = leaseKey(chatId);
    const now = Date.now();
    const existing = (await chrome.storage.local.get(key))[key];

    if (existing && existing.owner !== instanceId && Number(existing.expiresAt) > now) {
      return false;
    }

    const mine = { owner: instanceId, expiresAt: now + leaseDurationMs };
    await chrome.storage.local.set({ [key]: mine });
    const confirmed = (await chrome.storage.local.get(key))[key];
    return confirmed?.owner === instanceId;
  }

  async function releaseLease(chatId) {
    if (!chatId) return;
    const key = leaseKey(chatId);
    const existing = (await chrome.storage.local.get(key))[key];
    if (existing?.owner === instanceId) {
      await chrome.storage.local.remove(key);
    }
  }

  async function sendGoalPrompt() {
    const chatId = getConversationId();
    if (
      goalSending ||
      !chatId ||
      chatId !== currentChatId ||
      !goal.enabled ||
      !goal.text.trim() ||
      document.hidden ||
      isGenerating()
    ) {
      return false;
    }

    if (!(await acquireLease(chatId))) return false;

    goalSending = true;
    try {
      // Re-check everything after the async lease claim.
      if (chatId !== getConversationId() || !goal.enabled || document.hidden || isGenerating()) {
        return false;
      }

      const composer = findComposer();
      if (!composer || readComposerText(composer).trim()) return false;
      if (!writeComposerText(composer, buildGoalPrompt())) return false;

      const button = await waitForSendButton();
      if (
        !button ||
        !goal.enabled ||
        chatId !== getConversationId() ||
        document.hidden
      ) {
        return false;
      }

      button.click();
      return true;
    } finally {
      goalSending = false;
      await releaseLease(chatId);
    }
  }

  async function stopCurrentGoal(reason) {
    const chatId = getConversationId();
    if (!chatId || chatId !== currentChatId || !goal.enabled) return;

    goal = { ...goal, enabled: false };
    resetTracking();
    const key = goalKey(chatId);
    const stored = (await chrome.storage.local.get(key))[key] || {};
    await chrome.storage.local.set({
      [key]: {
        ...stored,
        enabled: false,
        stoppedReason: reason,
        updatedAt: Date.now()
      }
    });
    console.info(`[ChatGPT Optimizer] Goal Mode stopped for ${chatId}: ${reason}`);
  }

  async function maybeAdvanceGoal() {
    const chatId = getConversationId();
    if (
      goalSending ||
      !chatId ||
      chatId !== currentChatId ||
      !goal.enabled ||
      !goal.text.trim() ||
      document.hidden
    ) {
      return;
    }

    if (isGenerating()) {
      candidateStableSince = 0;
      return;
    }

    const assistantTurns = getTurns().filter((turn) => getTurnRole(turn) === "assistant");
    const latestAssistant = assistantTurns.at(-1);
    if (!latestAssistant) return;

    const latestText = (latestAssistant.innerText || latestAssistant.textContent || "").trim();
    if (latestText.includes(GOAL_COMPLETE_MARKER)) {
      await stopCurrentGoal("goal complete");
      return;
    }
    if (latestText.includes(GOAL_BLOCKED_MARKER)) {
      await stopCurrentGoal("blocked");
      return;
    }

    const key = getTurnKey(latestAssistant, assistantTurns.length - 1);
    if (!key || key === lastPromptedAssistantKey) return;

    const signature = getAssistantSignature(latestAssistant);
    const now = Date.now();
    if (candidateKey !== key || candidateSignature !== signature) {
      candidateKey = key;
      candidateSignature = signature;
      candidateStableSince = now;
      return;
    }

    if (now - candidateStableSince < stableDelayMs) return;

    if (await sendGoalPrompt()) {
      lastPromptedAssistantKey = key;
      candidateStableSince = 0;
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "CGO_GET_CHAT_CONTEXT") return false;
    sendResponse({
      chatId: getConversationId(),
      pathname: location.pathname,
      title: document.title
    });
    return false;
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !loadedGoalKey || !(loadedGoalKey in changes)) return;
    const value = changes[loadedGoalKey].newValue || {};
    goal = {
      enabled: Boolean(value.enabled),
      text: typeof value.text === "string" ? value.text : ""
    };
    resetTracking();
  });

  void loadGoalForCurrentChat();

  setInterval(() => {
    const chatId = getConversationId();
    if (chatId !== currentChatId) {
      void loadGoalForCurrentChat();
      return;
    }
    void maybeAdvanceGoal();
  }, 750);
})();
