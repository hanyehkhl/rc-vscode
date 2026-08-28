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
  { name: "/pair", description: "Toggle Writer ↔ Reviewer pair mode" },
  { name: "/velocity", description: "Cycle Velocity: off / auto / on" },
  { name: "/token", description: "Set DeepSeek token" },
  { name: "/exit", description: "Close panel" },
  { name: "/quit", description: "Close panel" }
];

const DEFAULT_PAIR_ROUNDS = 3;

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
const pairChip = document.getElementById("pairChip");
const velocityChip = document.getElementById("velocityChip");
const velocityLabel = document.getElementById("velocityLabel");
const velocityDropdown = document.getElementById("velocityDropdown");
const thinkingChip = document.getElementById("thinkingChip");
const thinkingLabel = document.getElementById("thinkingLabel");
const thinkingDropdown = document.getElementById("thinkingDropdown");
const tokenChip = document.getElementById("tokenChip");
const attachButton = document.getElementById("attachButton");
const newChatButton = document.getElementById("newChatButton");
const historyButton = document.getElementById("historyButton");
const historyPanel = document.getElementById("historyPanel");
const historyList = document.getElementById("historyList");
const historyClear = document.getElementById("historyClear");
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
let pairEnabled = false;
const VELOCITY_MODES = [
  { id: "off", label: "Velocity off" },
  { id: "auto", label: "Velocity auto" },
  { id: "on", label: "Velocity on" }
];
let velocityMode = "auto";
let pairRounds = DEFAULT_PAIR_ROUNDS;
let thinkingEffort = "off";
let busy = false;
let stopping = false;
let ignoreNextResult = false;
let emptyCtrlC = false;
let pickerEntries = [];
let pickerIndex = 0;
let pickerKind = null;
const history = [];
let threadId = "t-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);

