import * as vscode from "vscode";
import type { ChatTurn, UiAgentMode } from "../rcProcess";
import { AshnaApiError } from "./client";
import {
  ASHNA_DEFAULT_MODEL,
  ASHNA_KEYS_URL,
  clearAshnaApiKey,
  getActiveProvider,
  getAshnaSettings,
  hasAshnaApiKey,
  saveAshnaApiKey,
  setActiveProvider,
  updateAshnaSettings,
  type ChatProviderId
} from "./config";
import { abortAshnaTurn, listAshnaModels, runAshnaTurn } from "./runner";
import { clearSession } from "./session";

/**
 * Glue between the chat webview and the Ashna provider. chatCommon forwards the
 * Ashna-specific message types here, so the RC/DeepSeek path stays untouched.
 */

type SetupReason = "missing" | "invalid" | "edit";

export const ASHNA_MESSAGE_TYPES = new Set([
  "setProvider",
  "requestAshnaSetup",
  "saveAshnaConfig",
  "openAshnaKeys",
  "pickAshnaModel",
  "cancelAshnaSetup"
]);

function providerStateMessage(): Record<string, unknown> {
  const settings = getAshnaSettings();
  return {
    type: "providerState",
    provider: getActiveProvider(),
    model: settings.model,
    agentId: settings.agentId,
    hasKey: hasAshnaApiKey()
  };
}

export function postProviderState(webview: vscode.Webview): void {
  void webview.postMessage(providerStateMessage());
}

/**
 * Open chat webviews, so a provider/model change made from the command palette
 * or Settings UI is reflected in every panel without a reload.
 */
const liveWebviews = new Set<vscode.Webview>();

export function trackChatWebview(webview: vscode.Webview): void {
  liveWebviews.add(webview);
}

export function broadcastProviderState(): void {
  const message = providerStateMessage();
  for (const webview of liveWebviews) {
    Promise.resolve()
      .then(() => webview.postMessage(message))
      .catch(() => liveWebviews.delete(webview)); // disposed panel
  }
}

export function registerAshnaConfigWatcher(): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("rc.provider") || event.affectsConfiguration("rc.ashna")) {
      broadcastProviderState();
    }
  });
}

export function postAshnaSetup(webview: vscode.Webview, reason: SetupReason, error = ""): void {
  const settings = getAshnaSettings();
  void webview.postMessage({
    type: "ashnaSetup",
    reason,
    hasKey: hasAshnaApiKey(),
    model: settings.model,
    agentId: settings.agentId,
    keysUrl: ASHNA_KEYS_URL,
    error
  });
}

/** Load the model catalog in the background; failures are non-fatal. */
async function postModelCatalog(webview: vscode.Webview): Promise<void> {
  if (!hasAshnaApiKey()) return;
  try {
    const models = await listAshnaModels();
    void webview.postMessage({ type: "ashnaModels", models });
  } catch {
    // The setup form still accepts a typed model id.
  }
}

