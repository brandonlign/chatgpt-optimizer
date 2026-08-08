(() => {
  "use strict";

  const GOAL_COMPLETE_MARKER = "[CGO_GOAL_COMPLETE]";
  const GOAL_BLOCKED_MARKER = "[CGO_GOAL_BLOCKED]";
  const GOAL_KEY_PREFIX = "cgoGoal:";
  const LEASE_KEY_PREFIX = "cgoGoalLease:";
  const STABLE_DELAY_MS = 2500;
  const LEASE_DURATION_MS = 8000;
  const WATCHDOG_MS = 500;
  const instanceId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;

  const STOP_SELECTOR = [
    '[data-testid="stop-button"]',
    'button[data-testid*="stop" i]',
    'button[aria-label*="Stop generating" i]',
    'button[aria-label*="Stop streaming" i]',
    'button[aria-label="Stop" i]'
  ].join(", ");

  let currentChatId = "";
  let loadedGoalKey = "";
  let goal = { enabled: false, text: "" };
  let sending = false;
  let candidateKey = "";
  let candidateSignature = "";
  let candidateStableSince = 0;
  let lastPromptedAssistantKey = "";
  let lastGenerating = false;
  let manualStopSeen = false;

  function getConversationId() {
    return location.pathname.match(/\/c\/([^/?#]+)/)?.[1] || "";
  }

  function goalKey(chatId) {
    return `${GOAL_KEY_PREFIX}${chatId}`;
  }

  function leaseKey(chatId) {
    return `${LEASE_KEY_PREFIX}${chatId}`;
  }

  function resetTracking() {
    sending = false;
    candidateKey = "";
    candidateSignature = "";
    candidateStableSince = 0;
    lastPromptedAssistantKey = "";
    lastGenerating = false;
    manualStopSeen = false;
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

  function getAssistantTurns() {
    const turns = getTurns();
    const matched = turns.filter((turn) => getTurnRole(turn) === "assistant");
    if (matched.length) return matched;

    const recovered = [];
    const seen = new Set();
    for (const node of document.querySelectorAll('[data-message-author-role="assistant"]')) {
      const turn = node.closest('[data-testid^="conversation-turn-"]') || node;
      if (!seen.has(turn)) {
        seen.add(turn);
        recovered.push(turn);
      }
    }
    return recovered;
  }

  function assistantIsLatest(latestAssistant) {
    const turns = getTurns();
    const latestTurn = turns.at(-1);
    if (!latestTurn || !latestAssistant) return false;

    const role = getTurnRole(latestTurn);
    if (role) return role === "assistant";

    return (
      latestTurn === latestAssistant ||
      latestTurn.contains(latestAssistant) ||
      latestAssistant.contains(latestTurn)
    );
  }

  function getTurnKey(turn, index = 0) {
    if (!turn) return "";
    return (
      turn.getAttribute("data-message-id") ||
      turn.querySelector("[data-message-id]")?.getAttribute("data-message-id") ||
      turn.getAttribute("data-testid") ||
      `${index}:${(turn.innerText || turn.textContent || "").slice(0, 160)}`
    );
  }

  function getSignature(turn) {
    const text = (turn?.innerText || turn?.textContent || "").trim();
    return `${text.length}:${text.slice(-240)}`;
  }

  function isGenerating() {
    return Boolean(document.querySelector(STOP_SELECTOR));
  }

  function findComposer() {
    const selectors = [
      "#prompt-textarea",
      'textarea[data-testid="prompt-textarea"]',
      '[contenteditable="true"][data-testid="composer-input"]',
      '.ProseMirror[contenteditable="true"]'
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

    try {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(composer);
      selection.removeAllRanges();
      selection.addRange(range);
      const inserted = document.execCommand("insertText", false, text);
      selection.removeAllRanges();
      if (inserted) return true;
    } catch {
      // Fall through to direct contenteditable update.
    }

    composer.textContent = text;
    try {
      composer.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text
      }));
    } catch {
      composer.dispatchEvent(new Event("input", { bubbles: true }));
    }
    return true;
  }

  function findSendButton(composer) {
    const scopes = [];
    const form = composer?.closest("form");
    if (form) scopes.push(form);
    const composerArea = composer?.closest('[data-testid*="composer" i]');
    if (composerArea && composerArea !== form) scopes.push(composerArea);
    scopes.push(document);

    const selectors = [
      '[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]',
      'button[aria-label^="Send" i]',
      'button[type="submit"]'
    ];

    for (const scope of scopes) {
      for (const selector of selectors) {
        const button = scope.querySelector(selector);
        if (button) return button;
      }
    }
    return null;
  }

  function buildGoalPrompt() {
    return `Continue working autonomously toward this goal:\n\n${goal.text.trim()}\n\nTake concrete steps now instead of giving only a status update or plan. Keep making progress until the goal is actually complete or you hit a real blocker. If the goal is fully complete, put ${GOAL_COMPLETE_MARKER} on its own final line. If you cannot continue without new information, access, or a user decision, put ${GOAL_BLOCKED_MARKER} on its own final line.`;
  }

  async function waitForSendButton(composer, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const button = findSendButton(composer);
      if (button && !button.disabled && button.getAttribute("aria-disabled") !== "true") return button;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  }

  async function acquireLease(chatId) {
    const key = leaseKey(chatId);
    const now = Date.now();
    const current = (await chrome.storage.local.get(key))[key];
    if (current && current.owner !== instanceId && Number(current.expiresAt) > now) return false;

    await chrome.storage.local.set({
      [key]: { owner: instanceId, expiresAt: now + LEASE_DURATION_MS }
    });
    const confirmed = (await chrome.storage.local.get(key))[key];
    return confirmed?.owner === instanceId;
  }

  async function releaseLease(chatId) {
    const key = leaseKey(chatId);
    const current = (await chrome.storage.local.get(key))[key];
    if (current?.owner === instanceId) await chrome.storage.local.remove(key);
  }

  async function sendGoalPrompt() {
    const chatId = getConversationId();
    if (
      sending || !chatId || chatId !== currentChatId || !goal.enabled ||
      !goal.text.trim() || isGenerating()
    ) return false;

    const composer = findComposer();
    if (!composer || readComposerText(composer).trim()) return false;
    if (!(await acquireLease(chatId))) return false;

    sending = true;
    try {
      if (chatId !== getConversationId() || !goal.enabled || isGenerating()) return false;
      if (readComposerText(composer).trim()) return false;
      if (!writeComposerText(composer, buildGoalPrompt())) return false;

      const button = await waitForSendButton(composer);
      if (!button || !goal.enabled || chatId !== getConversationId() || isGenerating()) return false;
      button.click();
      return true;
    } finally {
      sending = false;
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
      [key]: { ...stored, enabled: false, stoppedReason: reason, updatedAt: Date.now() }
    });
  }

  async function maybeAdvanceGoal() {
    const chatId = getConversationId();
    if (
      sending || !chatId || chatId !== currentChatId || !goal.enabled || !goal.text.trim()
    ) return;

    const generating = isGenerating();
    if (generating) {
      lastGenerating = true;
      candidateStableSince = 0;
      return;
    }

    if (lastGenerating) {
      lastGenerating = false;
      candidateKey = "";
      candidateSignature = "";
      candidateStableSince = Date.now();
    }

    const assistantTurns = getAssistantTurns();
    const latestAssistant = assistantTurns.at(-1);
    if (!latestAssistant || !assistantIsLatest(latestAssistant)) return;

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

    const signature = getSignature(latestAssistant);
    const now = Date.now();
    if (candidateKey !== key || candidateSignature !== signature) {
      candidateKey = key;
      candidateSignature = signature;
      candidateStableSince = now;
      return;
    }

    if (!candidateStableSince) candidateStableSince = now;
    if (now - candidateStableSince < STABLE_DELAY_MS) return;

    const composer = findComposer();
    if (!composer || readComposerText(composer).trim()) return;

    if (await sendGoalPrompt()) {
      lastPromptedAssistantKey = key;
      candidateStableSince = 0;
      manualStopSeen = false;
    }
  }

  function kickWatchdog() {
    setTimeout(() => void maybeAdvanceGoal(), 50);
    setTimeout(() => void maybeAdvanceGoal(), STABLE_DELAY_MS + 150);
  }

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const button = target?.closest("button");
    if (!button) return;
    const label = `${button.getAttribute("aria-label") || ""} ${button.getAttribute("data-testid") || ""} ${button.textContent || ""}`.toLowerCase();
    if (button.matches(STOP_SELECTOR) || label.includes("stop")) {
      manualStopSeen = true;
      candidateKey = "";
      candidateSignature = "";
      candidateStableSince = 0;
      kickWatchdog();
    }
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isGenerating()) {
      manualStopSeen = true;
      kickWatchdog();
    }
  }, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "CGO_GET_CHAT_CONTEXT") return false;
    sendResponse({
      chatId: getConversationId(),
      pathname: location.pathname,
      title: document.title,
      goalEnabled: goal.enabled,
      generating: isGenerating(),
      idle: !isGenerating(),
      manualStopSeen
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
    kickWatchdog();
  });

  void chrome.storage.sync.set({ goalEnabled: false, goalText: "" });
  void loadGoalForCurrentChat().then(kickWatchdog);

  setInterval(() => {
    const chatId = getConversationId();
    if (chatId !== currentChatId) {
      void loadGoalForCurrentChat().then(kickWatchdog);
      return;
    }
    void maybeAdvanceGoal();
  }, WATCHDOG_MS);
})();
