import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { runPlainPrompt } from "./rcProcess";

/**
 * rp-cli injects a repository's `AGENTS.md` into the system prompt as ground
 * truth (see prompts/index.js). It is the cheapest large quality win available,
 * so give the user a one-click way to create one.
 */

const INIT_PROMPT = [
  "Create an `AGENTS.md` file at the root of this repository.",
  "",
  "First inspect the project: read the manifest (package.json, pyproject.toml,",
  "go.mod, Cargo.toml, …), list the top-level directories, and open a few key",
  "source files. Base everything on what you actually find — do not guess.",
  "",
  "Then write `AGENTS.md` with these sections:",
  "",
  "1. **Overview** — what this project is, in two or three sentences.",
  "2. **Architecture** — the main directories and what each is responsible for,",
  "   plus how the pieces talk to each other.",
  "3. **Commands** — the real build, test, lint, and run commands from the manifest.",
  "4. **Conventions** — language, formatting, naming, and error-handling patterns",
  "   that are visibly followed in the existing code.",
  "5. **Gotchas** — anything non-obvious that would trip up someone editing this",
  "   repository for the first time.",
  "",
  "Keep it under 150 lines and concrete. Skip generic advice that would apply to",
  "any project. Write the file with `write_file`; do not paste it into the chat."
].join("\n");

export async function initAgentsFile(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    void vscode.window.showErrorMessage("RC: open a folder first.");
    return;
  }

  const target = path.join(root, "AGENTS.md");
  if (fs.existsSync(target)) {
    const choice = await vscode.window.showWarningMessage(
      "AGENTS.md already exists. Regenerate it?",
      { modal: true },
      "Regenerate"
    );
    if (choice !== "Regenerate") {
      return;
    }
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "RC: analyzing the project and writing AGENTS.md…",
      cancellable: false
    },
    async () => {
      const result = await runPlainPrompt(INIT_PROMPT, "auto", [], {
        thinkingEffort: "medium",
        maxToolRounds: 20
      });

      if (!result.ok) {
        void vscode.window.showErrorMessage(
          `RC: could not generate AGENTS.md. ${result.stderr || result.stdout}`.trim()
        );
        return;
      }

      if (!fs.existsSync(target)) {
        void vscode.window.showWarningMessage(
          "RC: the agent finished but did not write AGENTS.md. See the chat panel for details."
        );
        return;
      }

      const document = await vscode.workspace.openTextDocument(target);
      await vscode.window.showTextDocument(document);
      void vscode.window.showInformationMessage(
        "RC: AGENTS.md created. It is now injected into every prompt as project ground truth."
      );
    }
  );
}
