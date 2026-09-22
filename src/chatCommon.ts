import * as vscode from "vscode";
import {
  abortPlainPrompt,
  clearThreadSession,
  resolveCliJsPath,
  resolveDeepSeekToken,
  type ChatTurn,
  type RcEvent,
  type ThinkingEffort,
  type UiAgentMode
} from "./rcProcess";
import { runAgentTurn } from "./agentRunner";
import {
  clearAllThreads,
  deleteThread,
  listThreads,
  loadThread,
  saveThread
} from "./chatHistory";
import { getVelocitySettings } from "./velocity/settings";
import {
  clearVelocityThread,
  createThreadId,
  runVelocityPrompt
} from "./velocity";
import {
  recordTurn,
  reportDaemonUnavailable,
  resetAutoPilot,
  setVelocityMode,
  shouldUseVelocity,
  takeArmNotice
} from "./velocity/autoPilot";
import {
  abortPairMode,
  isPairRunning,
  queuePairUserMessage,
  runPairLoop
} from "./pairMode";
import { DEFAULT_PAIR_ROUNDS } from "./prompts/pairMode";
import {
  DEEPSEEK_TOKEN_COMMAND,
  DEEPSEEK_URL,
  clearDeepSeekToken,
  getTokenSetupGuide,
  isInvalidTokenOutput,
  openDeepSeekInBrowser,
  saveDeepSeekToken,
  tokenConfigPath
} from "./tokenSetup";
import {
  ASHNA_MESSAGE_TYPES,
  cancelAshnaPrompt,
  clearAshnaThread,
  handleAshnaMessage,
  handleAshnaPrompt,
  postAshnaSetup,
  postProviderState,
  trackChatWebview
} from "./ashna/chatBridge";
import { getActiveProvider, hasAshnaApiKey } from "./ashna/config";

function isAgentMode(value: unknown): value is UiAgentMode {
  return value === "ask" || value === "write" || value === "auto";
}

function isThinkingEffort(value: unknown): value is ThinkingEffort {
  return value === "off" || value === "low" || value === "medium" || value === "hard";
}

export type ChatHost = {
  webview: vscode.Webview;
  close?: () => void;
  threadId?: string;
};

let activeThreadId = createThreadId();

