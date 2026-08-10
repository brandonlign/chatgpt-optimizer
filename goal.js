(() => {
  "use strict";

  const GOAL_COMPLETE_MARKER = "[CGO_GOAL_COMPLETE]";
  const GOAL_BLOCKED_MARKER = "[CGO_GOAL_BLOCKED]";
  const GOAL_KEY_PREFIX = "cgoGoal:";
  const LEASE_KEY_PREFIX = "cgoGoalLease:";
  const STABLE_DELAY_MS = 2500;
  const WATCHDOG_MS = 500;
  const LEASE_DURATION_MS = 10000;
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
  let debugState = "starting";

  function setDebug(state) {
    if (debugState === state) return;
    debugState = state;
    console.info(`[ChatGPT Optimizer] Goal Mode: ${state}`);
  }

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
  }

  async function loadGoalForCurrentChat() {
    const chatId = getConversationId();
    currentChatId = chatId;
    resetTracking();

    if (!chatId) {
      loadedGoalKey = "";
      goal = { enabled: false, text: "" };
      setDebug("not a saved chat");
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
    setDebug(goal.enabled ? "enabled" : "disabled");
  }

  function uniqueElements(elements) {
    const seen = new Set();
    return elements.filter((element) => {
      if (!element || seen.has(element)) return false;
      seen.add(element);
      return true;
    });
  }

  function getTurns() {
    const current = Array.from(document.querySelectorAll("[data-turn]"));
    if (current.length) return current;

    const legacy = Array.from(document.querySelectorAll('[data-testid^="conversation-turn-"]'));
    if (legacy.length) return legacy;

    return Array.from(document.querySelectorAll("main article"));
  }

  function getTurnRole(turn) {
    if (!turn) return "";

    const dataTurn = (turn.getAttribute("data-turn") || "").toLowerCase();
    if (dataTurn === "assistant" || dataTurn === "user") return dataTurn;

    const direct = (turn.getAttribute("data-message-author-role") || "").toLowerCase();
    if (direct === "assistant" || direct === "user") return direct;

    const nestedRole = turn.querySelector("[data-message-author-role]")?.getAttribute("data-message-author-role")?.toLowerCase();
    if (nestedRole === "assistant" || nestedRole === "user") return nestedRole;

    if (turn.querySelector('[data-message-author-role="assistant"]')) return "assistant";
    if (turn.querySelector('[data-message-author-role="user"]')) return "user";
    return "";
  }

  function getAssistantTurns() {
    const turns = getTurns().filter((turn) => getTurnRole(turn) === "assistant");
    if (turns.length) return turns;

    const recovered = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]')).map(
      (node) => node.closest('[data-turn], [data-testid^="conversation-turn-"], article') || node
    );
    return uniqueElements(recovered);
  }

  function latestRoleInDocument() {
    const roleNodes = Array.from(
      document.querySelectorAll('[data-turn="user"], [data-turn="assistant"], [data-message-author-role="user"], [data-message-author-role="assistant"]')
    );
    const last = roleNodes.at(-1);
    if (!last) return "";

    const dataTurn = (last.getAttribute("data-turn") || "").toLowerCase();
    if (dataTurn === "assistant" || dataTurn === "user") return dataTurn;

    const role = (last.getAttribute("data-message-author-role") || "").toLowerCase();
    if (role === "assistant" || role === "user") return role;

    return getTurnRole(last.closest('[data-turn], [data-testid^="conversation-turn-"], article') || last);
  }

  function assistantIsLatest(latestAssistant) {
    const role = latestRoleInDocument();
    if (role) return role === "assistant";

    const turns = getTurns();
    const latestTurn = turns.at(-1);
    if (!latestTurn || !latestAssistant) return false;
    const latestTurnRole = getTurnRole(latestTurn);
    if (latestTurnRole) return latestTurnRole === "assistant";

    return latestTurn === latestAssistant || latestTurn.contains(latestAssistant) || latestAssistant.contains(latestTurn);
  }

  function getTurnKey(turn, index = 0) {
    if (!turn) return "";
    return (
      turn.getAttribute("data-message-id") ||
      turn.querySelector("[data-message-id]")?.getAttribute("data-message-id") ||
      turn.getAttribute("data-testid") ||
      turn.getAttribute("data-turn") ||
      `${index}:${(turn.innerText || turn.textContent || "").slice(0, 180)}`
    );
  }

  function getSignature(turn) {
    const text = (turn?.innerText || turn?.textContent || "").trim();
    return `${text.length}:${text.slice(-260)}`;
  }

  function isGenerating() {
    return Boolean(document.querySelector(STOP_SELECTOR));
  }

  function findComposer() {
    const selectors = [
      "div#prompt-textarea.ProseMirror",
      "#prompt-textarea",
      'textarea[data-testid="prompt-textarea"]',
      'textarea[data-id="root"]',
      'div[contenteditable="true"][data-id]',
      '[contenteditable="true"][data-testid="composer-input"]',
      '.ProseMirror[contenteditable="true"]'
    ];

    for (const selector of selectors) {
      const candidates = Array.from(document.querySelectorAll(selector));
      const visible = candidates.find((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      if (visible) return visible;
      if (candidates[0]) return candidates[0];
    }
    return null;
  }

  function readComposerText(composer) {
    if (!composer) return "";
    if ("value" in composer) return composer.value || "";
    return composer.innerText || composer.textContent || "";
  }

  function dispatchInput(composer, text) {
    try {
      composer.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        cancelable: false,
        inputType: "insertText",
        data: text
      }));
    } catch {
      composer.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  async function writeComposerText(composer, text) {
    if (!composer) return false;
    composer.focus();

    if ("value" in composer) {
      const prototype = composer instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(composer, text);
      else composer.value = text;
      dispatchInput(composer, text);
      composer.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
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
        composer.replaceChildren(document.createTextNode(text));
        dispatchInput(composer, text);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 120));
    const written = readComposerText(composer).trim();
    return written.length > 0 && written.includes(text.trim().slice(0, 24));
  }

  function findSendButton(composer) {
    const selectors = [
      'button[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]',
      'button[aria-label^="Send" i]',
      'form button[type="submit"]'
    ];

    const form = composer?.closest("form");
    const scopes = form ? [form, document] : [document];

    for (const scope of scopes) {
      for (const selector of selectors) {
        const buttons = Array.from(scope.querySelectorAll(selector));
        const usable = buttons.find((button) => {
          const rect = button.getBoundingClientRect();
          return !button.disabled && button.getAttribute("aria-disabled") !== "true" && rect.width > 0 && rect.height > 0;
        });
        if (usable) return usable;
      }
    }
    return null;
  }

  function buildGoalPrompt() {
    return `Continue working autonomously toward this goal:\n\n${goal.text.trim()}\n\nTake concrete steps now instead of giving only a status update or plan. Keep making progress until the goal is actually complete or you hit a real blocker. If the goal is fully complete, put ${GOAL_COMPLETE_MARKER} on its own final line. If you cannot continue without new information, access, or a user decision, put ${GOAL_BLOCKED_MARKER} on its own final line.`;
  }

  async function waitForSubmission(composer, previousUserCount, timeoutMs = 1800) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const userCount = document.querySelectorAll('[data-turn="user"], [data-message-author-role="user"]').length;
      if (isGenerating() || userCount > previousUserCount || !readComposerText(composer).trim()) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  function dispatchEnter(composer) {
    const options = {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true
    };
    composer.dispatchEvent(new KeyboardEvent("keydown", options));
    composer.dispatchEvent(new KeyboardEvent("keyup", options));
  }

  async function submitComposer(composer) {
    const previousUserCount = document.querySelectorAll('[data-turn="user"], [data-message-author-role="user"]').length;

    const button = findSendButton(composer);
    if (button) {
      button.click();
      if (await waitForSubmission(composer, previousUserCount)) return true;
    }

    const form = composer.closest("form");
    if (form && typeof form.requestSubmit === "function") {
      try {
        form.requestSubmit();
        if (await waitForSubmission(composer, previousUserCount)) return true;
      } catch {
        // Fall through to keyboard submission.
      }
    }

    dispatchEnter(composer);
    return await waitForSubmission(composer, previousUserCount, 2500);
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
    if (sending || !chatId || chatId !== currentChatId || !goal.enabled || !goal.text.trim() || isGenerating()) {
      return false;
    }

    const composer = findComposer();
    if (!composer) {
      setDebug("idle, but composer not found");
      return false;
    }
    if (readComposerText(composer).trim()) {
      setDebug("paused: composer contains your draft");
      return false;
    }
    if (!(await acquireLease(chatId))) {
      setDebug("waiting: another tab owns this chat");
      return false;
    }

    sending = true;
    try {
      if (chatId !== getConversationId() || !goal.enabled || isGenerating()) return false;

      const prompt = buildGoalPrompt();
      setDebug("writing continuation into composer");
      if (!(await writeComposerText(composer, prompt))) {
        setDebug("failed to write into composer");
        return false;
      }

      setDebug("submitting continuation");
      if (!(await submitComposer(composer))) {
        setDebug("text inserted, but submit failed");
        return false;
      }

      setDebug("continuation sent");
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
    setDebug(`stopped: ${reason}`);
  }

  async function maybeAdvanceGoal() {
    const chatId = getConversationId();
    if (sending || !chatId || chatId !== currentChatId || !goal.enabled || !goal.text.trim()) return;

    if (isGenerating()) {
      lastGenerating = true;
      candidateStableSince = 0;
      setDebug("waiting for ChatGPT to finish");
      return;
    }

    if (lastGenerating) {
      lastGenerating = false;
      candidateKey = "";
      candidateSignature = "";
      candidateStableSince = 0;
    }

    const assistantTurns = getAssistantTurns();
    const latestAssistant = assistantTurns.at(-1);
    if (!latestAssistant) {
      setDebug("idle, but no assistant turn found");
      return;
    }
    if (!assistantIsLatest(latestAssistant)) {
      setDebug("waiting: latest turn is not assistant");
      return;
    }

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
    const signature = getSignature(latestAssistant);
    if (!key || !signature) return;
    if (key === lastPromptedAssistantKey) {
      setDebug("waiting for next assistant reply");
      return;
    }

    const now = Date.now();
    if (candidateKey !== key || candidateSignature !== signature) {
      candidateKey = key;
      candidateSignature = signature;
      candidateStableSince = now;
      setDebug("assistant reply settling");
      return;
    }

    if (!candidateStableSince) candidateStableSince = now;
    if (now - candidateStableSince < STABLE_DELAY_MS) return;

    const composer = findComposer();
    if (!composer) {
      setDebug("idle, but composer not found");
      return;
    }
    if (readComposerText(composer).trim()) {
      setDebug("paused: composer contains your draft");
      return;
    }

    setDebug("idle; continuing goal now");
    if (await sendGoalPrompt()) {
      lastPromptedAssistantKey = key;
      candidateStableSince = 0;
    }
  }

  function kickWatchdog() {
    setTimeout(() => void maybeAdvanceGoal(), 50);
    setTimeout(() => void maybeAdvanceGoal(), STABLE_DELAY_MS + 200);
  }

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const button = target?.closest("button");
    if (!button) return;
    const label = `${button.getAttribute("aria-label") || ""} ${button.getAttribute("data-testid") || ""} ${button.textContent || ""}`.toLowerCase();
    if (button.matches(STOP_SELECTOR) || label.includes("stop")) {
      candidateKey = "";
      candidateSignature = "";
      candidateStableSince = 0;
      kickWatchdog();
    }
  }, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "CGO_GET_CHAT_CONTEXT") return false;
    const assistantTurns = getAssistantTurns();
    const composer = findComposer();
    sendResponse({
      chatId: getConversationId(),
      pathname: location.pathname,
      title: document.title,
      goalEnabled: goal.enabled,
      generating: isGenerating(),
      debugState,
      turnCount: getTurns().length,
      assistantTurnCount: assistantTurns.length,
      latestRole: latestRoleInDocument(),
      composerFound: Boolean(composer),
      composerHasText: Boolean(readComposerText(composer).trim())
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
    setDebug(goal.enabled ? "enabled; checking chat" : "disabled");
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
