import * as vscode from "vscode";
import type { ChatTurn, UiAgentMode } from "../rcProcess";
import { AshnaClient } from "../ashna/client";
import { abortAshnaTurn, runAshnaTurn } from "../ashna/runner";
import { abortHermesTurn, HERMES_INSTALL_URL, runHermesTurn } from "../hermes/runner";
import { describeEvent, ensureHermesFree, showHermesFreeStats, subscribeHermesFree, summarizeEvents } from "../hermes/free";
import type { GatewayEvent } from "../hermes/freeGateway";
import {
  clearDeepSeekApiKey,
  DEEPSEEK_KEYS_URL,
  getDeepSeekApiKey,
  getDeepSeekSettings,
  getHermesFreeModel,
  getHermesSettings,
  hasDeepSeekApiKey,
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

export type ExternalProviderId = "deepseek" | "hermes" | "hermes-free";

export function externalProviderState(): Record<string, unknown> {
  return {
    deepseek: { model: getDeepSeekSettings().model, hasKey: hasDeepSeekApiKey() },
    hermes: { model: getHermesSettings().model },
    hermesFree: { model: getHermesFreeModel() }
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
    "hermes-free": "Hermes Free model (deepseek-reasoner = DeepThink)"
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

async function openHermesFreeSettings(): Promise<void> {
  const items: Array<vscode.QuickPickItem & { action: string }> = [
    { label: "$(key) Update DeepSeek web token", description: "free · chat.deepseek.com", action: "token" },
    { label: "$(symbol-class) Choose model", description: getHermesFreeModel(), action: "model" },
    { label: "$(graph) Gateway stats", description: "delta sync savings, self-repairs", action: "stats" },
    { label: "$(link-external) Install Hermes Agent", action: "install" },
    { label: "$(gear) All settings", action: "settings" }
  ];
  const picked = await vscode.window.showQuickPick(items, { title: "Hermes Free settings" });
  switch (picked?.action) {
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

export async function openExternalSettings(provider: ExternalProviderId): Promise<void> {
  if (provider === "hermes-free") return openHermesFreeSettings();
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
  for (const notice of notices) {
    void webview.postMessage({ type: "status", text: notice });
  }

  if (provider === "hermes" || provider === "hermes-free") {
    let endpoint: { baseUrl: string; apiKey: string; model: string; label: string } | undefined;
    const events: GatewayEvent[] = [];
    let unsubscribe = () => undefined as unknown;
    if (provider === "hermes-free") {
      void webview.postMessage({ type: "status", text: "Hermes Free · starting the local gateway…" });
      try {
        endpoint = { ...(await ensureHermesFree()), model: getHermesFreeModel(), label: "Hermes Free" };
      } catch (error) {
        void webview.postMessage({ type: "error", text: error instanceof Error ? error.message : String(error) });
        return;
      }
      unsubscribe = subscribeHermesFree((event) => {
        events.push(event);
        void webview.postMessage({ type: "toolEvent", text: describeEvent(event) });
      });
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
    const summary = summarizeEvents(events);
    if (summary) void webview.postMessage({ type: "toolEvent", text: `Σ ${summary}` });
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