function persistState() {
  vscode.setState({
    modeIndex,
    searchEnabled,
    pairEnabled,
    velocityMode,
    pairRounds,
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
  if (pairChip) {
    pairChip.textContent = pairEnabled ? "Pair on · " + pairRounds : "Pair off";
    pairChip.classList.toggle("on", pairEnabled);
  }
  if (velocityChip) {
    const velocity = VELOCITY_MODES.find((entry) => entry.id === velocityMode) || VELOCITY_MODES[1];
    if (velocityLabel) {
      velocityLabel.textContent = velocity.label;
    } else {
      velocityChip.textContent = velocity.label;
    }
    velocityChip.classList.toggle("on", velocityMode !== "off");
  }
  document.querySelectorAll(".velocity-option").forEach((el) => {
    el.classList.toggle("active", el.getAttribute("data-velocity") === velocityMode);
  });
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

function saveHistory() {
  if (history.length === 0) return;
  vscode.postMessage({ type: "historySave", id: threadId, turns: history });
}

function relativeTime(stamp) {
  const seconds = Math.max(0, Math.round((Date.now() - stamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + "h ago";
  return Math.round(hours / 24) + "d ago";
}

function renderHistory(threads) {
  historyList.textContent = "";

  if (!threads || threads.length === 0) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = "No saved chats yet.";
    historyList.appendChild(empty);
    return;
  }

  threads.forEach((thread) => {
    const row = document.createElement("div");
    row.className = "history-row" + (thread.id === threadId ? " current" : "");

    const open = document.createElement("button");
    open.type = "button";
    open.className = "history-open";
    open.setAttribute("dir", "auto");
    const title = document.createElement("span");
    title.className = "history-title";
    title.textContent = thread.title;
    const meta = document.createElement("span");
    meta.className = "history-meta";
    meta.textContent = thread.turnCount + " messages · " + relativeTime(thread.updatedAt);
    open.appendChild(title);
    open.appendChild(meta);
    open.addEventListener("click", () => {
      vscode.postMessage({ type: "historyLoad", id: thread.id });
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "history-delete";
    remove.title = "Delete";
    remove.textContent = "x";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      vscode.postMessage({ type: "historyDelete", id: thread.id });
    });

    row.appendChild(open);
    row.appendChild(remove);
    historyList.appendChild(row);
  });
}

function toggleHistoryPanel(force) {
  const show = typeof force === "boolean" ? force : historyPanel.classList.contains("hidden");
  historyPanel.classList.toggle("hidden", !show);
  if (show) {
    vscode.postMessage({ type: "historyList" });
  }
}

function restoreThread(id, turns) {
  threadId = id;
  history.length = 0;
  messages.querySelectorAll(".message").forEach((node) => node.remove());

  turns.forEach((turn) => {
    history.push({ role: turn.role, content: turn.content });
    appendMessage(turn.role === "user" ? "you" : "assistant", turn.content);
  });

  const first = turns.find((turn) => turn.role === "user");
  threadLabel.textContent = first
    ? first.content.slice(0, 42) + (first.content.length > 42 ? "…" : "")
    : "Restored chat";
  toggleHistoryPanel(false);
  showChatApp();
  // A restored thread has no server-side session; start a fresh one for it.
  vscode.postMessage({ type: "newChat" });
  input.focus();
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

/**
 * Split a message into prose and fenced code blocks.
 *
 * Prose gets dir="auto" so each paragraph picks its own direction — without it,
 * a Persian sentence containing an English identifier (or the reverse) gets
 * reordered by the bidi algorithm and reads as gibberish. Code is forced LTR
 * and isolated so surrounding RTL text cannot flip it.
 */
function renderBody(container, text) {
  const parts = String(text == null ? "" : text).split(/```/);

  parts.forEach((part, index) => {
    const isCode = index % 2 === 1;
    if (!part && !isCode) return;

    if (isCode) {
      const firstBreak = part.indexOf("\n");
      const lang = firstBreak === -1 ? "" : part.slice(0, firstBreak).trim();
      const body = firstBreak === -1 ? part : part.slice(firstBreak + 1);

      const block = document.createElement("pre");
      block.className = "code-block";
      block.setAttribute("dir", "ltr");
      const code = document.createElement("code");
      code.textContent = body.replace(/\n$/, "");
      block.appendChild(code);

      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "code-copy";
      copy.textContent = "Copy";
      copy.addEventListener("click", (event) => {
        event.stopPropagation();
        copyText(code.textContent, copy);
      });
      block.appendChild(copy);

      if (lang) {
        const tag = document.createElement("span");
        tag.className = "code-lang";
        tag.textContent = lang;
        block.appendChild(tag);
      }

      container.appendChild(block);
      return;
    }

    const prose = document.createElement("div");
    prose.className = "msg-text";
    prose.setAttribute("dir", "auto");
    prose.textContent = part;
    container.appendChild(prose);
  });
}

function copyText(value, button) {
  const done = () => {
    if (!button) return;
    const previous = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => {
      button.textContent = previous;
    }, 1200);
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(value || "").then(done, () => fallbackCopy(value, done));
    return;
  }
  fallbackCopy(value, done);
}

function fallbackCopy(value, done) {
  const area = document.createElement("textarea");
  area.value = value || "";
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand("copy");
    done();
  } catch (error) {
    // clipboard unavailable — nothing useful to do
  }
  document.body.removeChild(area);
}

/** Rewind the conversation to just before this user message, ready to resend. */
function editUserMessage(line) {
  if (busy) return;

  const raw = line.dataset.raw || "";
  const all = [...messages.querySelectorAll(".message")];
  const start = all.indexOf(line);
  if (start === -1) return;

  // Everything after this point is a reply to text the user is about to change.
  let removedUserTurns = 0;
  for (let i = all.length - 1; i >= start; i--) {
    if (all[i].dataset.histRole) {
      removedUserTurns++;
    }
    all[i].remove();
  }
  if (removedUserTurns > 0) {
    history.splice(Math.max(0, history.length - removedUserTurns));
  }

  input.value = raw;
  input.focus();
  input.setSelectionRange(raw.length, raw.length);
  showEmpty();
  statusHint.textContent = "Editing — press Enter to resend";
}

function attachMessageActions(line, role, text) {
  if (role === "status" || role === "error") {
    return;
  }

  const actions = document.createElement("div");
  actions.className = "message-actions";

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "message-action";
  copy.title = "Copy message";
  copy.textContent = "Copy";
  copy.addEventListener("click", (event) => {
    event.stopPropagation();
    copyText(line.dataset.raw || text, copy);
  });
  actions.appendChild(copy);

  if (role === "you") {
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "message-action";
    edit.title = "Edit and resend";
    edit.textContent = "Edit";
    edit.addEventListener("click", (event) => {
      event.stopPropagation();
      editUserMessage(line);
    });
    actions.appendChild(edit);
  }

  line.appendChild(actions);
}

function appendMessage(role, text, label) {
  hideEmpty();
  const line = document.createElement("div");
  const isPairRole = role === "writer" || role === "reviewer";
  line.className =
    "message " +
    (role === "you"
      ? "message-user"
      : role === "error"
        ? "message-error"
        : role === "status"
          ? "message-status"
          : isPairRole
            ? "message-assistant message-" + role
            : "message-assistant");

  if (role === "assistant" || role === "rc" || isPairRole) {
    const roleEl = document.createElement("span");
    roleEl.className = "message-role" + (isPairRole ? " message-role-" + role : "");
    roleEl.textContent = label || (role === "writer" ? "Writer" : role === "reviewer" ? "Reviewer" : "RC");
    line.appendChild(roleEl);
  }

  line.dataset.raw = String(text == null ? "" : text);
  if (role === "you") {
    line.dataset.histRole = "user";
  }

  const body = document.createElement("div");
  body.className = "message-body";
  renderBody(body, text);
  line.appendChild(body);

  attachMessageActions(line, role, text);

  messages.appendChild(line);
  messages.scrollTop = messages.scrollHeight;
  return line;
}

function clearStatus() {
  messages.querySelectorAll(".message-status").forEach((node) => node.remove());
}

function clearToolTrail() {
  messages.querySelectorAll(".message-tool").forEach((node) => node.remove());
}

function appendToolEvent(text) {
  hideEmpty();
  const line = document.createElement("div");
  line.className = "message message-tool";
  line.textContent = text;
  messages.appendChild(line);
  messages.scrollTop = messages.scrollHeight;
}

function appendContinueButton() {
  const wrap = document.createElement("div");
  wrap.className = "message message-continue";
  const label = document.createElement("span");
  label.textContent = "The agent paused at the tool-round limit.";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "continue-btn";
  button.textContent = "Continue";
  button.addEventListener("click", function () {
    wrap.remove();
    sendPrompt("Continue from where you stopped. Do not repeat finished work.");
  });
  wrap.appendChild(label);
  wrap.appendChild(button);
  messages.appendChild(wrap);
  messages.scrollTop = messages.scrollHeight;
}

function setBusy(next, options) {
  busy = next;
  if (!next) {
    stopping = false;
  }
  const pairBusy = Boolean(options && options.pair);
  // During pair mode, keep the send affordance so the user can inject notes.
  // Stop is still available via Escape / Ctrl+C.
  const showStop = next && !pairBusy;
  sendButton.disabled = false;
  sendButton.classList.toggle("stop-btn", showStop);
  sendButton.title = showStop ? "Stop" : "Send";
  sendButton.setAttribute("aria-label", showStop ? "Stop" : "Send");
  if (sendIcon) sendIcon.classList.toggle("hidden", showStop);
  if (stopIcon) stopIcon.classList.toggle("hidden", !showStop);
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

function setVelocityMode(next) {
  if (!VELOCITY_MODES.some((entry) => entry.id === next)) return;
  velocityMode = next;
  if (velocityDropdown) velocityDropdown.classList.add("hidden");
  updateChrome();
  persistState();
  statusHint.textContent =
    velocityMode === "on"
      ? "Velocity on · every turn through the daemon"
      : velocityMode === "auto"
        ? "Velocity auto · switches on when a turn runs slow"
        : "Velocity off";
}

function cycleVelocityMode() {
  const index = VELOCITY_MODES.findIndex((entry) => entry.id === velocityMode);
  setVelocityMode(VELOCITY_MODES[(index + 1) % VELOCITY_MODES.length].id);
}

function resetChat() {
  if (busy) {
    ignoreNextResult = true;
    cancelRun();
    setBusy(false);
  }
  history.length = 0;
  messages.querySelectorAll(".message").forEach((node) => node.remove());
  clearToolTrail();
  clearStatus();
  showEmpty();
  threadId = "t-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
  toggleHistoryPanel(false);
  threadLabel.textContent = "New chat";
  statusHint.textContent = velocityMode !== "off" ? "Velocity " + velocityMode : "Local · TAB changes mode";
  input.value = "";
  hidePicker();
  vscode.postMessage({ type: "newChat" });
  input.focus();
}

function closePanel() {
  vscode.postMessage({ type: "close" });
}

function togglePairMode(rounds) {
  if (typeof rounds === "number" && rounds > 0) {
    pairRounds = rounds;
    pairEnabled = true;
  } else {
    pairEnabled = !pairEnabled;
  }
  updateChrome();
  persistState();
  statusHint.textContent = pairEnabled
    ? "Pair mode on · " + pairRounds + " rounds · send a task"
    : "Pair mode off";
}

function runSlashOrSend() {
  const text = (input.value || "").trim();
  if (!text) return;

  // While pair is running, normal text becomes a queued user note.
  if (busy && pairEnabled) {
    sendPairNote(text);
    return;
  }

  if (busy) return;

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
  if (command === "/pair" || command.startsWith("/pair ")) {
    input.value = "";
    hidePicker();
    const arg = text.slice("/pair".length).trim();
    if (!arg) {
      togglePairMode();
      return;
    }
    const roundMatch = /^(\d+)\s*(.*)$/.exec(arg);
    if (roundMatch) {
      const rounds = Math.max(1, parseInt(roundMatch[1], 10) || DEFAULT_PAIR_ROUNDS);
      const task = roundMatch[2].trim();
      pairRounds = rounds;
      pairEnabled = true;
      updateChrome();
      persistState();
      if (task) {
        sendPrompt(task);
      } else {
        statusHint.textContent = "Pair mode on · " + pairRounds + " rounds · send a task";
      }
      return;
    }
    pairEnabled = true;
    updateChrome();
    persistState();
    sendPrompt(arg);
    return;
  }
  if (command === "/velocity") {
    input.value = "";
    hidePicker();
    cycleVelocityMode();
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

function sendPairNote(text) {
  const note = (text || "").trim();
  if (!note || !busy || !pairEnabled) return;

  hidePicker();
  appendMessage("you", note);
  history.push({ role: "user", content: note });
  input.value = "";
  statusHint.textContent = "Note queued for next turn…";
  vscode.postMessage({ type: "pairUserMessage", text: note });
}

function sendPrompt(preset) {
  const text = (preset || input.value || "").trim();
  if (!text) return;

  if (busy && pairEnabled) {
    sendPairNote(text);
    return;
  }
  if (busy) return;

  hidePicker();
  clearStatus();
  appendMessage("you", text);
  threadLabel.textContent = text.length > 42 ? text.slice(0, 42) + "…" : text;

  const historyPayload = history.slice(-8);
  history.push({ role: "user", content: text });

  input.value = "";
  emptyCtrlC = false;
  ignoreNextResult = false;
  setBusy(true, { pair: pairEnabled });
  statusHint.textContent = pairEnabled
    ? "Pair mode · " + pairRounds + " rounds…"
    : velocityMode === "on"
      ? currentMode().id === "ask"
        ? "Velocity · thinking…"
        : "Velocity · working…"
      : currentMode().id === "ask"
        ? "Thinking…"
        : "Working…";

  vscode.postMessage({
    type: "sendPrompt",
    text: text,
    mode: currentMode().id,
    search: searchEnabled,
    thinking: thinkingEffort !== "off",
    thinkingEffort: thinkingEffort,
    pair: pairEnabled,
    pairRounds: pairRounds,
    velocityMode: velocityMode,
    history: historyPayload
  });
}

function handleSendOrStop() {
  if (busy && !pairEnabled) {
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
  if (velocityDropdown) velocityDropdown.classList.add("hidden");
});

searchChip.addEventListener("click", () => {
  searchEnabled = !searchEnabled;
  updateChrome();
  persistState();
});

if (pairChip) {
  pairChip.addEventListener("click", () => {
    togglePairMode();
  });
}

if (velocityChip) {
  velocityChip.addEventListener("click", (event) => {
    event.stopPropagation();
    modeDropdown.classList.add("hidden");
    thinkingDropdown.classList.add("hidden");
    if (velocityDropdown) velocityDropdown.classList.toggle("hidden");
  });
}

document.querySelectorAll(".velocity-option").forEach((el) => {
  el.addEventListener("click", (event) => {
    event.stopPropagation();
    setVelocityMode(el.getAttribute("data-velocity"));
  });
});

thinkingChip.addEventListener("click", (event) => {
  event.stopPropagation();
  modeDropdown.classList.add("hidden");
  if (velocityDropdown) velocityDropdown.classList.add("hidden");
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

if (historyButton) {
  historyButton.addEventListener("click", () => toggleHistoryPanel());
}
if (historyClear) {
  historyClear.addEventListener("click", () => {
    vscode.postMessage({ type: "historyClear" });
  });
}

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
    statusHint.textContent = velocityMode !== "off" ? "Velocity " + velocityMode : "Local · TAB changes mode";
    return;
  }

  if (message.type === "historyList") {
    renderHistory(message.threads || []);
    return;
  }

  if (message.type === "historyLoaded") {
    restoreThread(message.id, message.turns || []);
    return;
  }

  if (message.type === "velocityDefaults") {
    if (VELOCITY_MODES.some((entry) => entry.id === message.mode)) {
      velocityMode = message.mode;
      updateChrome();
    }
    return;
  }

  if (message.type === "toolEvent") {
    if (stopping || ignoreNextResult || !busy) {
      return;
    }
    showChatApp();
    appendToolEvent(message.text || "");
    return;
  }

  if (message.type === "assistantPartial") {
    if (stopping || ignoreNextResult || !busy) {
      return;
    }
    showChatApp();
    let partial = messages.querySelector(".message-partial");
    if (!partial) {
      partial = appendMessage("assistant", message.text || "", "RC");
      partial.classList.add("message-partial");
    } else {
      const body = partial.querySelector(".message-body");
      if (body) {
        body.textContent = "";
        renderBody(body, message.text || "");
      }
      partial.dataset.raw = message.text || "";
    }
    messages.scrollTop = messages.scrollHeight;
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

  if (ignoreNextResult && (message.type === "assistant" || message.type === "error" || message.type === "cancelled" || message.type === "pairDone")) {
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

  if (message.type === "pairDone") {
    showChatApp();
    appendMessage("status", "Pair mode finished");
    setBusy(false);
    statusHint.textContent = pairEnabled
      ? "Pair on · " + pairRounds + " rounds"
      : "Local · TAB changes mode";
    input.focus();
    return;
  }

  if (message.type === "assistant") {
    showChatApp();
    messages.querySelectorAll(".message-partial").forEach((node) => node.remove());
    clearToolTrail();
    const text = message.text || "";
    const role = message.role === "writer" || message.role === "reviewer" ? message.role : "assistant";
    const label =
      role === "writer"
        ? "Writer · round " + (message.round || "?")
        : role === "reviewer"
          ? "Reviewer · round " + (message.round || "?")
          : "RC";
    appendMessage(role, text, label);
    if (message.velocityFindings && message.velocityFindings.length) {
      const finding = message.velocityFindings[0];
      appendMessage("status", "Velocity: " + finding.evidence, "Tip");
    }
    history.push({ role: "assistant", content: (label !== "RC" ? "[" + label + "] " : "") + text });
    saveHistory();
    if (message.keepBusy) {
      setBusy(true, { pair: true });
      statusHint.textContent =
        role === "writer" ? "Waiting for Reviewer…" : "Waiting for Writer…";
    } else {
      setBusy(false);
      statusHint.textContent = "Local · TAB changes mode";
      if (message.truncated) {
        appendContinueButton();
      }
    }
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
if (typeof restored.pairEnabled === "boolean") {
  pairEnabled = restored.pairEnabled;
}
if (typeof restored.pairRounds === "number" && restored.pairRounds > 0) {
  pairRounds = restored.pairRounds;
}
if (THINKING_LEVELS.some((level) => level.id === restored.thinkingEffort)) {
  thinkingEffort = restored.thinkingEffort;
}
if (VELOCITY_MODES.some((entry) => entry.id === restored.velocityMode)) {
  velocityMode = restored.velocityMode;
}
updateChrome();
input.focus();
