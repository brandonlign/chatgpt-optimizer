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

const version = chrome.runtime.getManifest().version;
document.getElementById("version").textContent = `v${version}`;

const settingInputs = Array.from(document.querySelectorAll("[data-setting]"));
const goalText = document.getElementById("goalText");
const goalEnabled = document.getElementById("goalEnabled");
const goalHint = document.getElementById("goalHint");
let goalSaveTimer = null;

function showGoalHint(message, isError = false) {
  goalHint.textContent = message;
  goalHint.classList.toggle("error", isError);
}

chrome.storage.sync.get(defaultSettings, (stored) => {
  for (const input of settingInputs) {
    input.checked = Boolean(stored[input.dataset.setting]);
  }

  goalText.value = stored.goalText || "";
  goalEnabled.checked = Boolean(stored.goalEnabled);
  showGoalHint(
    goalEnabled.checked
      ? "Goal Mode is active. It will keep continuing this goal after completed replies."
      : "When enabled, ChatGPT is prompted again after each completed reply."
  );
});

for (const input of settingInputs) {
  input.addEventListener("change", () => {
    chrome.storage.sync.set({ [input.dataset.setting]: input.checked });
  });
}

goalText.addEventListener("input", () => {
  clearTimeout(goalSaveTimer);
  goalSaveTimer = setTimeout(() => {
    chrome.storage.sync.set({ goalText: goalText.value.trim() });
  }, 250);
});

goalEnabled.addEventListener("change", () => {
  const text = goalText.value.trim();

  if (goalEnabled.checked && !text) {
    goalEnabled.checked = false;
    chrome.storage.sync.set({ goalEnabled: false });
    showGoalHint("Enter a goal before enabling Goal Mode.", true);
    goalText.focus();
    return;
  }

  chrome.storage.sync.set({ goalText: text, goalEnabled: goalEnabled.checked });
  showGoalHint(
    goalEnabled.checked
      ? "Goal Mode is active. It will auto-stop if ChatGPT marks the goal complete or blocked."
      : "When enabled, ChatGPT is prompted again after each completed reply."
  );
});
