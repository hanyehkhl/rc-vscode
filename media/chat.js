/* global acquireVsCodeApi */
const vscode = acquireVsCodeApi();

const THINKING_LEVELS = [
  { id: "off", label: "Think off" },
  { id: "low", label: "Think low" },
  { id: "medium", label: "Think medium" },
  { id: "hard", label: "Think hard" }
];

const MODES = [
  { id: "ask", label: "Chat" },
  { id: "write", label: "Agent" },
  { id: "auto", label: "Agent (Full Access)" }
];

const SLASH_COMMANDS = [
  { name: "/search", description: "Toggle web search" },
  { name: "/thinking", description: "Cycle thinking: off, low, medium, hard" },
  { name: "/token", description: "Set DeepSeek token" },
  { name: "/exit", description: "Close panel" },
  { name: "/quit", description: "Close panel" }
];

const input = document.getElementById("promptInput");
const sendButton = document.getElementById("sendButton");
const sendIcon = document.getElementById("sendIcon");
const stopIcon = document.getElementById("stopIcon");
const messages = document.getElementById("messages");
const emptyState = document.getElementById("emptyState");
const picker = document.getElementById("picker");
const modeLabel = document.getElementById("modeLabel");
const modeButton = document.getElementById("modeButton");
const modeDropdown = document.getElementById("modeDropdown");
const searchChip = document.getElementById("searchChip");
const thinkingChip = document.getElementById("thinkingChip");
const thinkingLabel = document.getElementById("thinkingLabel");
const thinkingDropdown = document.getElementById("thinkingDropdown");
const tokenChip = document.getElementById("tokenChip");
const attachButton = document.getElementById("attachButton");
const newChatButton = document.getElementById("newChatButton");
const threadLabel = document.getElementById("threadLabel");
const statusHint = document.getElementById("statusHint");
const tokenSetup = document.getElementById("tokenSetup");
const chatApp = document.getElementById("chatApp");
const tokenInput = document.getElementById("tokenInput");
const saveTokenButton = document.getElementById("saveTokenButton");
const openBrowserButton = document.getElementById("openBrowserButton");
const tokenSetupStatus = document.getElementById("tokenSetupStatus");
const deepseekUrl = document.getElementById("deepseekUrl");
const tokenCommand = document.getElementById("tokenCommand");
const tokenPath = document.getElementById("tokenPath");
const tokenSetupTitle = document.getElementById("tokenSetupTitle");
const tokenLead = document.getElementById("tokenLead");

let modeIndex = 1;
let searchEnabled = false;
let thinkingEffort = "off";
let busy = false;
let stopping = false;
let ignoreNextResult = false;
let emptyCtrlC = false;
let pickerEntries = [];
let pickerIndex = 0;
let pickerKind = null;
const history = [];

function persistState() {
  vscode.setState({
    modeIndex,
    searchEnabled,
    thinkingEffort
  });
}

function currentThinking() {
  return THINKING_LEVELS.find((level) => level.id === thinkingEffort) || THINKING_LEVELS[0];
}

function setThinkingEffort(id) {
  const level = THINKING_LEVELS.find((item) => item.id === id);
  if (!level) return;
  thinkingEffort = level.id;
  updateChrome();
  persistState();
  statusHint.textContent = level.label;
  thinkingDropdown.classList.add("hidden");
}

function cycleThinking() {
  const index = THINKING_LEVELS.findIndex((level) => level.id === thinkingEffort);
  const next = THINKING_LEVELS[(index + 1) % THINKING_LEVELS.length];
  setThinkingEffort(next.id);
}

function currentMode() {
  return MODES[modeIndex];
}

function updateChrome() {
  const mode = currentMode();
  const thinking = currentThinking();
  modeLabel.textContent = mode.label;
  searchChip.textContent = searchEnabled ? "Search on" : "Search off";
  searchChip.classList.toggle("on", searchEnabled);
  if (thinkingLabel) {
    thinkingLabel.textContent = thinking.label;
  } else {
    thinkingChip.textContent = thinking.label;
  }
  thinkingChip.classList.toggle("on", thinkingEffort !== "off");
  document.querySelectorAll(".mode-option").forEach((el) => {
    el.classList.toggle("active", el.getAttribute("data-mode") === mode.id);
  });
  document.querySelectorAll(".thinking-option").forEach((el) => {
    el.classList.toggle("active", el.getAttribute("data-thinking") === thinkingEffort);
  });
}

function hideEmpty() {
  if (emptyState) {
    emptyState.classList.add("hidden");
  }
}

function showEmpty() {
  if (emptyState && !messages.querySelector(".message")) {
    emptyState.classList.remove("hidden");
  }
}

