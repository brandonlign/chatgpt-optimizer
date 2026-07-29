(() => {
  "use strict";

  const defaults = {
    reduceBlur: false,
    reduceAnimations: false,
    reduceShadows: false
  };

  const root = document.documentElement;

  function mountIndicator() {
    if (!document.body || document.getElementById("cgo-extension-indicator")) return;

    const indicator = document.createElement("div");
    indicator.id = "cgo-extension-indicator";
    indicator.setAttribute("role", "status");
    indicator.setAttribute("aria-label", "ChatGPT Optimizer is active");

    const dot = document.createElement("span");
    dot.className = "cgo-indicator-dot";

    const label = document.createElement("span");
    label.textContent = `Optimizer v${chrome.runtime.getManifest().version}`;

    indicator.append(dot, label);
    document.body.appendChild(indicator);
  }

  function applySettings(settings) {
    root.classList.toggle("cgo-no-blur", Boolean(settings.reduceBlur));
    root.classList.toggle("cgo-reduce-motion", Boolean(settings.reduceAnimations));
    root.classList.toggle("cgo-no-shadows", Boolean(settings.reduceShadows));
  }

  async function refreshSettings() {
    try {
      const settings = await chrome.storage.local.get(defaults);
      applySettings(settings);
    } catch {
      applySettings(defaults);
    }
  }

  if (document.body) {
    mountIndicator();
  } else {
    window.addEventListener("DOMContentLoaded", mountIndicator, { once: true });
  }

  refreshSettings();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;

    const relevantChange = Object.keys(changes).some((key) => key in defaults);
    if (relevantChange) refreshSettings();
  });
})();