export function getChatHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "chat.css"));
  const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "chat.js"));
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource}`,
    `script-src ${webview.cspSource}`
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${cssUri}" />
    <title>RC</title>
  </head>
  <body>
    <div id="tokenSetup" class="token-setup hidden">
      <div class="token-card">
        <h2 id="tokenSetupTitle">Sign in to continue</h2>
        <p class="token-lead" id="tokenLead">RC needs a DeepSeek token (same flow as the <code>rc</code> CLI).</p>
        <ol>
          <li>Sign in at <code id="deepseekUrl"></code></li>
          <li>Open DevTools (F12) → Console and run:</li>
        </ol>
        <pre id="tokenCommand" class="token-command"></pre>
        <p>Paste the value below.</p>
        <p class="token-path">Saves to <code id="tokenPath"></code></p>
        <div class="token-form">
          <input id="tokenInput" type="password" placeholder="Paste token" autocomplete="off" />
          <button id="openBrowserButton" type="button" class="btn-secondary">Open DeepSeek</button>
          <button id="saveTokenButton" type="button" class="btn-primary">Continue</button>
        </div>
        <p id="tokenSetupStatus" class="token-setup-status"></p>
        <p class="token-alt">
          Prefer Ashna? <button id="useAshnaButton" type="button" class="link-btn">Use an Ashna API key instead</button>
        </p>
      </div>
    </div>

    <div id="ashnaSetup" class="token-setup hidden">
      <div class="token-card">
        <h2 id="ashnaSetupTitle">Connect Ashna</h2>
        <p class="token-lead" id="ashnaLead">Use your Ashna API key to chat with Ashna models or your own Ashna agent.</p>
        <ol>
          <li>Open <strong>app.ashna.ai → Account → API</strong> and create a key.</li>
          <li>Paste it below. It is stored in the OS keychain, not in settings.</li>
        </ol>
        <label class="field-label" for="ashnaKeyInput">API key</label>
        <input id="ashnaKeyInput" class="field-input" type="password" placeholder="Paste Ashna API key" autocomplete="off" />
        <label class="field-label" for="ashnaModelInput">Model <span class="field-hint">— used in Agent modes (edits files, runs commands)</span></label>
        <input id="ashnaModelInput" class="field-input" type="text" list="ashnaModelList" placeholder="claude-fable-5" autocomplete="off" />
        <datalist id="ashnaModelList"></datalist>
        <label class="field-label" for="ashnaAgentInput">Custom agent id <span class="field-hint">— optional, used in Chat mode</span></label>
        <input id="ashnaAgentInput" class="field-input" type="text" placeholder="my-agent-abc12" autocomplete="off" />
        <div class="token-form">
          <button id="ashnaKeysButton" type="button" class="btn-secondary">Get a key</button>
          <button id="ashnaCancelButton" type="button" class="btn-secondary">Back</button>
          <button id="ashnaSaveButton" type="button" class="btn-primary">Save &amp; connect</button>
        </div>
        <p id="ashnaSetupStatus" class="token-setup-status"></p>
        <p class="token-path">AshnaAI is a third-party service, not affiliated with this extension. Your API key is personal — do not share it. Usage is billed to your AshnaAI account under AshnaAI's Terms of Service (ashna.ai/service-terms).</p>
      </div>
    </div>

    <div id="chatApp" class="chat-app">
      <header class="topbar">
        <div class="topbar-title">
          <span class="brand-mark">RC</span>
          <span class="thread-label" id="threadLabel">New chat</span>
        </div>
        <div class="mode-menu provider-menu">
          <button id="providerChip" class="chip-btn provider-chip" type="button" title="Chat provider">
            <span id="providerLabel">RC</span>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/></svg>
          </button>
          <div id="providerDropdown" class="mode-dropdown provider-dropdown hidden">
            <button type="button" class="provider-option active" data-provider="rc">
              <strong>RC · DeepSeek</strong>
              <span>Bundled rc CLI with your DeepSeek token</span>
            </button>
            <button type="button" class="provider-option" data-provider="ashna">
              <strong>Ashna</strong>
              <span id="providerAshnaDetail">Ashna API key · models or your custom agent</span>
            </button>
            <button type="button" id="providerAshnaSettings" class="provider-option provider-settings">
              <strong>Ashna settings…</strong>
              <span>API key, model, agent id</span>
            </button>
          </div>
        </div>
        <button id="historyButton" class="icon-btn" title="Chat history" type="button" aria-label="Chat history">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 4v4l2.5 1.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            <circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.5"/>
          </svg>
        </button>
        <button id="newChatButton" class="icon-btn" title="New chat" type="button" aria-label="New chat">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>
      </header>

      <div id="historyPanel" class="history-panel hidden">
        <div class="history-head">
          <span>Chat history</span>
          <button id="historyClear" class="history-clear" type="button">Clear all</button>
        </div>
        <div id="historyList" class="history-list"></div>
      </div>

      <div id="messages" class="messages">
        <div id="emptyState" class="empty-state">
          <div class="empty-title">Ask RC to do anything</div>
          <div class="empty-sub">Reference files with @ · Switch approval mode below</div>
          <div class="suggestions">
            <button type="button" class="suggestion" data-prompt="Explain this codebase">Explain this codebase</button>
            <button type="button" class="suggestion" data-prompt="Find bugs and suggest fixes">Find bugs and suggest fixes</button>
            <button type="button" class="suggestion" data-prompt="Add tests for the main module">Add tests for the main module</button>
          </div>
        </div>
      </div>

      <div id="picker" class="picker hidden"></div>

      <footer class="composer-wrap">
        <div class="composer-box">
          <textarea id="promptInput" rows="2" placeholder="Ask RC to do anything…  (@ to add files, / for commands)"></textarea>
          <div class="composer-toolbar">
            <div class="toolbar-left">
              <button id="attachButton" class="chip-btn" type="button" title="Add files">@</button>
              <div class="mode-menu">
                <button id="modeButton" class="chip-btn mode-chip" type="button" title="Tab to cycle">
                  <span id="modeLabel">Agent</span>
                  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/></svg>
                </button>
                <div id="modeDropdown" class="mode-dropdown hidden">
                  <button type="button" class="mode-option" data-mode="ask">
                    <strong>Chat</strong>
                    <span>Answers only — no edits</span>
                  </button>
                  <button type="button" class="mode-option active" data-mode="write">
                    <strong>Agent</strong>
                    <span>Read, edit, and run in the workspace</span>
                  </button>
                  <button type="button" class="mode-option" data-mode="auto">
                    <strong>Agent (Full Access)</strong>
                    <span>Auto-approve edits and commands</span>
                  </button>
                </div>
              </div>
              <button id="searchChip" class="chip-btn" type="button" title="/search">Search off</button>
              <button id="pairChip" class="chip-btn" type="button" title="/pair">Pair off</button>
              <div class="mode-menu">
                <button id="velocityChip" class="chip-btn" type="button" title="/velocity">
                  <span id="velocityLabel">Velocity auto</span>
                  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/></svg>
                </button>
                <div id="velocityDropdown" class="mode-dropdown hidden">
                  <button type="button" class="velocity-option" data-velocity="off">
                    <strong>Off</strong>
                    <span>Never use the Velocity daemon</span>
                  </button>
                  <button type="button" class="velocity-option active" data-velocity="auto">
                    <strong>Auto</strong>
                    <span>Switch on by itself when a turn runs slow</span>
                  </button>
                  <button type="button" class="velocity-option" data-velocity="on">
                    <strong>Always on</strong>
                    <span>Route every turn through the daemon</span>
                  </button>
                </div>
              </div>
              <div class="mode-menu">
                <button id="thinkingChip" class="chip-btn" type="button" title="Thinking intensity">
                  <span id="thinkingLabel">Think off</span>
                  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/></svg>
                </button>
                <div id="thinkingDropdown" class="mode-dropdown hidden">
                  <button type="button" class="thinking-option active" data-thinking="off">
                    <strong>Off</strong>
                    <span>Fast — no chain-of-thought</span>
                  </button>
                  <button type="button" class="thinking-option" data-thinking="low">
                    <strong>Low</strong>
                    <span>Brief reasoning</span>
                  </button>
                  <button type="button" class="thinking-option" data-thinking="medium">
                    <strong>Medium</strong>
                    <span>Standard thinking</span>
                  </button>
                  <button type="button" class="thinking-option" data-thinking="hard">
                    <strong>Hard</strong>
                    <span>Deep thinking (expert)</span>
                  </button>
                </div>
              </div>
              <button id="tokenChip" class="chip-btn" type="button" title="/token">Update token</button>
            </div>
            <button id="sendButton" class="send-btn" type="button" title="Send" aria-label="Send">
              <svg id="sendIcon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M8 12V4M8 4L4 8M8 4l4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              <svg id="stopIcon" class="hidden" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect x="4.5" y="4.5" width="7" height="7" rx="1.2" fill="currentColor"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="composer-footer">
          <span id="statusHint" class="status-hint">Local · TAB changes mode</span>
        </div>
      </footer>
    </div>
    <script src="${jsUri}"></script>
  </body>
</html>`;
}

