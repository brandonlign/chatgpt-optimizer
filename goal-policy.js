(() => {
  "use strict";

  const GOAL_KEY_PREFIX = "cgoGoal:";
  const MAX_BLOCKED_DECLARATIONS = 8;
  const MAX_COMPLETE_DECLARATIONS = 3;
  const CONFIRMATION_WINDOW_MS = 5 * 60 * 1000;
  const STRICT_POLICY = `\n\nEXTREMELY STRICT CONTINUATION POLICY:\nDo not stop, give up, declare the goal blocked, or declare the goal complete prematurely. The default assumption is that there is still something useful to do. A failed approach, pending dependency, external process still running, temporary lack of information, tool failure, slow progress, uncertainty, inconvenience, or an obvious next step being unavailable are NOT reasons to stop. Retry when reasonable, diagnose the failure, use a different method, work on another productive part of the goal, verify assumptions, inspect available state, prepare future steps, or wait/recheck when waiting is itself the correct action. Exhaust every reasonable autonomous path before considering any terminal state.\n\nYou may output [CGO_GOAL_COMPLETE] only when every material requirement of the stated goal is actually satisfied and there is no meaningful validation, cleanup, verification, follow-up, or remaining work needed to make the result genuinely complete.\n\nYou may output [CGO_GOAL_BLOCKED] only when there is literally no productive action you can take now, no reasonable workaround or retry remains, no useful independent subtask remains, waiting/rechecking cannot advance the work, and continuing truly requires new information, permission, access, or a decision that only the user can provide. If there is any plausible next action at all, take it instead of stopping.`;

  function readText(element) {
    if (!element) return "";
    if ("value" in element) return element.value || "";
    return element.innerText || element.textContent || "";
  }

  function writeText(element, text) {
    if (!element) return;

    if ("value" in element) {
      const proto = element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(element, text);
      else element.value = text;
    } else {
      element.textContent = text;
    }
  }

  document.addEventListener(
    "input",
    (event) => {
      const composer = event.target instanceof Element ? event.target : null;
      if (!composer || composer.dataset.cgoStrictPolicyApplied === "1") return;

      const text = readText(composer);
      if (!text.startsWith("Continue working autonomously toward this goal:")) return;
      if (!text.includes("[CGO_GOAL_BLOCKED]") && !text.includes("[CGO_GOAL_COMPLETE]")) return;

      composer.dataset.cgoStrictPolicyApplied = "1";
      const marker = "If the goal is fully complete";
      const insertionPoint = text.indexOf(marker);
      const hardened = insertionPoint >= 0
        ? `${text.slice(0, insertionPoint)}${STRICT_POLICY}\n\n${text.slice(insertionPoint)}`
        : `${text}${STRICT_POLICY}`;

      writeText(composer, hardened);
    },
    true
  );

  async function rejectOrConfirmTerminalState(key, value, kind) {
    const isBlocked = kind === "blocked";
    const countKey = isBlocked ? "blockedAttemptCount" : "completeAttemptCount";
    const atKey = isBlocked ? "blockedAttemptedAt" : "completeAttemptedAt";
    const confirmedKey = isBlocked ? "terminalBlockConfirmed" : "terminalCompleteConfirmed";
    const maxDeclarations = isBlocked ? MAX_BLOCKED_DECLARATIONS : MAX_COMPLETE_DECLARATIONS;

    const now = Date.now();
    const previousAt = Number(value[atKey] || 0);
    const previousCount = now - previousAt <= CONFIRMATION_WINDOW_MS
      ? Number(value[countKey] || 0)
      : 0;
    const nextCount = previousCount + 1;

    if (nextCount >= maxDeclarations) {
      await chrome.storage.local.set({
        [key]: {
          ...value,
          [countKey]: nextCount,
          [atKey]: now,
          [confirmedKey]: true,
          updatedAt: now
        }
      });
      console.warn(`[ChatGPT Optimizer] Goal Mode accepted ${kind} only after ${nextCount} repeated terminal declarations.`);
      return;
    }

    await chrome.storage.local.set({
      [key]: {
        ...value,
        enabled: true,
        stoppedReason: "",
        [countKey]: nextCount,
        [atKey]: now,
        [confirmedKey]: false,
        updatedAt: now
      }
    });

    console.warn(`[ChatGPT Optimizer] Rejected ${kind} declaration ${nextCount}/${maxDeclarations}; Goal Mode will force another attempt.`);
  }

  chrome.storage.onChanged.addListener(async (changes, areaName) => {
    if (areaName !== "local") return;

    for (const [key, change] of Object.entries(changes)) {
      if (!key.startsWith(GOAL_KEY_PREFIX)) continue;
      const value = change.newValue;
      if (!value || value.enabled !== false) continue;

      if (value.stoppedReason === "blocked") {
        await rejectOrConfirmTerminalState(key, value, "blocked");
      } else if (value.stoppedReason === "goal complete") {
        await rejectOrConfirmTerminalState(key, value, "goal complete");
      }
    }
  });
})();
