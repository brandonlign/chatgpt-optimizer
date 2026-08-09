(() => {
  "use strict";

  const GOAL_KEY_PREFIX = "cgoGoal:";
  const MAX_BLOCKED_DECLARATIONS = 5;
  const BLOCKED_WINDOW_MS = 5 * 60 * 1000;
  const STRICT_POLICY = `\n\nEXTREMELY STRICT CONTINUATION POLICY:\nDo not stop, give up, or declare the goal blocked merely because the current approach failed, a dependency is pending, an external process is still running, information is temporarily unavailable, a tool call failed, access is inconvenient, progress is slow, or the obvious next step cannot be completed immediately. Treat those as reasons to keep working. Retry when reasonable, diagnose the failure, use a different method, work on another productive part of the goal, verify assumptions, inspect available state, prepare the next step, or wait/recheck when waiting is itself the correct action. Exhaust every reasonable autonomous path before considering the goal blocked.\n\nYou may output [CGO_GOAL_BLOCKED] only when there is literally no productive action you can take now, no reasonable workaround or retry remains, no useful independent subtask remains, waiting/rechecking cannot advance the work, and continuing truly requires new information, permission, access, or a decision that only the user can provide. Uncertainty, inconvenience, failure of one approach, or needing time are not blockers. If there is any plausible next action at all, take it instead of stopping.`;

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
      if (!text.includes("[CGO_GOAL_BLOCKED]")) return;

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

  chrome.storage.onChanged.addListener(async (changes, areaName) => {
    if (areaName !== "local") return;

    for (const [key, change] of Object.entries(changes)) {
      if (!key.startsWith(GOAL_KEY_PREFIX)) continue;
      const value = change.newValue;
      if (!value || value.enabled !== false || value.stoppedReason !== "blocked") continue;

      const now = Date.now();
      const previousAt = Number(value.blockedAttemptedAt || 0);
      const previousCount = now - previousAt <= BLOCKED_WINDOW_MS
        ? Number(value.blockedAttemptCount || 0)
        : 0;
      const nextCount = previousCount + 1;

      if (nextCount >= MAX_BLOCKED_DECLARATIONS) {
        await chrome.storage.local.set({
          [key]: {
            ...value,
            blockedAttemptCount: nextCount,
            blockedAttemptedAt: now,
            terminalBlockConfirmed: true,
            updatedAt: now
          }
        });
        console.warn(`[ChatGPT Optimizer] Goal Mode accepted a blocker only after ${nextCount} repeated terminal declarations.`);
        continue;
      }

      await chrome.storage.local.set({
        [key]: {
          ...value,
          enabled: true,
          stoppedReason: "",
          blockedAttemptCount: nextCount,
          blockedAttemptedAt: now,
          terminalBlockConfirmed: false,
          updatedAt: now
        }
      });

      console.warn(`[ChatGPT Optimizer] Rejected blocker declaration ${nextCount}/${MAX_BLOCKED_DECLARATIONS}; Goal Mode will force another attempt.`);
    }
  });
})();