async function listWorkspaceEntries(query: string): Promise<string[]> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    return [];
  }

  const needle = query.trim().toLowerCase().replace(/\\/g, "/");
  const files = await vscode.workspace.findFiles(
    "**/*",
    "**/{node_modules,dist,out,.git,.venv,venv,__pycache__}/**",
    400
  );

  const entries = new Set<string>();
  for (const uri of files) {
    const relative = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
    entries.add(relative);
    const parts = relative.split("/");
    for (let i = 1; i < parts.length; i++) {
      entries.add(parts.slice(0, i).join("/") + "/");
    }
  }

  const all = [...entries].sort((a, b) => a.localeCompare(b));
  if (!needle) {
    return all.slice(0, 80);
  }

  return all.filter((entry) => entry.toLowerCase().includes(needle)).slice(0, 80);
}

function postTokenSetup(
  webview: vscode.Webview,
  openBrowser: boolean,
  reason: "missing" | "expired" = "missing"
): void {
  if (openBrowser) {
    openDeepSeekInBrowser();
  }

  void webview.postMessage({
    type: "tokenSetup",
    reason,
    title: reason === "expired" ? "Token expired" : "Sign in to continue",
    lead:
      reason === "expired"
        ? "Your DeepSeek token expired or is invalid. Get a fresh token and paste it below."
        : "RC needs a DeepSeek token (same flow as the rc CLI).",
    url: DEEPSEEK_URL,
    command: DEEPSEEK_TOKEN_COMMAND,
    path: tokenConfigPath(),
    guide: getTokenSetupGuide(reason)
  });
}

/**
 * Streamed text still contains `<tool_call>` markup mid-round. Strip it so the
 * live preview shows the narration, not the machinery.
 */
