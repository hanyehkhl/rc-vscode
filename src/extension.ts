import * as vscode from "vscode";
import { openChatPanel } from "./chatPanel";
import { promptAndSaveToken } from "./chatCommon";
import { RcChatViewProvider } from "./chatViewProvider";
import { generateCommit } from "./commitCommand";
import { setExtensionPath } from "./rcProcess";
import { runRcInteractive } from "./terminalRunner";

export function activate(context: vscode.ExtensionContext): void {
  setExtensionPath(context.extensionPath);

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
    })
  );
}

export function deactivate(): void {}
