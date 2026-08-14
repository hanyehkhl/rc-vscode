import * as vscode from "vscode";
import { abortPlainPrompt } from "./rcProcess";
import { getChatHtml, handleChatMessage, postStartupDiagnostics } from "./chatCommon";

export function openChatPanel(context: vscode.ExtensionContext): void {
  const panel = vscode.window.createWebviewPanel(
    "rcChat",
    "RC Chat",
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")]
    }
  );

  panel.webview.html = getChatHtml(panel.webview, context.extensionUri);
  postStartupDiagnostics(panel.webview);

  const subscription = panel.webview.onDidReceiveMessage((message) => {
    void handleChatMessage(
      {
        webview: panel.webview,
        close: () => panel.dispose()
      },
      message as Record<string, unknown>
    );
  });

  panel.onDidDispose(() => {
    abortPlainPrompt();
    subscription.dispose();
  });
}