function appendMessage(role, text) {
  hideEmpty();
  const line = document.createElement("div");
  line.className =
    "message " +
    (role === "you"
      ? "message-user"
      : role === "error"
        ? "message-error"
        : role === "status"
          ? "message-status"
          : "message-assistant");

  if (role === "assistant" || role === "rc") {
    const roleEl = document.createElement("span");
    roleEl.className = "message-role";
    roleEl.textContent = "RC";
    line.appendChild(roleEl);
  }

  line.appendChild(document.createTextNode(text));
  messages.appendChild(line);
  messages.scrollTop = messages.scrollHeight;
  return line;
}

function clearStatus() {
  messages.querySelectorAll(".message-status").forEach((node) => node.remove());
}

function setBusy(next) {
  busy = next;
  if (!next) {
    stopping = false;
  }
  sendButton.disabled = false;
  sendButton.classList.toggle("stop-btn", next);
  sendButton.title = next ? "Stop" : "Send";
  sendButton.setAttribute("aria-label", next ? "Stop" : "Send");
  if (sendIcon) sendIcon.classList.toggle("hidden", next);
  if (stopIcon) stopIcon.classList.toggle("hidden", !next);
  input.focus();
}

function cancelRun() {
  if (!busy) return;
  stopping = true;
  vscode.postMessage({ type: "cancelPrompt" });
  statusHint.textContent = "Stopping…";
  const line = messages.querySelector(".message-status");
  if (line) {
    line.textContent = "Stopping…";
  }
}

function cycleMode() {
  modeIndex = (modeIndex + 1) % MODES.length;
  updateChrome();
  persistState();
  statusHint.textContent = "Mode: " + currentMode().label;
}

function setModeById(id) {
  const index = MODES.findIndex((mode) => mode.id === id);
  if (index >= 0) {
    modeIndex = index;
    updateChrome();
    persistState();
    statusHint.textContent = "Mode: " + currentMode().label;
  }
  modeDropdown.classList.add("hidden");
}

function mentionQuery(value) {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(value);
  return match ? match[1] : undefined;
}

function slashCommandQuery(value) {
  const match = /^\/([^\s]*)$/.exec(value.trim());
  return match ? match[1] : undefined;
}

function hidePicker() {
  pickerKind = null;
  pickerEntries = [];
  pickerIndex = 0;
  picker.classList.add("hidden");
  picker.innerHTML = "";
}

function renderPicker() {
  if (!pickerEntries.length) {
    picker.innerHTML = "<div class='picker-empty'>No matches</div>";
    picker.classList.remove("hidden");
    return;
  }

  picker.innerHTML = "";
  pickerEntries.forEach((entry, index) => {
    const row = document.createElement("div");
    row.className = "picker-item" + (index === pickerIndex ? " active" : "");
    row.textContent = typeof entry === "string" ? entry : entry.name + " — " + entry.description;
    row.addEventListener("mousedown", (event) => {
      event.preventDefault();
      pickerIndex = index;
      acceptPicker();
    });
    picker.appendChild(row);
  });
  picker.classList.remove("hidden");
}

function requestFileList(query) {
  pickerKind = "file";
  vscode.postMessage({ type: "listFiles", query: query || "" });
}

function showCommandPicker(query) {
  pickerKind = "command";
  const q = (query || "").toLowerCase();
  pickerEntries = SLASH_COMMANDS.filter((command) => command.name.slice(1).includes(q));
  pickerIndex = 0;
  renderPicker();
}

function acceptPicker() {
  if (!pickerEntries.length) {
    hidePicker();
    return;
  }

  const selected = pickerEntries[pickerIndex];
  if (pickerKind === "file") {
    const file = selected;
    const value = input.value;
    if (/(?:^|\s)@[^\s@]*$/.test(value)) {
      input.value = value.replace(/@[^\s@]*$/, "@" + file + (file.endsWith("/") ? "" : " "));
    } else {
      input.value = value + (value && !/\s$/.test(value) ? " " : "") + "@" + file + " ";
    }
    hidePicker();
    input.focus();
    return;
  }

  if (pickerKind === "command") {
    input.value = selected.name;
    hidePicker();
    runSlashOrSend();
  }
}

function refreshPickerFromInput() {
  const value = input.value;
  const mention = mentionQuery(value);
  if (mention !== undefined) {
    requestFileList(mention);
    return;
  }

  const slash = slashCommandQuery(value);
  if (slash !== undefined) {
    showCommandPicker(slash);
    return;
  }

  hidePicker();
}

