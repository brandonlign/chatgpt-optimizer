(() => {
  "use strict";

  const defaults = {
    reduceBlur: true,
    optimizeSidebar: true,
    reduceAnimations: false,
    reduceShadows: false
  };

  const root = document.documentElement;

  function applySettings(settings) {
    root.classList.toggle("cgo-no-blur", Boolean(settings.reduceBlur));
    root.classList.toggle("cgo-sidebar", Boolean(settings.optimizeSidebar));
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

  refreshSettings();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;

    const relevantChange = Object.keys(changes).some((key) => key in defaults);
    if (relevantChange) refreshSettings();
  });
})();
