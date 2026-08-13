import * as vscode from "vscode";
import { resolveCliJsPath, resolveDeepSeekToken, resolveNodePath } from "./rcProcess";

let rcTerminal: vscode.Terminal | undefined;

function getWorkspaceCwd(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function buildRcCommand(args: string[]): string | undefined {
  const cliJs = resolveCliJsPath();
  if (!cliJs) {
    void vscode.window.showErrorMessage(
      "RpCli not found. Set Settings → rc.cliPath to dist/source/cli.js."
    );
    return undefined;
  }

  const nodePath = resolveNodePath();
  const quotedNode = `"${nodePath}"`;
  const quotedCli = `"${cliJs}"`;
  return [quotedNode, quotedCli, ...args].join(" ");
}

export function getRcTerminal(): vscode.Terminal {
  if (!rcTerminal || rcTerminal.exitStatus !== undefined) {
    const token = resolveDeepSeekToken();
    const env: Record<string, string> = {};
    if (token) {
      env.DEEPSEEK_TOKEN = token;
    }

    rcTerminal = vscode.window.createTerminal({
      name: "RC",
      cwd: getWorkspaceCwd(),
      env
    });
  }

  return rcTerminal;
}

export function runRcInTerminal(args: string[]): void {
  const command = buildRcCommand(args);
  if (!command) {
    return;
  }

  const terminal = getRcTerminal();
  terminal.show(true);
  setTimeout(() => {
    terminal.sendText(command);
  }, 400);
}

export function runRcCommit(all = false): void {
  runRcInTerminal(all ? ["-c", "-a"] : ["-c"]);
}

export function runRcInteractive(): void {
  runRcInTerminal([]);
}