function showTokenSetup(message) {
  if (tokenSetupTitle) {
    tokenSetupTitle.textContent = message.title || "Sign in to continue";
  }
  if (tokenLead) {
    tokenLead.textContent =
      message.lead ||
      "RC needs a DeepSeek token (same flow as the rc CLI).";
  }
  if (deepseekUrl) deepseekUrl.textContent = message.url || "";
  if (tokenCommand) tokenCommand.textContent = message.command || "";
  if (tokenPath) tokenPath.textContent = message.path || "";
  if (tokenSetupStatus) {
    tokenSetupStatus.textContent = "";
    tokenSetupStatus.className = "token-setup-status";
  }
  if (tokenInput) tokenInput.value = "";
  tokenSetup.classList.remove("hidden");
  chatApp.classList.add("hidden");
  tokenInput.focus();
}

function showChatApp() {
  tokenSetup.classList.add("hidden");
  chatApp.classList.remove("hidden");
  input.focus();
}

function resetChat() {
  if (busy) {
    ignoreNextResult = true;
    cancelRun();
    setBusy(false);
  }
  history.length = 0;
  messages.querySelectorAll(".message").forEach((node) => node.remove());
  clearStatus();
  showEmpty();
  threadLabel.textContent = "New chat";
  statusHint.textContent = "Local · TAB changes mode";
  input.value = "";
  hidePicker();
  input.focus();
}

function closePanel() {
  vscode.postMessage({ type: "close" });
}

function runSlashOrSend() {
  const text = (input.value || "").trim();
  if (!text || busy) return;

  const command = text.toLowerCase();
  if (command === "/search") {
    input.value = "";
    hidePicker();
    searchEnabled = !searchEnabled;
    updateChrome();
    persistState();
    statusHint.textContent = searchEnabled ? "Search on" : "Search off";
    return;
  }
  if (command === "/thinking" || command.startsWith("/thinking ")) {
    input.value = "";
    hidePicker();
    const arg = command.slice("/thinking".length).trim();
    if (arg && THINKING_LEVELS.some((level) => level.id === arg)) {
      setThinkingEffort(arg);
    } else {
      cycleThinking();
    }
    return;
  }
  if (command === "/token") {
    input.value = "";
    hidePicker();
    vscode.postMessage({ type: "requestTokenSetup", reason: "missing" });
    return;
  }
  if (command === "/exit" || command === "/quit") {
    input.value = "";
    hidePicker();
    closePanel();
    return;
  }

  sendPrompt();
}

function sendPrompt(preset) {
  const text = (preset || input.value || "").trim();
  if (!text || busy) return;

  hidePicker();
  clearStatus();
  appendMessage("you", text);
  threadLabel.textContent = text.length > 42 ? text.slice(0, 42) + "…" : text;

  const historyPayload = history.slice(-8);
  history.push({ role: "user", content: text });

  input.value = "";
  emptyCtrlC = false;
  ignoreNextResult = false;
  setBusy(true);
  statusHint.textContent = currentMode().id === "ask" ? "Thinking…" : "Working…";

  vscode.postMessage({
    type: "sendPrompt",
    text: text,
    mode: currentMode().id,
    search: searchEnabled,
    thinking: thinkingEffort !== "off",
    thinkingEffort: thinkingEffort,
    history: historyPayload
  });
}

function handleSendOrStop() {
  if (busy) {
    cancelRun();
    return;
  }
  runSlashOrSend();
}

sendButton.addEventListener("click", handleSendOrStop);
attachButton.addEventListener("click", () => {
  if (!/@[^\s@]*$/.test(input.value)) {
    input.value += (input.value && !/\s$/.test(input.value) ? " @" : "@");
  }
  input.focus();
  refreshPickerFromInput();
});

modeButton.addEventListener("click", (event) => {
  event.stopPropagation();
  thinkingDropdown.classList.add("hidden");
  modeDropdown.classList.toggle("hidden");
});

document.querySelectorAll(".mode-option").forEach((el) => {
  el.addEventListener("click", () => setModeById(el.getAttribute("data-mode")));
});

document.addEventListener("click", () => {
  modeDropdown.classList.add("hidden");
  thinkingDropdown.classList.add("hidden");
});

searchChip.addEventListener("click", () => {
  searchEnabled = !searchEnabled;
  updateChrome();
  persistState();
});

thinkingChip.addEventListener("click", (event) => {
  event.stopPropagation();
  modeDropdown.classList.add("hidden");
  thinkingDropdown.classList.toggle("hidden");
});

document.querySelectorAll(".thinking-option").forEach((el) => {
  el.addEventListener("click", (event) => {
    event.stopPropagation();
    setThinkingEffort(el.getAttribute("data-thinking"));
  });
});

tokenChip.addEventListener("click", () => {
  vscode.postMessage({ type: "requestTokenSetup", reason: "missing" });
});

newChatButton.addEventListener("click", resetChat);

document.querySelectorAll(".suggestion").forEach((el) => {
  el.addEventListener("click", () => {
    sendPrompt(el.getAttribute("data-prompt") || el.textContent);
  });
});