function stripToolMarkup(text: string): string {
  return text
    .replace(/<tool_call\b[\s\S]*?<\/tool_call>/g, "")
    .replace(/<tool_call\b[\s\S]*$/, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimStart();
}

/** One-line summary of a CLI event, for the tool timeline in the panel. */
function describeEvent(event: RcEvent): string {
  const name = typeof event.payload.name === "string" ? event.payload.name : "";
  const target = typeof event.payload.path === "string" ? event.payload.path : "";

  switch (event.name) {
    case "tool_start":
      return target ? `${name} · ${target}` : name;
    case "tool_denied": {
      // The read-only case names the remedy. "chat mode is read-only" alone
      // reads like a broken tool; what the user needs is the mode switch.
      if (event.payload.reason === "read_only") {
        return `${name} blocked — Chat mode cannot change files. Switch the mode selector to Agent and send again.`;
      }
      const reason =
        event.payload.reason === "guard" ? "blocked by Velocity guard" : "declined";
      return `${name} — ${reason}`;
    }
    case "tool_result":
      return event.payload.ok === false
        ? `${name} failed: ${String(event.payload.error ?? "").slice(0, 200)}`
        : "";
    case "edited":
      return target ? `edited ${target}` : "";
    case "limit":
      return "Tool-round limit reached — continuing…";
    // Where a shell command actually ran. A user who believes commands are
    // sandboxed when they are not is worse off than one who knows they are
    // not, so the unsandboxed case is stated just as plainly as the safe one.
    case "sandbox": {
      if (event.payload.refused === true) {
        return `run_command refused — sandboxing required but unavailable (${String(event.payload.reason ?? "")})`;
      }
      if (event.payload.sandboxed === true) {
        const image = String(event.payload.image ?? "");
        const network = event.payload.network === "deny" ? "no network" : "network open";
        return `sandboxed in microVM (${image}, ${network})`;
      }
      return `NOT sandboxed — ran on the host (${String(event.payload.reason ?? "")})`;
    }
    default:
      return "";
  }
}

export async function handleChatMessage(host: ChatHost, message: Record<string, unknown>): Promise<void> {
  const webview = host.webview;
  const type = typeof message.type === "string" ? message.type : "";

  if (type === "close") {
    host.close?.();
    return;
  }

  if (ASHNA_MESSAGE_TYPES.has(type)) {
    await handleAshnaMessage(webview, type, message);
    return;
  }

  if (type === "openDeepSeek") {
    openDeepSeekInBrowser();
    return;
  }

  if (type === "requestTokenSetup") {
    const reason = message.reason === "expired" ? "expired" : "missing";
    // Always clear when user asks to update, so a bad token cannot stick around.
    await clearDeepSeekToken();
    postTokenSetup(webview, true, reason);
    return;
  }

  if (type === "saveToken") {
    const token = typeof message.token === "string" ? message.token : "";
    try {
      const savedPath = await saveDeepSeekToken(token);
      void webview.postMessage({
        type: "tokenSaved",
        path: savedPath,
        text: "Signed in. You can start chatting."
      });
    } catch (error) {
      void webview.postMessage({
        type: "tokenSaveError",
        text: error instanceof Error ? error.message : String(error)
      });
    }
    return;
  }

  if (type === "historyList") {
    void webview.postMessage({ type: "historyList", threads: listThreads() });
    return;
  }

  if (type === "historyLoad" && typeof message.id === "string") {
    void webview.postMessage({
      type: "historyLoaded",
      id: message.id,
      turns: loadThread(message.id)
    });
    return;
  }

  if (type === "historySave" && typeof message.id === "string") {
    const turns = Array.isArray(message.turns) ? (message.turns as ChatTurn[]) : [];
    await saveThread(message.id, turns);
    return;
  }

  if (type === "historyDelete" && typeof message.id === "string") {
    clearAshnaThread(message.id);
    await deleteThread(message.id);
    void webview.postMessage({ type: "historyList", threads: listThreads() });
    return;
  }

  if (type === "historyClear") {
    clearAshnaThread();
    await clearAllThreads();
    void webview.postMessage({ type: "historyList", threads: listThreads() });
    return;
  }

  if (type === "listFiles") {
    const query = typeof message.query === "string" ? message.query : "";
    const entries = await listWorkspaceEntries(query);
    void webview.postMessage({ type: "fileList", entries, query });
    return;
  }

  if (type === "newChat") {
    if (typeof message.previousThreadId === "string") {
      clearAshnaThread(message.previousThreadId);
    }
    void clearVelocityThread(activeThreadId);
    // Drop the server-side DeepSeek session too, so the next turn starts clean.
    clearThreadSession(host.threadId || activeThreadId);
    resetAutoPilot(host.threadId || activeThreadId);
    activeThreadId = createThreadId();
    return;
  }

  if (type === "cancelPrompt") {
    if (cancelAshnaPrompt()) {
      return;
    }
    if (isPairRunning()) {
      abortPairMode();
    } else {
      abortPlainPrompt();
    }
    return;
  }

  if (type === "pairUserMessage" && typeof message.text === "string") {
    const note = message.text.trim();
    if (note && isPairRunning()) {
      queuePairUserMessage(note);
      void webview.postMessage({
        type: "status",
        text: "Note queued for next Writer/Reviewer turn…"
      });
    }
    return;
  }

  if (type !== "sendPrompt" || typeof message.text !== "string") {
    return;
  }

  if (getActiveProvider() === "ashna") {
    const ashnaText = message.text.trim();
    if (!ashnaText) {
      return;
    }
    const notices: string[] = [];
    if (message.pair) {
      notices.push("Pair mode is RC-only — running a normal Ashna turn.");
    }
    if (message.search) {
      notices.push("Web search is RC-only — Ashna answers from the model and workspace.");
    }
    await handleAshnaPrompt(
      webview,
      ashnaText,
      isAgentMode(message.mode) ? message.mode : "write",
      typeof message.threadId === "string" && message.threadId ? message.threadId : host.threadId || activeThreadId,
      Array.isArray(message.history) ? (message.history as ChatTurn[]) : [],
      notices
    );
    return;
  }

  if (!resolveDeepSeekToken()) {
    postTokenSetup(webview, true);
    return;
  }

  const text = message.text.trim();
  if (!text) {
    return;
  }

  const mode: UiAgentMode = isAgentMode(message.mode) ? message.mode : "write";
  const history = Array.isArray(message.history) ? (message.history as ChatTurn[]) : [];
  const search = Boolean(message.search);
  const thinkingEffort: ThinkingEffort = isThinkingEffort(message.thinkingEffort)
    ? message.thinkingEffort
    : message.thinking
      ? "medium"
      : "off";
  const pairMode = Boolean(message.pair);
  const pairRounds =
    typeof message.pairRounds === "number" && message.pairRounds > 0
      ? Math.floor(message.pairRounds)
      : DEFAULT_PAIR_ROUNDS;

  // Auto mode: the daemon takes over once a turn has been measurably slow.
  setVelocityMode(message.velocityMode);
  const velocity = shouldUseVelocity(host.threadId || activeThreadId);
  const armNotice = velocity ? takeArmNotice(host.threadId || activeThreadId) : "";
  if (armNotice) {
    void webview.postMessage({ type: "status", text: armNotice });
  }

  if (pairMode) {
    void webview.postMessage({
      type: "status",
      text: `Pair mode · ${pairRounds} rounds…`
    });

    const result = await runPairLoop({
      task: text,
      rounds: pairRounds,
      mode: "ask",
      search,
      thinkingEffort,
      onStatus: (statusText) => {
        void webview.postMessage({ type: "status", text: statusText });
      },
      onMessage: (role, roleText, round) => {
        void webview.postMessage({
          type: "assistant",
          text: roleText,
          role,
          round,
          pair: true,
          keepBusy: true
        });
      }
    });

    if (result.cancelled) {
      void webview.postMessage({ type: "cancelled" });
      return;
    }

    if (!result.ok) {
      const errorText = result.error || "Pair mode failed.";
      if (isInvalidTokenOutput(errorText)) {
        await clearDeepSeekToken();
        postTokenSetup(webview, true, "expired");
        return;
      }
      void webview.postMessage({ type: "error", text: errorText });
      return;
    }

    void webview.postMessage({ type: "pairDone" });
    return;
  }

  void webview.postMessage({
    type: "status",
    text: velocity
      ? mode === "ask"
        ? "Velocity · thinking…"
        : "Velocity · working…"
      : mode === "ask"
        ? "Thinking…"
        : "Working…"
  });

  const threadId = host.threadId || activeThreadId;
  const turnStartedAt = Date.now();
  let streamedText = "";

  if (velocity) {
    const velocityResult = await runVelocityPrompt(text, {
      mode,
      search,
      thinkingEffort,
      history,
      threadId,
      onStatus: (statusText) => {
        void webview.postMessage({ type: "status", text: statusText });
      },
      onChunk: (chunk) => {
        streamedText += chunk;
        void webview.postMessage({ type: "assistantPartial", text: streamedText });
      }
    });

    if (velocityResult.cancelled) {
      void webview.postMessage({ type: "cancelled" });
      return;
    }

    if (velocityResult.ok) {
      void webview.postMessage({
        type: "assistant",
        text: velocityResult.stdout,
        velocityFindings: velocityResult.findings
      });
      return;
    }

    if (velocityResult.stderr.includes("Falling back")) {
      // The daemon is not reachable (usually no Python). Stop asking for it on
      // every turn and say so once, then fall through to the standard path.
      const notice = reportDaemonUnavailable(threadId);
      if (notice) {
        void webview.postMessage({ type: "status", text: notice });
      }
    } else {
      const errorText = velocityResult.stderr || velocityResult.stdout || "Velocity failed.";
      if (isInvalidTokenOutput(errorText)) {
        await clearDeepSeekToken();
        postTokenSetup(webview, true, "expired");
        return;
      }
      void webview.postMessage({ type: "error", text: errorText });
      return;
    }
  }

  let previewText = "";

  const result = await runAgentTurn(text, {
    mode,
    search,
    thinkingEffort,
    history,
    threadId,
    onStatus: (statusText) => {
      void webview.postMessage({ type: "status", text: statusText });
    },
    onDelta: (delta) => {
      previewText += delta;
      void webview.postMessage({
        type: "assistantPartial",
        text: stripToolMarkup(previewText)
      });
    },
    onEvent: (event) => {
      const line = describeEvent(event);
      if (line) {
        void webview.postMessage({ type: "toolEvent", text: line });
      }
    }
  });

  if (result.cancelled) {
    void webview.postMessage({ type: "cancelled" });
    return;
  }

  if (result.ok) {
    // Feeds Auto mode: a slow turn hands the next one to the daemon.
    recordTurn(threadId, Date.now() - turnStartedAt);
    const notice = takeArmNotice(threadId);
    if (notice) {
      void webview.postMessage({ type: "status", text: notice });
    }
    void webview.postMessage({
      type: "assistant",
      text: result.stdout,
      // Still capped after auto-continue: offer the user a manual resume.
      truncated: Boolean(result.limitReached)
    });
    return;
  }

  const errorText = result.stderr || result.stdout || "Something went wrong.";
  if (isInvalidTokenOutput(errorText)) {
    await clearDeepSeekToken();
    postTokenSetup(webview, true, "expired");
    return;
  }

  void webview.postMessage({ type: "error", text: errorText });
}

export function postStartupDiagnostics(webview: vscode.Webview): void {
  trackChatWebview(webview);
  postProviderState(webview);

  // Ashna is a plain HTTPS API: no bundled CLI or DeepSeek token required.
  if (getActiveProvider() === "ashna") {
    if (!hasAshnaApiKey()) {
      postAshnaSetup(webview, "missing");
      return;
    }
    void webview.postMessage({ type: "ready" });
    void webview.postMessage({ type: "velocityDefaults", mode: getVelocitySettings().mode });
    return;
  }

  if (!resolveDeepSeekToken()) {
    postTokenSetup(webview, true);
    return;
  }

  const cliJs = resolveCliJsPath();
  if (!cliJs) {
    void webview.postMessage({
      type: "error",
      text: "Bundled rp-cli is missing. Reinstall this extension from the VSIX (or run npm install && npm run prepare-cli in the extension source)."
    });
    return;
  }

  void webview.postMessage({ type: "ready" });
  void webview.postMessage({
    type: "velocityDefaults",
    mode: getVelocitySettings().mode
  });
}

export async function promptAndSaveToken(): Promise<void> {
  openDeepSeekInBrowser();

  const token = await vscode.window.showInputBox({
    title: "RC — DeepSeek Token",
    prompt: `1) Sign in at ${DEEPSEEK_URL}  2) Console: ${DEEPSEEK_TOKEN_COMMAND}  3) Paste token`,
    placeHolder: "Paste token",
    password: true,
    ignoreFocusOut: true
  });

  if (!token?.trim()) {
    return;
  }

  try {
    const savedPath = await saveDeepSeekToken(token);
    void vscode.window.showInformationMessage(`Token saved to ${savedPath}`);
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Could not save token: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