async function saveConfig(webview: vscode.Webview, message: Record<string, unknown>): Promise<void> {
  const apiKey = typeof message.apiKey === "string" ? message.apiKey.trim() : "";
  const model = typeof message.model === "string" ? message.model.trim() : "";
  const agentId = typeof message.agentId === "string" ? message.agentId.trim() : "";

  if (!apiKey && !hasAshnaApiKey()) {
    void webview.postMessage({ type: "ashnaSaveError", text: "Paste your Ashna API key first." });
    return;
  }

  try {
    if (apiKey) await saveAshnaApiKey(apiKey);
    await updateAshnaSettings({ model: model || ASHNA_DEFAULT_MODEL, agentId });
  } catch (error) {
    void webview.postMessage({
      type: "ashnaSaveError",
      text: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  // Verify the key against GET /models. Only an explicit 401 is treated as a
  // bad key; network trouble should not block someone behind a flaky proxy.
  let warning = "";
  try {
    const models = await listAshnaModels();
    void webview.postMessage({ type: "ashnaModels", models });
    const chosen = getAshnaSettings().model;
    if (models.length && !models.includes(chosen)) {
      warning = ` Note: "${chosen}" is not in the model catalog — check the id.`;
    }
  } catch (error) {
    if (error instanceof AshnaApiError && error.kind === "auth") {
      await clearAshnaApiKey();
      void webview.postMessage({ type: "ashnaSaveError", text: error.message });
      return;
    }
    warning = ` Could not verify the key right now (${error instanceof Error ? error.message : String(error)}).`;
  }

  await setActiveProvider("ashna");
  void webview.postMessage({ type: "ashnaSaved", text: `Ashna connected.${warning}` });
  postProviderState(webview);
}

/** Handles Ashna-only webview messages. Returns true when the message was consumed. */
export async function handleAshnaMessage(
  webview: vscode.Webview,
  type: string,
  message: Record<string, unknown>
): Promise<boolean> {
  switch (type) {
    case "setProvider": {
      const provider: ChatProviderId = message.provider === "ashna" ? "ashna" : "rc";
      await setActiveProvider(provider);
      postProviderState(webview);
      if (provider === "ashna" && !hasAshnaApiKey()) {
        postAshnaSetup(webview, "missing");
      }
      return true;
    }
    case "requestAshnaSetup":
      postAshnaSetup(webview, "edit");
      void postModelCatalog(webview);
      return true;
    case "saveAshnaConfig":
      await saveConfig(webview, message);
      return true;
    case "openAshnaKeys":
      void vscode.env.openExternal(vscode.Uri.parse(ASHNA_KEYS_URL));
      return true;
    case "pickAshnaModel":
      await pickAshnaModel();
      postProviderState(webview);
      return true;
    case "cancelAshnaSetup":
      // Leaving setup without a key means Ashna cannot run; fall back to RC.
      if (!hasAshnaApiKey()) {
        await setActiveProvider("rc");
      }
      postProviderState(webview);
      void webview.postMessage({ type: "ready" });
      return true;
    default:
      return false;
  }
}

/** Forget Ashna transcript memory (one thread, or all). */
export function clearAshnaThread(threadId?: string): void {
  clearSession(threadId);
}

export function cancelAshnaPrompt(): boolean {
  return abortAshnaTurn();
}

export async function handleAshnaPrompt(
  webview: vscode.Webview,
  text: string,
  mode: UiAgentMode,
  threadId: string,
  history: ChatTurn[],
  notices: string[]
): Promise<void> {
  if (!hasAshnaApiKey()) {
    postAshnaSetup(webview, "missing");
    return;
  }

  for (const notice of notices) {
    void webview.postMessage({ type: "status", text: notice });
  }

  const result = await runAshnaTurn(text, {
    mode,
    threadId,
    history,
    onStatus: (statusText) => void webview.postMessage({ type: "status", text: statusText }),
    onPreview: (preview) => void webview.postMessage({ type: "assistantPartial", text: preview }),
    onToolEvent: (line) => void webview.postMessage({ type: "toolEvent", text: line })
  });

  if (result.ok) {
    void webview.postMessage({ type: "assistant", text: result.text, truncated: result.limitReached });
    return;
  }
  if (result.cancelled) {
    void webview.postMessage({ type: "cancelled" });
    return;
  }
  if (result.kind === "auth") {
    await clearAshnaApiKey();
    postAshnaSetup(webview, "invalid", result.error);
    return;
  }
  void webview.postMessage({ type: "error", text: result.error });
}

// ---------------------------------------------------------------------------
// Command-palette entry points
// ---------------------------------------------------------------------------

export async function promptAshnaApiKey(): Promise<void> {
  const value = await vscode.window.showInputBox({
    title: "RC — Ashna API Key",
    prompt: "Create a key at app.ashna.ai → Account → API, then paste it here. Stored in the OS keychain.",
    placeHolder: "Paste Ashna API key",
    password: true,
    ignoreFocusOut: true
  });
  if (!value?.trim()) return;
  try {
    await saveAshnaApiKey(value);
    await setActiveProvider("ashna");
    void vscode.window.showInformationMessage("Ashna API key saved. RC now uses Ashna.");
  } catch (error) {
    void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }
}

export async function pickAshnaModel(): Promise<void> {
  const current = getAshnaSettings().model;
  let models: string[] = [];
  try {
    models = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Loading Ashna models…" },
      () => listAshnaModels()
    );
  } catch (error) {
    void vscode.window.showWarningMessage(
      `Could not load the model list: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const typeOwn = "$(edit) Type a model id…";
  const items: vscode.QuickPickItem[] = [
    ...models.map((id) => ({ label: id, description: id === current ? "current" : undefined })),
    { label: typeOwn }
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: "Ashna model for Agent mode",
    placeHolder: `Current: ${current}`
  });
  if (!picked) return;

  let model = picked.label;
  if (model === typeOwn) {
    model =
      (await vscode.window.showInputBox({ title: "Ashna model id", value: current, ignoreFocusOut: true }))?.trim() ?? "";
  }
  if (model) {
    await updateAshnaSettings({ model });
    void vscode.window.showInformationMessage(`Ashna model: ${model}`);
  }
}

export async function promptAshnaAgentId(): Promise<void> {
  const value = await vscode.window.showInputBox({
    title: "RC — Ashna custom agent id",
    prompt: "From app.ashna.ai → your agent → Custom agent id. Used for Chat mode. Leave empty to clear.",
    value: getAshnaSettings().agentId,
    ignoreFocusOut: true
  });
  if (value === undefined) return;
  await updateAshnaSettings({ agentId: value });
  void vscode.window.showInformationMessage(value.trim() ? `Ashna agent: ${value.trim()}` : "Ashna agent cleared.");
}

export async function switchProviderCommand(): Promise<void> {
  const current = getActiveProvider();
  const picked = await vscode.window.showQuickPick(
    [
      { label: "RC (DeepSeek)", id: "rc" as const, description: current === "rc" ? "current" : undefined },
      { label: "Ashna", id: "ashna" as const, description: current === "ashna" ? "current" : undefined }
    ],
    { title: "RC chat provider" }
  );
  if (!picked) return;
  await setActiveProvider(picked.id);
  if (picked.id === "ashna" && !hasAshnaApiKey()) {
    await promptAshnaApiKey();
  }
}
