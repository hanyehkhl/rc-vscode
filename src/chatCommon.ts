import * as vscode from "vscode";
import {
  resolveCliJsPath,
  resolveDeepSeekToken,
  runPlainPrompt,
  type ChatTurn,
  type UiAgentMode
} from "./rcProcess";
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

function isAgentMode(value: unknown): value is UiAgentMode {
  return value === "ask" || value === "write" || value === "auto";
}

export type ChatHost = {
  webview: vscode.Webview;
  close?: () => void;
};

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
      </div>
    </div>

    <div id="chatApp" class="chat-app">
      <header class="topbar">
        <div class="topbar-title">
          <span class="brand-mark">RC</span>
          <span class="thread-label" id="threadLabel">New chat</span>
        </div>
        <button id="newChatButton" class="icon-btn" title="New chat" type="button" aria-label="New chat">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>
      </header>

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
              <button id="thinkingChip" class="chip-btn" type="button" title="/thinking">Thinking off</button>
              <button id="tokenChip" class="chip-btn" type="button" title="/token">Update token</button>
            </div>
            <button id="sendButton" class="send-btn" type="button" title="Send" aria-label="Send">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M8 12V4M8 4L4 8M8 4l4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
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

export async function handleChatMessage(host: ChatHost, message: Record<string, unknown>): Promise<void> {
  const webview = host.webview;
  const type = typeof message.type === "string" ? message.type : "";

  if (type === "close") {
    host.close?.();
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

  if (type === "listFiles") {
    const query = typeof message.query === "string" ? message.query : "";
    const entries = await listWorkspaceEntries(query);
    void webview.postMessage({ type: "fileList", entries, query });
    return;
  }

  if (type !== "sendPrompt" || typeof message.text !== "string") {
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
  const thinking = Boolean(message.thinking);

  void webview.postMessage({
    type: "status",
    text: mode === "ask" ? "Thinking…" : "Working…"
  });

  const result = await runPlainPrompt(text, mode, history, { search, thinking });

  if (result.ok) {
    void webview.postMessage({ type: "assistant", text: result.stdout });
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
