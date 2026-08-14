import * as vscode from "vscode";
import { abortPlainPrompt } from "./rcProcess";
import { getChatHtml, handleChatMessage, postStartupDiagnostics } from "./chatCommon";

export class RcChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "rc.chatView";

  private view?: vscode.WebviewView;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")]
    };

    webviewView.webview.html = getChatHtml(webviewView.webview, this.extensionUri);
    postStartupDiagnostics(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message) => {
      void handleChatMessage(
        {
          webview: webviewView.webview,
          close: () => {
            abortPlainPrompt();
            void vscode.commands.executeCommand("workbench.action.closeSidebar");
          }
        },
        message as Record<string, unknown>
      );
    });
  }

  reveal(): void {
    if (this.view) {
      this.view.show?.(true);
    } else {
      void vscode.commands.executeCommand("rc.chatView.focus");
    }
  }
}