saveTokenButton.addEventListener("click", () => {
  const token = (tokenInput.value || "").trim();
  if (!token) {
    tokenSetupStatus.textContent = "Paste a token first.";
    tokenSetupStatus.className = "token-setup-status err";
    return;
  }
  tokenSetupStatus.textContent = "Saving…";
  tokenSetupStatus.className = "token-setup-status";
  vscode.postMessage({ type: "saveToken", token: token });
});

openBrowserButton.addEventListener("click", () => {
  vscode.postMessage({ type: "openDeepSeek" });
});

tokenInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    saveTokenButton.click();
  }
});

input.addEventListener("input", () => {
  emptyCtrlC = false;
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
  refreshPickerFromInput();
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Tab") {
    event.preventDefault();
    if (pickerKind && pickerEntries.length) {
      acceptPicker();
      return;
    }
    cycleMode();
    return;
  }

  if (event.ctrlKey && (event.key === "c" || event.key === "C")) {
    event.preventDefault();
    if (busy) {
      cancelRun();
      return;
    }
    if ((input.value || "").length > 0 || pickerKind) {
      input.value = "";
      hidePicker();
      emptyCtrlC = true;
      return;
    }
    if (emptyCtrlC) {
      closePanel();
      return;
    }
    emptyCtrlC = true;
    statusHint.textContent = "Press Ctrl+C again to close";
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    if (busy) {
      cancelRun();
      return;
    }
    if (pickerKind) {
      hidePicker();
    }
    return;
  }

  if (pickerKind && pickerEntries.length) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      pickerIndex = (pickerIndex + 1) % pickerEntries.length;
      renderPicker();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      pickerIndex = (pickerIndex - 1 + pickerEntries.length) % pickerEntries.length;
      renderPicker();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      acceptPicker();
      return;
    }
  }

  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    runSlashOrSend();
  }
});

document.addEventListener("keydown", (event) => {
  if (!busy) return;
  if (event.key === "Escape") {
    event.preventDefault();
    cancelRun();
  }
});

window.addEventListener("message", (event) => {
  const message = event.data || {};

  if (message.type === "tokenSetup") {
    setBusy(false);
    showTokenSetup(message);
    return;
  }

  if (message.type === "tokenSaved") {
    tokenSetupStatus.textContent = message.text || "Signed in.";
    tokenSetupStatus.className = "token-setup-status ok";
    setTimeout(() => {
      showChatApp();
      statusHint.textContent = message.text || "Signed in. You can start chatting.";
    }, 350);
    return;
  }

  if (message.type === "tokenSaveError") {
    tokenSetupStatus.textContent = message.text || "Could not save token.";
    tokenSetupStatus.className = "token-setup-status err";
    return;
  }

  if (message.type === "fileList") {
    if (pickerKind !== "file") return;
    pickerEntries = message.entries || [];
    pickerIndex = 0;
    renderPicker();
    return;
  }

  if (message.type === "ready" || message.type === "clearStatus") {
    showChatApp();
    clearStatus();
    statusHint.textContent = "Local · TAB changes mode";
    return;
  }

  if (message.type === "status") {
    if (stopping || ignoreNextResult || !busy) {
      return;
    }
    showChatApp();
    clearStatus();
    const line = appendMessage("status", message.text || "Working…");
    line.classList.add("message-status");
    statusHint.textContent = message.text || "Working…";
    return;
  }

  if (ignoreNextResult && (message.type === "assistant" || message.type === "error" || message.type === "cancelled")) {
    ignoreNextResult = false;
    setBusy(false);
    return;
  }

  clearStatus();

  if (message.type === "cancelled") {
    showChatApp();
    appendMessage("status", "Stopped");
    setBusy(false);
    statusHint.textContent = "Stopped";
    input.focus();
    return;
  }

  if (message.type === "assistant") {
    showChatApp();
    const text = message.text || "";
    appendMessage("assistant", text);
    history.push({ role: "assistant", content: text });
    setBusy(false);
    statusHint.textContent = "Local · TAB changes mode";
    input.focus();
    return;
  }

  if (message.type === "error") {
    showChatApp();
    appendMessage("error", message.text || "Something went wrong.");
    if (history.length && history[history.length - 1].role === "user") {
      history.pop();
    }
    setBusy(false);
    statusHint.textContent = "Something went wrong";
    input.focus();
  }
});

updateChrome();
const restored = vscode.getState() || {};
if (typeof restored.modeIndex === "number" && restored.modeIndex >= 0 && restored.modeIndex < MODES.length) {
  modeIndex = restored.modeIndex;
}
if (typeof restored.searchEnabled === "boolean") {
  searchEnabled = restored.searchEnabled;
}
if (THINKING_LEVELS.some((level) => level.id === restored.thinkingEffort)) {
  thinkingEffort = restored.thinkingEffort;
}
updateChrome();
input.focus();
