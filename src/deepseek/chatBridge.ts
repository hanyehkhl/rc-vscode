import * as vscode from "vscode";
import type { ChatTurn, UiAgentMode } from "../rcProcess";
import { AshnaClient } from "../ashna/client";
import { abortAshnaTurn, runAshnaTurn } from "../ashna/runner";
import { abortHermesTurn, HERMES_INSTALL_URL, runHermesTurn } from "../hermes/runner";
import {
  describeEvent,
  ensureHermesFree,
  showHermesFreeStats,
  subscribeHermesFree,
  subscribeHermesFreeTools,
  toolSummaryLine
} from "../hermes/free";
import { applyResult, callCard, type ToolCard } from "../hermes/toolCards";
import type { GatewayEvent } from "../hermes/freeGateway";
import { HermesRemoteClient, normalizeRemoteUrl, type ApprovalRequest } from "../hermes/remote";
import {
  clearDeepSeekApiKey,
  DEEPSEEK_KEYS_URL,
  getDeepSeekApiKey,
  getDeepSeekSettings,
  getCustomEndpoint,
  getHermesFreeModel,
  getHermesFreeSource,
  getHermesSettings,
  hasDeepSeekApiKey,
  getHermesRemote,
  saveCustomApiKey,
  saveHermesRemote,
  saveDeepSeekApiKey,
  setDeepSeekModel
} from "./config";

/**
 * Chat glue for the DeepSeek-backed external providers: the built-in agent
 * ("deepseek") and Hermes Agent on the paid API ("hermes"), plus Hermes Free
 * ("hermes-free"), which runs Hermes on the free web chat through the local
 * gateway. Setup happens through native input boxes, so the webview only needs
 * a provider option and a "settings" request.
 */

export type ExternalProviderId = "deepseek" | "hermes" | "hermes-free" | "hermes-remote";

export function externalProviderState(): Record<string, unknown> {
  return {
    deepseek: { model: getDeepSeekSettings().model, hasKey: hasDeepSeekApiKey() },
    hermes: { model: getHermesSettings().model },
    hermesRemote: { url: getHermesRemote() ? normalizeRemoteUrl(getHermesRemote()!.baseUrl) : "" },
    hermesFree: {
      model: getHermesFreeSource() === "custom" ? getCustomEndpoint()?.model ?? "custom (not set)" : getHermesFreeModel(),
      source: getHermesFreeSource()
    }
  };
}

