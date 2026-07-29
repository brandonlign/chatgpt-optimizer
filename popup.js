const defaults = {
  reduceBlur: false,
  reduceAnimations: false,
  reduceShadows: false
};

const ids = Object.keys(defaults);
const status = document.getElementById("status");
const version = document.getElementById("version");
let statusTimer;

version.textContent = `v${chrome.runtime.getManifest().version}`;

async function loadSettings() {
  const settings = await chrome.storage.local.get(defaults);

  for (const id of ids) {
    document.getElementById(id).checked = Boolean(settings[id]);
  }
}

async function saveSetting(event) {
  const input = event.currentTarget;
  await chrome.storage.local.set({ [input.id]: input.checked });

  status.textContent = "Saved";
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    status.textContent = "";
  }, 900);
}

for (const id of ids) {
  document.getElementById(id).addEventListener("change", saveSetting);
}

loadSettings().catch(() => {
  status.textContent = "Could not load settings";
});
