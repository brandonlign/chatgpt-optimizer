(() => {
  "use strict";

  const version = chrome.runtime.getManifest().version;
  const defaultVisibleLimit = 10;
  const revealBatchSize = 10;
  const turnSelector = '[data-testid^="conversation-turn-"]';
  const root = document.documentElement;
  const GOAL_COMPLETE_MARKER = "[CGO_GOAL_COMPLETE]";
  const GOAL_BLOCKED_MARKER = "[CGO_GOAL_BLOCKED]";
  const goalStableDelayMs = 2200;

  const defaultSettings = {
    hideDuringLoad: true,
    limitVisibleTurns: true,
    autoScroll: true,
    pauseHiddenMedia: true,
    lazyImages: true,
    disableSmoothScroll: true,
    disableBackdropBlur: true,
    disableShadows: true,
    disableTransitions: true,
    disableAnimations: true,
    goalEnabled: false,
    goalText: ""
  };

  let settings = { ...defaultSettings };
  let navigationUrl = location.href;
  let runId = 0;
  let hiddenTurns = [];
  let totalTurns = 0;
  let visibleLimit = defaultVisibleLimit;
  let initialLoadComplete = false;
  let lastKnownCount = 0;
  let lastMaintenanceAt = 0;

  let goalSending = false;
  let goalCandidateKey = "";
  let goalCandidateSignature = "";
  let goalCandidateStableSince = 0;
  let lastPromptedAssistantKey = "";
  let goalKickoffSent = false;

  function isConversationPage() {
    return location.pathname.includes("/c/");
  }

  function getTurns() {
    return Array.from(document.querySelectorAll(turnSelector));
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
    return getTurns().filter((turn) => getTurnRole(turn) === "assistant");
  }

  function getTurnKey(turn, index = 0) {
    if (!turn) return "";
    return (
      turn.getAttribute("data-testid") ||
      turn.getAttribute("data-message-id") ||
      `${index}:${(turn.innerText || turn.textContent || "").slice(0, 120)}`
    );
  }

  function applyPerformanceClasses() {
    const classes = {
      "cgo-disable-smooth-scroll": settings.disableSmoothScroll,
      "cgo-disable-backdrop-blur": settings.disableBackdropBlur,
      "cgo-disable-shadows": settings.disableShadows,
      "cgo-disable-transitions": settings.disableTransitions,
      "cgo-disable-animations": settings.disableAnimations
    };

    for (const [className, enabled] of Object.entries(classes)) {
      root.classList.toggle(className, Boolean(enabled));
    }

    if (!settings.hideDuringLoad) {
      root.classList.remove("cgo-preparing-long-chat");
    }
  }

  function removeStatus() {
    document.getElementById("cgo-long-chat-status")?.remove();
  }

  function revealAllHiddenTurns() {
    for (const turn of document.querySelectorAll(".cgo-hidden-turn")) {
      turn.classList.remove("cgo-hidden-turn");
    }
    hiddenTurns = [];
  }

  function pauseHiddenMedia(turn) {
    if (!settings.pauseHiddenMedia) return;

    for (const media of turn.querySelectorAll("video, audio")) {
      try {
        media.pause();
      } catch {
        // Ignore media elements that cannot be controlled.
      }
    }
  }

  function optimizeVisibleImages(turn) {
    if (!settings.lazyImages) return;

    for (const image of turn.querySelectorAll("img")) {
      image.loading = "lazy";
      image.decoding = "async";
    }
  }

  function findScrollableAncestor(element) {
    let node = element?.parentElement;

    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      const canScroll = /(auto|scroll|overlay)/.test(style.overflowY);

      if (canScroll && node.scrollHeight > node.clientHeight + 8) {
        return node;
      }

      node = node.parentElement;
    }

    return document.scrollingElement;
  }

  function forceScrollToBottom(turn) {
    if (!settings.autoScroll || !turn) return;

    const scroll = () => {
      try {
        turn.scrollIntoView({ behavior: "auto", block: "end", inline: "nearest" });
      } catch {
        turn.scrollIntoView(false);
      }

      const scroller = findScrollableAncestor(turn);
      if (scroller) scroller.scrollTop = scroller.scrollHeight;

      const page = document.scrollingElement;
      if (page) page.scrollTop = page.scrollHeight;
    };

    requestAnimationFrame(() => requestAnimationFrame(scroll));
    setTimeout(scroll, 250);
    setTimeout(scroll, 800);
  }

  function resetGoalTracking() {
    goalSending = false;
    goalCandidateKey = "";
    goalCandidateSignature = "";
    goalCandidateStableSince = 0;
    lastPromptedAssistantKey = "";
    goalKickoffSent = false;
  }

  function resetPageState() {
    runId += 1;
    root.classList.remove("cgo-preparing-long-chat");
    revealAllHiddenTurns();
    removeStatus();
    totalTurns = 0;
    visibleLimit = defaultVisibleLimit;
    initialLoadComplete = false;
    lastKnownCount = 0;
    lastMaintenanceAt = 0;
    resetGoalTracking();
  }

  function updateStatus() {
    if (!document.body || !settings.limitVisibleTurns || !isConversationPage()) {
      removeStatus();
      return;
    }

    let status = document.getElementById("cgo-long-chat-status");
    if (!status) {
      status = document.createElement("div");
      status.id = "cgo-long-chat-status";
      status.setAttribute("role", "status");
      status.setAttribute("aria-label", "ChatGPT Optimizer long-chat mode");

      const label = document.createElement("span");
      label.className = "cgo-status-label";

      const showMore = document.createElement("button");
      showMore.type = "button";
      showMore.textContent = "Show 10 more";
      showMore.addEventListener("click", () => {
        visibleLimit = Number.isFinite(visibleLimit)
          ? visibleLimit + revealBatchSize
          : totalTurns;
        applyConversationOptimizations(getTurns(), false);
      });

      const showAll = document.createElement("button");
      showAll.type = "button";
      showAll.textContent = "Show all";
      showAll.addEventListener("click", () => {
        visibleLimit = Number.POSITIVE_INFINITY;
        applyConversationOptimizations(getTurns(), false);
      });

      const newest = document.createElement("button");
      newest.type = "button";
      newest.textContent = "Newest 10";
      newest.addEventListener("click", () => {
        visibleLimit = defaultVisibleLimit;
        applyConversationOptimizations(getTurns(), true);
      });

      status.append(label, showMore, showAll, newest);
      document.body.appendChild(status);
    }

    const visible = Math.max(0, totalTurns - hiddenTurns.length);
    const label = status.querySelector(".cgo-status-label");
    const buttons = status.querySelectorAll("button");

    label.textContent = hiddenTurns.length > 0
      ? `Optimizer v${version} · newest ${visible} of ${totalTurns}`
      : `Optimizer v${version} · showing all ${totalTurns || ""} turns`;

    buttons[0].hidden = hiddenTurns.length === 0;
    buttons[1].hidden = hiddenTurns.length === 0;
    buttons[2].hidden = hiddenTurns.length > 0 && visible <= defaultVisibleLimit;
  }

  function applyConversationOptimizations(turns, scrollToBottom) {
    totalTurns = turns.length;
    lastKnownCount = turns.length;

    if (settings.limitVisibleTurns) {
      const effectiveLimit = Number.isFinite(visibleLimit)
        ? Math.max(1, visibleLimit)
        : turns.length;
      const hideCount = Math.max(0, turns.length - effectiveLimit);
      hiddenTurns = turns.slice(0, hideCount);

      for (let index = 0; index < turns.length; index += 1) {
        const turn = turns[index];
        const shouldHide = index < hideCount;

        if (shouldHide) {
          if (!turn.classList.contains("cgo-hidden-turn")) pauseHiddenMedia(turn);
          turn.classList.add("cgo-hidden-turn");
        } else {
          turn.classList.remove("cgo-hidden-turn");
          optimizeVisibleImages(turn);
        }
      }
    } else {
      revealAllHiddenTurns();
      for (const turn of turns) optimizeVisibleImages(turn);
    }

    root.classList.remove("cgo-preparing-long-chat");
    initialLoadComplete = true;
    updateStatus();

    if (scrollToBottom) forceScrollToBottom(turns.at(-1));
  }

  function waitForConversation(run) {
    let previousCount = -1;
    let stableSamples = 0;
    let samples = 0;

    const sample = () => {
      if (run !== runId || !isConversationPage()) return;

      const turns = getTurns();
      const count = turns.length;

      stableSamples = count > 0 && count === previousCount ? stableSamples + 1 : 0;
      previousCount = count;
      samples += 1;

      const stableAfterWarmup = samples >= 8 && stableSamples >= 3;
      if ((count > 0 && stableAfterWarmup) || samples >= 30) {
        applyConversationOptimizations(getTurns(), true);
        return;
      }

      setTimeout(sample, 300);
    };

    sample();
  }

  function startForCurrentPage() {
    resetPageState();
    applyPerformanceClasses();

    if (!isConversationPage()) return;

    const run = runId;
    if (settings.hideDuringLoad) {
      root.classList.add("cgo-preparing-long-chat");
    }
    waitForConversation(run);
  }

  function applySettings(nextSettings, { restartConversation = false } = {}) {
    const previousGoalEnabled = settings.goalEnabled;
    const previousGoalText = settings.goalText;
    settings = { ...settings, ...nextSettings };
    applyPerformanceClasses();

    if (previousGoalEnabled !== settings.goalEnabled || previousGoalText !== settings.goalText) {
      resetGoalTracking();
    }

    if (restartConversation) {
      startForCurrentPage();
      return;
    }

    if (isConversationPage() && initialLoadComplete) {
      applyConversationOptimizations(getTurns(), false);
    }
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

  function buildGoalPrompt(isKickoff) {
    const verb = isKickoff ? "Start working autonomously" : "Continue working autonomously";
    return `${verb} toward this goal:\n\n${settings.goalText.trim()}\n\nTake concrete steps now instead of giving only a status update or plan. Keep making progress until the goal is actually complete or you hit a real blocker. If the goal is fully complete, put ${GOAL_COMPLETE_MARKER} on its own final line. If you cannot continue without new information, access, or a user decision, put ${GOAL_BLOCKED_MARKER} on its own final line.`;
  }

  async function waitForSendButton(timeoutMs = 2500) {
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
      const button = findSendButton();
      if (
        button &&
        !button.disabled &&
        button.getAttribute("aria-disabled") !== "true"
      ) {
        return button;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return null;
  }

  async function sendGoalPrompt(isKickoff) {
    if (goalSending || !settings.goalEnabled || !settings.goalText.trim()) return false;
    if (isGenerating()) return false;

    const composer = findComposer();
    if (!composer || readComposerText(composer).trim()) return false;

    goalSending = true;
    try {
      if (!writeComposerText(composer, buildGoalPrompt(isKickoff))) return false;
      const button = await waitForSendButton();
      if (!button || !settings.goalEnabled) return false;
      button.click();
      return true;
    } finally {
      goalSending = false;
    }
  }

  async function stopGoalMode(reason) {
    if (!settings.goalEnabled) return;
    settings.goalEnabled = false;
    resetGoalTracking();

    try {
      await chrome.storage.sync.set({ goalEnabled: false });
    } catch {
      // The local state still stops automation even if sync storage is unavailable.
    }

    console.info(`[ChatGPT Optimizer] Goal Mode stopped: ${reason}`);
  }

  function getAssistantSignature(turn) {
    const text = (turn?.innerText || turn?.textContent || "").trim();
    return `${text.length}:${text.slice(-160)}`;
  }

  async function maybeAdvanceGoal() {
    if (goalSending || !settings.goalEnabled || !settings.goalText.trim()) return;

    if (isGenerating()) {
      goalCandidateStableSince = 0;
      return;
    }

    const turns = getTurns();
    const assistantTurns = turns.filter((turn) => getTurnRole(turn) === "assistant");
    const latestAssistant = assistantTurns.at(-1);

    if (!latestAssistant) {
      if (turns.length > 0 || goalKickoffSent) return;
      const composer = findComposer();
      if (!composer || readComposerText(composer).trim()) return;

      const kickoffKey = `kickoff:${location.pathname}`;
      const now = Date.now();
      if (goalCandidateKey !== kickoffKey) {
        goalCandidateKey = kickoffKey;
        goalCandidateSignature = "";
        goalCandidateStableSince = now;
        return;
      }

      if (now - goalCandidateStableSince < goalStableDelayMs) return;
      if (await sendGoalPrompt(true)) {
        goalKickoffSent = true;
        goalCandidateStableSince = 0;
      }
      return;
    }

    const latestText = (latestAssistant.innerText || latestAssistant.textContent || "").trim();
    if (latestText.includes(GOAL_COMPLETE_MARKER)) {
      await stopGoalMode("goal complete");
      return;
    }
    if (latestText.includes(GOAL_BLOCKED_MARKER)) {
      await stopGoalMode("blocked");
      return;
    }

    const assistantIndex = assistantTurns.length - 1;
    const key = getTurnKey(latestAssistant, assistantIndex);
    if (!key || key === lastPromptedAssistantKey) return;

    const signature = getAssistantSignature(latestAssistant);
    const now = Date.now();
    if (goalCandidateKey !== key || goalCandidateSignature !== signature) {
      goalCandidateKey = key;
      goalCandidateSignature = signature;
      goalCandidateStableSince = now;
      return;
    }

    if (now - goalCandidateStableSince < goalStableDelayMs) return;

    if (await sendGoalPrompt(false)) {
      lastPromptedAssistantKey = key;
      goalCandidateStableSince = 0;
    }
  }

  applyPerformanceClasses();
  if (isConversationPage() && settings.hideDuringLoad) {
    root.classList.add("cgo-preparing-long-chat");
  }

  chrome.storage.sync.get(defaultSettings, (stored) => {
    applySettings(stored, { restartConversation: true });
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;

    const patch = {};
    let performanceChanged = false;

    for (const key of Object.keys(defaultSettings)) {
      if (!(key in changes)) continue;
      patch[key] = changes[key].newValue;
      if (!key.startsWith("goal")) performanceChanged = true;
    }

    if (Object.keys(patch).length > 0) {
      applySettings(patch, { restartConversation: performanceChanged && isConversationPage() });
    }
  });

  setInterval(() => {
    if (location.href !== navigationUrl) {
      navigationUrl = location.href;
      startForCurrentPage();
      return;
    }

    if (!initialLoadComplete || !isConversationPage() || document.hidden) return;

    const now = Date.now();
    if (now - lastMaintenanceAt < 4000) return;
    lastMaintenanceAt = now;

    const turns = getTurns();
    if (turns.length !== lastKnownCount) {
      const addedTurns = turns.length > lastKnownCount;
      applyConversationOptimizations(turns, addedTurns);
    }
  }, 500);

  setInterval(() => {
    void maybeAdvanceGoal();
  }, 750);
})();
