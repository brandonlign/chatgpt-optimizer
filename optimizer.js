(() => {
  "use strict";

  const version = chrome.runtime.getManifest().version;
  const defaultVisibleLimit = 10;
  const revealBatchSize = 10;
  const turnSelector = '[data-testid^="conversation-turn-"]';
  const root = document.documentElement;

  let navigationUrl = location.href;
  let runId = 0;
  let hiddenTurns = [];
  let totalTurns = 0;
  let visibleLimit = defaultVisibleLimit;
  let initialLoadComplete = false;
  let lastKnownCount = 0;
  let lastMaintenanceAt = 0;

  root.classList.add("cgo-max-performance");

  function isConversationPage() {
    return location.pathname.includes("/c/");
  }

  function getTurns() {
    return Array.from(document.querySelectorAll(turnSelector));
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
    for (const media of turn.querySelectorAll("video, audio")) {
      try {
        media.pause();
      } catch {
        // Ignore media elements that cannot be controlled.
      }
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
    if (!turn) return;

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
      showMore.textContent = "Show 10 more";
      showMore.addEventListener("click", () => {
        visibleLimit = Number.isFinite(visibleLimit)
          ? visibleLimit + revealBatchSize
          : totalTurns;
        trimToVisibleLimit(getTurns(), false);
      });

      const showAll = document.createElement("button");
      showAll.type = "button";
      showAll.textContent = "Show all";
      showAll.addEventListener("click", () => {
        visibleLimit = Number.POSITIVE_INFINITY;
        trimToVisibleLimit(getTurns(), false);
      });

      const newest = document.createElement("button");
      newest.type = "button";
      newest.textContent = "Newest 10";
      newest.addEventListener("click", () => {
        visibleLimit = defaultVisibleLimit;
        trimToVisibleLimit(getTurns(), true);
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

  function trimToVisibleLimit(turns, scrollToBottom) {
    totalTurns = turns.length;
    lastKnownCount = turns.length;

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

        for (const image of turn.querySelectorAll("img")) {
          image.loading = "lazy";
          image.decoding = "async";
        }
      }
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
        trimToVisibleLimit(getTurns(), true);
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
    root.classList.add("cgo-preparing-long-chat");
    waitForConversation(run);
  }

  if (isConversationPage()) {
    root.classList.add("cgo-preparing-long-chat");
  }

  startForCurrentPage();

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
      trimToVisibleLimit(turns, addedTurns);
    }
  }, 500);
})();
