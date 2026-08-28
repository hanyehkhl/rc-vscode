import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

/**
 * Ground truth for the verify loop.
 *
 * Editor diagnostics are fast but partial — they only cover files a language
 * server has actually analyzed. Running the project's real type-checker closes
 * that gap: the agent stops saying "this should work" and gets a compiler
 * verdict instead.
 *
 * Only non-mutating checks are auto-detected. Anything that writes build output
 * has to be opted into explicitly via `rc.agent.checkCommand`.
 */

const MAX_OUTPUT_CHARS = 6000;
const DEFAULT_TIMEOUT_MS = 90_000;

export type CheckResult = {
  ran: boolean;
  ok: boolean;
  label: string;
  output: string;
};

function readJson(filePath: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function exists(root: string, name: string): boolean {
  try {
    return fs.existsSync(path.join(root, name));
  } catch {
    return false;
  }
}

export type DetectedCheck = { command: string; label: string };

/** Pick a non-mutating check for whatever kind of project this is. */
export function detectCheckCommand(root: string): DetectedCheck | undefined {
  if (exists(root, "package.json")) {
    const pkg = readJson(path.join(root, "package.json"));
    const scripts = (pkg?.scripts ?? {}) as Record<string, string>;

    // A script the project already defines is the most trustworthy signal.
    for (const name of ["typecheck", "type-check", "tsc", "lint"]) {
      if (typeof scripts[name] === "string") {
        return { command: `npm run ${name}`, label: `npm run ${name}` };
      }
    }
    if (exists(root, "tsconfig.json")) {
      return { command: "npx --no-install tsc -p . --noEmit", label: "tsc --noEmit" };
    }
  }

  if (exists(root, "Cargo.toml")) {
    return { command: "cargo check --quiet", label: "cargo check" };
  }
  if (exists(root, "go.mod")) {
    return { command: "go vet ./...", label: "go vet" };
  }

  return undefined;
}

function truncate(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_OUTPUT_CHARS) {
    return trimmed;
  }
  // Compilers put the useful summary last, so keep both ends.
  return [
    trimmed.slice(0, MAX_OUTPUT_CHARS / 2),
    `\n… [${trimmed.length - MAX_OUTPUT_CHARS} characters omitted] …\n`,
    trimmed.slice(-MAX_OUTPUT_CHARS / 2)
  ].join("");
}

/**
 * Run the configured (or detected) project check.
 * Returns `ran: false` when there is nothing sensible to run.
 */
export function runProjectCheck(): Promise<CheckResult> {
  const empty: CheckResult = { ran: false, ok: true, label: "", output: "" };
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    return Promise.resolve(empty);
  }

  const config = vscode.workspace.getConfiguration("rc.agent");
  if (!config.get<boolean>("runChecks", true)) {
    return Promise.resolve(empty);
  }

  const configured = config.get<string>("checkCommand", "").trim();
  const detected = configured
    ? { command: configured, label: configured }
    : detectCheckCommand(root);

  if (!detected) {
    return Promise.resolve(empty);
  }

  const timeout = Math.max(5000, config.get<number>("checkTimeoutMs", DEFAULT_TIMEOUT_MS));

  return new Promise((resolve) => {
    execFile(
      detected.command,
      {
        cwd: root,
        shell: true,
        timeout,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        const output = truncate(`${stdout ?? ""}\n${stderr ?? ""}`);

        if (!error) {
          resolve({ ran: true, ok: true, label: detected.label, output });
          return;
        }

        // A missing tool is not a failing project — do not send the agent
        // chasing a problem that only exists on this machine.
        const message = String(error.message || "");
        if (/not recognized|command not found|ENOENT/i.test(message) && !output) {
          resolve(empty);
          return;
        }

        resolve({
          ran: true,
          ok: false,
          label: detected.label,
          output: output || message
        });
      }
    );
  });
}