/** Returns false when the user dismissed the prompt without saving a key. */
export async function promptDeepSeekApiKey(reason = ""): Promise<boolean> {
  const value = await vscode.window.showInputBox({
    title: "RC — DeepSeek API Key",
    prompt: `${reason ? `${reason} ` : ""}Create a key at platform.deepseek.com → API keys. Stored in the OS keychain.`,
    placeHolder: "sk-…",
    password: true,
    ignoreFocusOut: true
  });
  if (!value?.trim()) return false;
  try {
    await saveDeepSeekApiKey(value);
  } catch (error) {
    void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    return false;
  }
  try {
    const { baseUrl } = getDeepSeekSettings();
    await new AshnaClient({ baseUrl, apiKey: getDeepSeekApiKey(), timeoutMs: 20_000, label: "DeepSeek" }).listModels();
    void vscode.window.showInformationMessage("DeepSeek API key saved and verified.");
  } catch (error) {
    void vscode.window.showWarningMessage(
      `DeepSeek API key saved, but could not be verified: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return true;
}

export async function pickDeepSeekModel(target: ExternalProviderId = "deepseek"): Promise<void> {
  let models = ["deepseek-chat", "deepseek-reasoner"];
  // The free web chat has exactly these two modes; only the paid API lists more.
  if (target !== "hermes-free" && hasDeepSeekApiKey()) {
    try {
      const { baseUrl } = getDeepSeekSettings();
      const listed = await new AshnaClient({ baseUrl, apiKey: getDeepSeekApiKey(), timeoutMs: 20_000, label: "DeepSeek" }).listModels();
      if (listed.length) models = listed;
    } catch {
      // fall back to the known ids
    }
  }
  const current =
    target === "hermes" ? getHermesSettings().model : target === "hermes-free" ? getHermesFreeModel() : getDeepSeekSettings().model;
  const titles: Record<ExternalProviderId, string> = {
    deepseek: "DeepSeek model for the built-in agent",
    hermes: "Hermes model",
    "hermes-free": "Hermes Free model (deepseek-reasoner = DeepThink)",
    "hermes-remote": "Hermes server model (set on the server)"
  };
  const picked = await vscode.window.showQuickPick(
    models.map((id) => ({ label: id, description: id === current ? "current" : undefined })),
    { title: titles[target], placeHolder: `Current: ${current}` }
  );
  if (!picked) return;
  if (target === "hermes-free") {
    await vscode.workspace.getConfiguration("rc").update("hermesFree.model", picked.label, vscode.ConfigurationTarget.Global);
  } else if (target === "hermes") {
    await vscode.workspace.getConfiguration("rc").update("hermes.model", picked.label, vscode.ConfigurationTarget.Global);
  } else {
    await setDeepSeekModel(picked.label);
  }
}

/** URL + model + optional key of an OpenAI-compatible endpoint, asked step by step. */
export async function promptCustomEndpoint(): Promise<boolean> {
  const cfg = vscode.workspace.getConfiguration("rc");
  const current = getCustomEndpoint();
  const baseUrl = await vscode.window.showInputBox({
    title: "Custom model endpoint (1/3) — base URL",
    prompt: "OpenAI-compatible API base, e.g. http://localhost:11434/v1 (Ollama), https://my-server.com/v1, https://api.deepseek.com",
    value: current?.baseUrl ?? "",
    ignoreFocusOut: true,
    validateInput: (v) => (/^https?:\/\/\S+$/i.test(v.trim()) ? undefined : "Enter an http(s) URL.")
  });
  if (baseUrl === undefined) return false;
  const model = await vscode.window.showInputBox({
    title: "Custom model endpoint (2/3) — model name",
    prompt: "Exactly as the server names it, e.g. qwen2.5-coder:7b, deepseek-chat, gpt-4o-mini",
    value: current?.model ?? "",
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : "Enter the model name.")
  });
  if (model === undefined) return false;
  const key = await vscode.window.showInputBox({
    title: "Custom model endpoint (3/3) — API key",
    prompt: "Leave empty if the server needs none (e.g. local Ollama). Stored in the OS keychain.",
    password: true,
    ignoreFocusOut: true
  });
  if (key === undefined) return false;
  await cfg.update("hermesFree.custom.baseUrl", baseUrl.trim(), vscode.ConfigurationTarget.Global);
  await cfg.update("hermesFree.custom.model", model.trim(), vscode.ConfigurationTarget.Global);
  await saveCustomApiKey(key);
  await cfg.update("hermesFree.source", "custom", vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage(`Hermes Free now uses ${model.trim()} at ${baseUrl.trim()}.`);
  return true;
}

async function pickHermesFreeSource(): Promise<void> {
  const current = getHermesFreeSource();
  const custom = getCustomEndpoint();
  const picked = await vscode.window.showQuickPick(
    [
      { label: "Free DeepSeek (web chat)", id: "deepseek-web" as const, detail: "Your free chat.deepseek.com token · Delta Sync, self-repairing tool calls", description: current === "deepseek-web" ? "current" : undefined },
      { label: "Custom endpoint", id: "custom" as const, detail: custom ? `${custom.model} · ${custom.baseUrl}` : "Any OpenAI-compatible URL: Ollama, vLLM, LM Studio, your own server", description: current === "custom" ? "current" : undefined }
    ],
    { title: "Hermes Free — where the model runs" }
  );
  if (!picked) return;
  if (picked.id === "custom" && !custom) {
    await promptCustomEndpoint();
    return;
  }
  await vscode.workspace.getConfiguration("rc").update("hermesFree.source", picked.id, vscode.ConfigurationTarget.Global);
}

async function openHermesFreeSettings(): Promise<void> {
  const custom = getHermesFreeSource() === "custom";
  const endpoint = getCustomEndpoint();
  const items: Array<vscode.QuickPickItem & { action: string }> = [
    { label: "$(server-process) Model source", description: custom ? `custom · ${endpoint?.model ?? "not set"}` : "free DeepSeek web chat", action: "source" },
    custom
      ? { label: "$(edit) Custom endpoint", description: endpoint ? endpoint.baseUrl : "not set", action: "custom" }
      : { label: "$(key) Update DeepSeek web token", description: "free · chat.deepseek.com", action: "token" },
    ...(custom ? [] : [{ label: "$(symbol-class) Choose model", description: getHermesFreeModel(), action: "model" }]),
    { label: "$(graph) Gateway stats", description: "delta sync savings, self-repairs", action: "stats" },
    { label: "$(link-external) Install Hermes Agent", action: "install" },
    { label: "$(gear) All settings", action: "settings" }
  ];
  const picked = await vscode.window.showQuickPick(items, { title: "Hermes Free settings" });
  switch (picked?.action) {
    case "source":
      await pickHermesFreeSource();
      break;
    case "custom":
      await promptCustomEndpoint();
      break;
    case "token":
      await vscode.commands.executeCommand("rc.setToken");
      break;
    case "model":
      await pickDeepSeekModel("hermes-free");
      break;
    case "stats":
      await showHermesFreeStats();
      break;
    case "install":
      void vscode.env.openExternal(vscode.Uri.parse(HERMES_INSTALL_URL));
      break;
    case "settings":
      void vscode.commands.executeCommand("workbench.action.openSettings", "rc.hermes");
      break;
  }
}

// ---------------- Hermes on a server (API) ----------------

let remoteClient: HermesRemoteClient | undefined;
let remoteClientKey = "";
/** Chat thread -> Hermes session on the server, so a chat continues server-side. */
const remoteSessions = new Map<string, string>();

function currentRemoteClient(): HermesRemoteClient | undefined {
  const cfg = getHermesRemote();
  if (!cfg) return undefined;
  const key = `${normalizeRemoteUrl(cfg.baseUrl)}|${cfg.apiKey}`;
  if (!remoteClient || key !== remoteClientKey) {
    remoteClient = new HermesRemoteClient(cfg);
    remoteClientKey = key;
    remoteSessions.clear(); // sessions belong to the old server
  }
  return remoteClient;
}

/** Asks for the server URL and API_SERVER_KEY, then verifies them live. */
export async function promptHermesRemote(): Promise<boolean> {
  const current = getHermesRemote();
  const url = await vscode.window.showInputBox({
    title: "Hermes on a server (1/2) — API URL",
    prompt: "The Hermes API server, e.g. https://my-server.com:8642 or http://192.168.1.20:8642 (API_SERVER_ENABLED=true on the server).",
    value: current?.baseUrl ?? "",
    ignoreFocusOut: true,
    validateInput: (v) => (/^https?:\/\/\S+$/i.test(v.trim()) ? undefined : "Enter an http(s) URL.")
  });
  if (url === undefined) return false;
  const key = await vscode.window.showInputBox({
    title: "Hermes on a server (2/2) — API_SERVER_KEY",
    prompt: "The server's API_SERVER_KEY. Stored in the OS keychain.",
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : "The Hermes API always requires a key.")
  });
  if (key === undefined) return false;
  await saveHermesRemote(url, key);
  const client = currentRemoteClient();
  try {
    const info = await client!.probe();
    void vscode.window.showInformationMessage(
      `Connected to Hermes at ${normalizeRemoteUrl(url)} (${info.model}). Tools run on that server, against its files.`
    );
  } catch (error) {
    void vscode.window.showWarningMessage(`Saved, but the server did not answer correctly: ${error instanceof Error ? error.message : String(error)}`);
  }
  return true;
}

async function openHermesRemoteSettings(): Promise<void> {
  const cfg = getHermesRemote();
  const items: Array<vscode.QuickPickItem & { action: string }> = [
    { label: "$(remote) Server URL and key", description: cfg ? normalizeRemoteUrl(cfg.baseUrl) : "not set", action: "server" },
    { label: "$(pulse) Test connection", action: "test" },
    { label: "$(clear-all) Start fresh server sessions", description: "the next message opens a new Hermes session", action: "reset" }
  ];
  const picked = await vscode.window.showQuickPick(items, { title: "Hermes on a server" });
  switch (picked?.action) {
    case "server":
      await promptHermesRemote();
      break;
    case "test": {
      const client = currentRemoteClient();
      if (!client) {
        await promptHermesRemote();
        break;
      }
      try {
        const info = await client.probe();
        void vscode.window.showInformationMessage(`Hermes is reachable (${info.model}; tools run on the ${info.toolExecution}).`);
      } catch (error) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
      break;
    }
    case "reset":
      remoteSessions.clear();
      break;
  }
}

const APPROVAL_LABELS: Record<string, string> = {
  once: "Allow once",
  session: "Allow for this session",
  always: "Always allow",
  deny: "Deny"
};

async function askApproval(request: ApprovalRequest, mode: UiAgentMode, webview: vscode.Webview): Promise<string> {
  if (mode === "auto" && request.choices.includes("once")) {
    void webview.postMessage({ type: "status", text: `Full access: approved once — ${request.command}` });
    return "once";
  }
  const options = request.choices.filter((c) => c !== "deny").map((c) => APPROVAL_LABELS[c] ?? c);
  const picked = await vscode.window.showWarningMessage(
    `Hermes (on the server) wants to run:\n\n${request.command}${request.description ? `\n\n${request.description}` : ""}`,
    { modal: true },
    ...options
  );
  const choice = Object.entries(APPROVAL_LABELS).find(([, label]) => label === picked)?.[0];
  return choice && request.choices.includes(choice) ? choice : "deny";
}

async function handleRemotePrompt(webview: vscode.Webview, text: string, mode: UiAgentMode, threadId: string): Promise<void> {
  const client = currentRemoteClient() ?? ((await promptHermesRemote()) ? currentRemoteClient() : undefined);
  if (!client) {
    void webview.postMessage({ type: "error", text: "Hermes server is not set. Open RC: Hermes Server Settings." });
    return;
  }
  const cards = new Set<string>();
  const hooks = {
    onText: (t: string) => void webview.postMessage({ type: "assistantPartial", text: t }),
    onStatus: (t: string) => void webview.postMessage({ type: "status", text: t }),
    onCard: (card: ToolCard) => {
      cards.add(card.id);
      void webview.postMessage({ type: "toolCard", card });
    },
    onApproval: (req: ApprovalRequest) => askApproval(req, mode, webview)
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    let sessionId = remoteSessions.get(threadId);
    try {
      if (!sessionId) {
        void webview.postMessage({ type: "status", text: "Hermes server · opening a session…" });
        sessionId = await client.createSession(`RC · ${text.slice(0, 40)}`);
        remoteSessions.set(threadId, sessionId);
      }
    } catch (error) {
      void webview.postMessage({ type: "error", text: error instanceof Error ? error.message : String(error) });
      return;
    }
    void webview.postMessage({ type: "status", text: "Hermes server · working…" });
    const result = await client.runTurn(sessionId, text, mode, hooks);
    if (!result.ok && result.sessionGone && attempt === 0) {
      remoteSessions.delete(threadId); // deleted or expired on the server: open a new one once
      continue;
    }
    if (cards.size) {
      void webview.postMessage({ type: "toolSummary", text: `${cards.size} tool call${cards.size === 1 ? "" : "s"} · on the Hermes server` });
    }
    if (result.ok) void webview.postMessage({ type: "assistant", text: result.text });
    else if (result.cancelled) void webview.postMessage({ type: "cancelled" });
    else void webview.postMessage({ type: "error", text: result.error });
    return;
  }
}

export async function openExternalSettings(provider: ExternalProviderId): Promise<void> {
  if (provider === "hermes-free") return openHermesFreeSettings();
  if (provider === "hermes-remote") return openHermesRemoteSettings();
  const items: Array<vscode.QuickPickItem & { action: string }> = [
    { label: "$(key) Set DeepSeek API key", description: hasDeepSeekApiKey() ? "saved" : "missing", action: "key" },
    { label: "$(symbol-class) Choose model", action: "model" },
    { label: "$(link-external) Get a DeepSeek key", action: "keys" }
  ];
  if (provider === "hermes") {
    items.push({ label: "$(link-external) Install Hermes Agent", action: "install" });
  }
  items.push({ label: "$(gear) All settings", action: "settings" });
  if (hasDeepSeekApiKey()) items.push({ label: "$(trash) Remove DeepSeek API key", action: "clear" });

  const picked = await vscode.window.showQuickPick(items, {
    title: provider === "hermes" ? "Hermes Agent settings" : "DeepSeek agent settings"
  });
  switch (picked?.action) {
    case "key":
      await promptDeepSeekApiKey();
      break;
    case "model":
      await pickDeepSeekModel(provider);
      break;
    case "keys":
      void vscode.env.openExternal(vscode.Uri.parse(DEEPSEEK_KEYS_URL));
      break;
    case "install":
      void vscode.env.openExternal(vscode.Uri.parse(HERMES_INSTALL_URL));
      break;
    case "settings":
      void vscode.commands.executeCommand("workbench.action.openSettings", provider === "hermes" ? "rc.hermes" : "rc.deepseek");
      break;
    case "clear":
      await clearDeepSeekApiKey();
      break;
  }
}

export function cancelExternalPrompt(): boolean {
  if (remoteClient?.isRunning()) {
    void remoteClient.stop();
    return true;
  }
  return abortHermesTurn() || abortAshnaTurn();
}

export async function handleExternalPrompt(
  webview: vscode.Webview,
  provider: ExternalProviderId,
  text: string,
  mode: UiAgentMode,
  threadId: string,
  history: ChatTurn[],
  notices: string[]
): Promise<void> {
  // The built-in agent cannot run without a key; Hermes may have its own config.
  if (provider === "deepseek" && !hasDeepSeekApiKey()) {
    if (!(await promptDeepSeekApiKey("The DeepSeek agent needs an API key."))) {
      void webview.postMessage({ type: "error", text: "DeepSeek API key is not set. Use /token to add one." });
      return;
    }
  }
  if (provider === "hermes-remote") {
    for (const notice of notices) void webview.postMessage({ type: "status", text: notice });
    await handleRemotePrompt(webview, text, mode, threadId);
    return;
  }
  for (const notice of notices) {
    void webview.postMessage({ type: "status", text: notice });
  }

  if (provider === "hermes" || provider === "hermes-free") {
    let endpoint:
      | { baseUrl: string; apiKey: string; model: string; label: string; expose?: (host: string) => Promise<string> }
      | undefined;
    const events: GatewayEvent[] = [];
    let unsubscribe = () => undefined as unknown;
    let toolCalls = 0;
    if (provider === "hermes-free") {
      void webview.postMessage({ type: "status", text: "Hermes Free · starting the local gateway…" });
      try {
        const custom = getHermesFreeSource() === "custom";
        endpoint = {
          ...(await ensureHermesFree()),
          // In custom mode Hermes always asks for a name it accepts; the gateway swaps in the real model.
          model: custom ? "deepseek-chat" : getHermesFreeModel(),
          label: custom ? `Hermes · ${getCustomEndpoint()?.model ?? "custom"}` : "Hermes Free"
        };
      } catch (error) {
        void webview.postMessage({ type: "error", text: error instanceof Error ? error.message : String(error) });
        return;
      }
      // Transient telemetry lines (cleared when the answer lands) plus one
      // persistent card per tool call, updated in place when its result arrives.
      const cards = new Map<string, ToolCard>();
      const offEvents = subscribeHermesFree((event) => {
        events.push(event);
        void webview.postMessage({ type: "toolEvent", text: describeEvent(event) });
      });
      const offTools = subscribeHermesFreeTools((event) => {
        const card =
          event.type === "call"
            ? callCard(event.id, event.name, event.args, event.repaired)
            : cards.has(event.id)
              ? applyResult(cards.get(event.id)!, event.content)
              : undefined;
        if (!card) return;
        cards.set(card.id, card);
        void webview.postMessage({ type: "toolCard", card });
      });
      unsubscribe = () => {
        offEvents();
        offTools();
        toolCalls = cards.size;
      };
    }
    let result: Awaited<ReturnType<typeof runHermesTurn>>;
    try {
      result = await runHermesTurn(text, {
        mode,
        history,
        endpoint,
        onStatus: (status) => void webview.postMessage({ type: "status", text: status }),
        onPreview: (preview) => void webview.postMessage({ type: "assistantPartial", text: preview })
      });
    } finally {
      unsubscribe();
    }
    const summary = toolSummaryLine(toolCalls, events);
    if (summary) void webview.postMessage({ type: "toolSummary", text: summary });
    if (result.ok) {
      void webview.postMessage({ type: "assistant", text: result.text });
    } else if (result.cancelled) {
      void webview.postMessage({ type: "cancelled" });
    } else {
      void webview.postMessage({ type: "error", text: result.error });
      if (result.notInstalled) {
        const choice = await vscode.window.showErrorMessage(result.error, "Install guide", "Settings");
        if (choice === "Install guide") void vscode.env.openExternal(vscode.Uri.parse(HERMES_INSTALL_URL));
        if (choice === "Settings") void vscode.commands.executeCommand("workbench.action.openSettings", "rc.hermes");
      }
    }
    return;
  }

  const { baseUrl, model } = getDeepSeekSettings();
  const result = await runAshnaTurn(text, {
    mode,
    threadId,
    history,
    profile: { label: "DeepSeek", baseUrl, apiKey: getDeepSeekApiKey(), model },
    onStatus: (status) => void webview.postMessage({ type: "status", text: status }),
    onPreview: (preview) => void webview.postMessage({ type: "assistantPartial", text: preview }),
    onToolEvent: (line) => void webview.postMessage({ type: "toolEvent", text: line })
  });
  if (result.ok) {
    void webview.postMessage({ type: "assistant", text: result.text, truncated: result.limitReached });
  } else if (result.cancelled) {
    void webview.postMessage({ type: "cancelled" });
  } else {
    if (result.kind === "auth") await clearDeepSeekApiKey();
    void webview.postMessage({ type: "error", text: result.error });
  }
}
