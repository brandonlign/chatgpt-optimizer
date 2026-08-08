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
  disableAnimations: true
};

const GOAL_KEY_PREFIX = "cgoGoal:";
const version = chrome.runtime.getManifest().version;
document.getElementById("version").textContent = `v${version}`;

const settingInputs = Array.from(document.querySelectorAll("[data-setting]"));
const goalText = document.getElementById("goalText");
const goalEnabled = document.getElementById("goalEnabled");
const goalHint = document.getElementById("goalHint");
const goalScope = document.getElementById("goalScope");

let activeChatId = "";
let activeGoalKey = "";
let goalSaveTimer = null;
let contentScriptReady = false;
let lastContext = null;

function showGoalHint(message, isError = false) {
  goalHint.textContent = message;
  goalHint.classList.toggle("error", isError);
}

function setGoalControlsAvailable(available) {
  goalText.disabled = !available;
  goalEnabled.disabled = !available;
}

function extractChatIdFromUrl(rawUrl) {
  if (!rawUrl) return "";

  try {
    const url = new URL(rawUrl);
    if (url.hostname !== "chatgpt.com" && url.hostname !== "chat.openai.com") return "";
    return url.pathname.match(/\/c\/([^/?#]+)/)?.[1] || "";
  } catch {
    return "";
  }
}

async function getActiveChatContext() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return null;

    let chatId = extractChatIdFromUrl(tab.url || "");
    let response = null;

    try {
      response = await chrome.tabs.sendMessage(tab.id, { type: "CGO_GET_CHAT_CONTEXT" });
    } catch {
      // Existing tabs need one refresh after an extension reload.
    }

    if (!chatId) chatId = response?.chatId || "";
    return {
      chatId,
      contentScriptReady: Boolean(response),
      url: tab.url || "",
      ...(response || {})
    };
  } catch {
    return null;
  }
}

async function readCurrentGoal() {
  if (!activeGoalKey) return { enabled: false, text: "" };
  const stored = await chrome.storage.local.get(activeGoalKey);
  const value = stored[activeGoalKey] || {};
  return {
    enabled: Boolean(value.enabled),
    text: typeof value.text === "string" ? value.text : ""
  };
}

async function writeCurrentGoal(patch) {
  if (!activeGoalKey) return;
  const stored = await chrome.storage.local.get(activeGoalKey);
  const current = stored[activeGoalKey] || {};
  await chrome.storage.local.set({
    [activeGoalKey]: {
      ...current,
      ...patch,
      chatId: activeChatId,
      updatedAt: Date.now()
    }
  });
}

function showCurrentGoalStatus(enabled) {
  if (!contentScriptReady) {
    showGoalHint(
      enabled
        ? "Goal saved. Refresh this ChatGPT tab once to load the Goal engine."
        : "You can set this chat's goal now. Refresh the ChatGPT tab once before running it.",
      true
    );
    return;
  }

  if (enabled && lastContext?.debugState) {
    showGoalHint(`Engine: ${lastContext.debugState}`);
    return;
  }

  showGoalHint(
    enabled
      ? "Active for this chat only."
      : "Set a goal for this chat, then enable it."
  );
}

async function refreshEngineStatus() {
  if (!activeChatId) return;
  const context = await getActiveChatContext();
  if (!context || context.chatId !== activeChatId) return;
  lastContext = context;
  contentScriptReady = Boolean(context.contentScriptReady);
  showCurrentGoalStatus(goalEnabled.checked);
}

async function initialize() {
  const stored = await chrome.storage.sync.get(defaultSettings);
  for (const input of settingInputs) {
    input.checked = Boolean(stored[input.dataset.setting]);
  }

  const context = await getActiveChatContext();
  lastContext = context;
  activeChatId = context?.chatId || "";
  activeGoalKey = activeChatId ? `${GOAL_KEY_PREFIX}${activeChatId}` : "";
  contentScriptReady = Boolean(context?.contentScriptReady);

  if (!activeChatId) {
    goalText.value = "";
    goalEnabled.checked = false;
    setGoalControlsAvailable(false);
    goalScope.textContent = "No saved conversation detected";
    showGoalHint("Open a saved ChatGPT conversation with /c/ in its URL, then set its goal here.", true);
    return;
  }

  setGoalControlsAvailable(true);
  goalScope.textContent = `This chat only · ${activeChatId.slice(0, 8)}…`;
  const currentGoal = await readCurrentGoal();
  goalText.value = currentGoal.text;
  goalEnabled.checked = currentGoal.enabled;
  showCurrentGoalStatus(currentGoal.enabled);

  setInterval(() => void refreshEngineStatus(), 700);
}

for (const input of settingInputs) {
  input.addEventListener("change", () => {
    chrome.storage.sync.set({ [input.dataset.setting]: input.checked });
  });
}

goalText.addEventListener("input", () => {
  clearTimeout(goalSaveTimer);
  goalSaveTimer = setTimeout(() => {
    void writeCurrentGoal({ text: goalText.value.trim() });
  }, 250);
});

goalEnabled.addEventListener("change", async () => {
  const text = goalText.value.trim();

  if (goalEnabled.checked && !text) {
    goalEnabled.checked = false;
    await writeCurrentGoal({ enabled: false, text: "" });
    showGoalHint("Enter a goal before enabling Goal Mode.", true);
    goalText.focus();
    return;
  }

  await writeCurrentGoal({ text, enabled: goalEnabled.checked });
  await refreshEngineStatus();
  showCurrentGoalStatus(goalEnabled.checked);
});

void initialize();
