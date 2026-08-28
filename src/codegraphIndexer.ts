import * as path from "path";
import * as vscode from "vscode";
import {
  cgcBinaryForPython,
  ensureManagedPython,
  scheduleCodegraphIndex
} from "./velocity/pythonEnv";

function managedRequirementsPath(extensionPath: string): string {
  return path.join(extensionPath, "velocity-daemon", "requirements.txt");
}

function workspaceRoots(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
}

/**
 * Prepare the shared Python environment and start background code-graph indexing
 * for every open workspace folder. Never blocks activation.
 */
export function startCodegraphBackgroundIndexer(context: vscode.ExtensionContext): void {
  const requirements = managedRequirementsPath(context.extensionPath);

  const warm = async () => {
    const python = await ensureManagedPython(requirements, { quiet: true });
    if (!python) {
      return;
    }
    const cgcBin = cgcBinaryForPython(python);
    for (const root of workspaceRoots()) {
      scheduleCodegraphIndex(root, cgcBin);
    }
  };

  void warm();

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      void (async () => {
        const python = await ensureManagedPython(requirements, { quiet: true });
        if (!python) {
          return;
        }
        const cgcBin = cgcBinaryForPython(python);
        for (const folder of event.added) {
          scheduleCodegraphIndex(folder.uri.fsPath, cgcBin);
        }
      })();
    })
  );
}
