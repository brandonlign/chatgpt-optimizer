(() => {
  "use strict";

  const version = chrome.runtime.getManifest().version;
  const batchSize = 30;
  const turnSelector = '[data-testid^="conversation-turn-"]';

  let navigationUrl = location.href;
  let runId = 0;
  let hiddenTurns = [];
  let totalTurns = 0;

  function isConversationPage() {
    return location.pathname.includes("/c/");
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

  function resetPageState() {
    runId += 1;
    document.documentElement.classList.remove("cgo-preparing-long-chat");
    revealAllHiddenTurns();
    removeStatus();
    totalTurns = 0;
  }

  function updateStatus() {
    if (!document.body) return;

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
      showMore.textContent = "Show 30 more";
      showMore.addEventListener("click", () => {
        const next = hiddenTurns.splice(Math.max(0, hiddenTurns.length - batchSize));
        for (const turn of next) turn.classList.remove("cgo-hidden-turn");
        updateStatus();
      });

      const showAll = document.createElement("button");
      showAll.type = "button";
      showAll.textContent = "Show all";
      showAll.addEventListener("click", () => {
        revealAllHiddenTurns();
        updateStatus();
      });

      status.append(label, showMore, showAll);
      document.body.appendChild(status);
    }

    const visible = Math.max(0, totalTurns - hiddenTurns.length);
    const label = status.querySelector(".cgo-status-label");
    const buttons = status.querySelectorAll("button");

    label.textContent = hiddenTurns.length > 0
      ? `Optimizer v${version} · showing newest ${visible} of ${totalTurns}`
      : `Optimizer v${version} · showing all ${totalTurns || ""} turns`;

    for (const button of buttons) {
      button.hidden = hiddenTurns.length === 0;
    }
  }

  function applyLongChatMode(turns) {
    revealAllHiddenTurns();
    totalTurns = turns.length;

    const hideCount = Math.max(0, turns.length - batchSize);
    hiddenTurns = turns.slice(0, hideCount);

    for (const turn of hiddenTurns) {
      turn.classList.add("cgo-hidden-turn");
    }

    document.documentElement.classList.remove("cgo-preparing-long-chat");
    updateStatus();
  }

  function waitForConversation(run) {
    let previousCount = -1;
    let stableSamples = 0;
    let samples = 0;

    const sample = () => {
      if (run !== runId || !isConversationPage()) return;

      const turns = Array.from(document.querySelectorAll(turnSelector));
      const count = turns.length;

      stableSamples = count > 0 && count === previousCount ? stableSamples + 1 : 0;
      previousCount = count;
      samples += 1;

      if ((count > 0 && stableSamples >= 3) || samples >= 28) {
        applyLongChatMode(Array.from(document.querySelectorAll(turnSelector)));
        return;
      }

      setTimeout(sample, 300);
    };

    sample();
  }

  function startForCurrentPage() {
    resetPageState();

    if (!isConversationPage()) return;

    const run = runId;
    document.documentElement.classList.add("cgo-preparing-long-chat");
    waitForConversation(run);
  }

  if (isConversationPage()) {
    document.documentElement.classList.add("cgo-preparing-long-chat");
  }

  startForCurrentPage();

  setInterval(() => {
    if (location.href === navigationUrl) return;
    navigationUrl = location.href;
    startForCurrentPage();
  }, 1000);
})();
