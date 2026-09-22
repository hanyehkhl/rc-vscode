import * as vscode from "vscode";
import { openChatPanel } from "./chatPanel";
import { promptAndSaveToken } from "./chatCommon";
import { RcChatViewProvider } from "./chatViewProvider";
import { generateCommit } from "./commitCommand";
import { initAgentsFile } from "./agentsInit";
import { initChatHistory } from "./chatHistory";
import { setManagedPythonStoragePath } from "./velocity/pythonEnv";
import { startCodegraphBackgroundIndexer } from "./codegraphIndexer";
import { setExtensionPath } from "./rcProcess";
import { runRcInteractive } from "./terminalRunner";
import { stopVelocityStack } from "./velocity/supervisor";
import { initAshnaConfig } from "./ashna/config";
import {
  pickAshnaModel,
  promptAshnaAgentId,
  promptAshnaApiKey,
  registerAshnaConfigWatcher,
  switchProviderCommand
} from "./ashna/chatBridge";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Load the Ashna key from SecretStorage before any chat view asks for it.
  await initAshnaConfig(context.secrets);
  setExtensionPath(context.extensionPath);
  initChatHistory(context.globalState);
  setManagedPythonStoragePath(context.globalStorageUri.fsPath);
  startCodegraphBackgroundIndexer(context);

  const provider = new RcChatViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(RcChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand("rc.openChat", () => {
      openChatPanel(context);
      provider.reveal();
    }),
    vscode.commands.registerCommand("rc.openChatEditor", () => {
      openChatPanel(context);
    }),
    vscode.commands.registerCommand("rc.focusChat", () => {
      provider.reveal();
    }),
    vscode.commands.registerCommand("rc.setToken", () => {
      void promptAndSaveToken();
    }),
    vscode.commands.registerCommand("rc.openInteractive", () => {
      runRcInteractive();
    }),
    vscode.commands.registerCommand("rc.generateCommit", () => {
      generateCommit(false);
    }),
    vscode.commands.registerCommand("rc.generateCommitAll", () => {
      generateCommit(true);
    }),
    vscode.commands.registerCommand("rc.initAgents", () => {
      void initAgentsFile();
    }),
    vscode.commands.registerCommand("rc.switchProvider", () => switchProviderCommand()),
    vscode.commands.registerCommand("rc.ashna.setApiKey", () => promptAshnaApiKey()),
    vscode.commands.registerCommand("rc.ashna.selectModel", () => pickAshnaModel()),
    vscode.commands.registerCommand("rc.ashna.setAgentId", () => promptAshnaAgentId()),
    registerAshnaConfigWatcher()
  );
}

export function deactivate(): void {
  void stopVelocityStack();
}
