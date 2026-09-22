import * as vscode from "vscode";
import { resolveCliJsPath, resolveDeepSeekToken, resolveNodePath } from "./rcProcess";

/**
 * Runs the bundled rc CLI in a VS Code terminal.
 *
 * The terminal process IS node (shellPath/shellArgs) instead of a shell that
 * receives a typed command line. That makes it independent of the user's
 * shell: sending `"C:\...\node.exe" "...\cli.js"` as text works in cmd and bash
 * but PowerShell (the Windows default) just echoes a quoted string, and paths
 * with spaces or non-ASCII user names need different quoting in every shell.
 */

let interactiveTerminal: vscode.Terminal | undefined;
let commitTerminal: vscode.Terminal | undefined;

function getWorkspaceCwd(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function isAlive(terminal: vscode.Terminal | undefined): terminal is vscode.Terminal {
  return Boolean(terminal) && terminal!.exitStatus === undefined;
}

function createRcTerminal(name: string, args: string[]): vscode.Terminal | undefined {
  const cliJs = resolveCliJsPath();
  if (!cliJs) {
    void vscode.window.showErrorMessage("Bundled rp-cli is missing. Reinstall the RC extension.");
    return undefined;
  }

  const nodePath = resolveNodePath();
  if (!nodePath) {
    void vscode.window.showErrorMessage(
      "Node.js was not found and the bundled copy is missing. Reinstall the RC extension or set rc.nodePath."
    );
    return undefined;
  }

  const env: Record<string, string> = {};
  const token = resolveDeepSeekToken();
  if (token) {
    env.DEEPSEEK_TOKEN = token;
  }

  return vscode.window.createTerminal({
    name,
    shellPath: nodePath,
    shellArgs: [cliJs, ...args],
    cwd: getWorkspaceCwd(),
    env
  });
}

export function runRcInteractive(): void {
  if (!isAlive(interactiveTerminal)) {
    interactiveTerminal = createRcTerminal("RC", []);
  }
  interactiveTerminal?.show(true);
}

export function runRcCommit(all = false): void {
  // A finished commit run leaves its terminal open with the output; replace it.
  commitTerminal?.dispose();
  commitTerminal = createRcTerminal("RC Commit", all ? ["-c", "-a"] : ["-c"]);
  commitTerminal?.show(true);
}

/** @deprecated Kept for callers of the old API; prefer runRcInteractive / runRcCommit. */
export function runRcInTerminal(args: string[]): void {
  createRcTerminal("RC", args)?.show(true);
}
