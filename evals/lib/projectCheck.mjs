import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./env.mjs";

/**
 * Headless port of `runProjectCheck()` from src/projectCheck.ts.
 *
 * It cannot be imported directly: that module imports `vscode`, and it reads
 * the check root from `vscode.workspace.workspaceFolders[0]`, which would point
 * at the user's open folder rather than the task's sandbox. The detection table
 * below is a deliberate mirror of `detectCheckCommand()` — if that table
 * changes in src/, change it here too.
 */

const MAX_OUTPUT_CHARS = 6000;

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function exists(root, name) {
  try {
    return fs.existsSync(path.join(root, name));
  } catch {
    return false;
  }
}

export function detectCheckCommand(root) {
  if (exists(root, "package.json")) {
    const pkg = readJson(path.join(root, "package.json"));
    const scripts = pkg?.scripts ?? {};
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

function truncate(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed.length <= MAX_OUTPUT_CHARS) {
    return trimmed;
  }
  return [
    trimmed.slice(0, MAX_OUTPUT_CHARS / 2),
    `\n… [${trimmed.length - MAX_OUTPUT_CHARS} characters omitted] …\n`,
    trimmed.slice(-MAX_OUTPUT_CHARS / 2)
  ].join("");
}

/**
 * Task sandboxes have no node_modules, so `tsc` would not resolve. Lending the
 * harness repo's own bin directory keeps the fixture free of an npm install per
 * task while leaving the detected command itself untouched.
 */
function checkPath() {
  const bin = path.join(repoRoot, "node_modules", ".bin");
  return [bin, process.env.PATH || ""].filter(Boolean).join(path.delimiter);
}

export function runProjectCheck(root, { command = "", timeoutMs = 90_000 } = {}) {
  const empty = { ran: false, ok: true, label: "", output: "", code: 0 };
  const detected = command
    ? { command, label: command }
    : detectCheckCommand(root);
  if (!detected) {
    return Promise.resolve(empty);
  }

  return new Promise((resolve) => {
    execFile(
      detected.command,
      {
        cwd: root,
        shell: true,
        timeout: Math.max(5000, timeoutMs),
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, PATH: checkPath(), Path: checkPath() }
      },
      (error, stdout, stderr) => {
        const output = truncate(`${stdout ?? ""}\n${stderr ?? ""}`);
        if (!error) {
          resolve({ ran: true, ok: true, label: detected.label, output, code: 0 });
          return;
        }
        const message = String(error.message || "");
        // A missing tool is not a failing project — same rule as production.
        if (/not recognized|command not found|ENOENT/i.test(message) && !output) {
          resolve({ ...empty, output: truncate(message) });
          return;
        }
        resolve({
          ran: true,
          ok: false,
          label: detected.label,
          output: output || truncate(message),
          code: typeof error.code === "number" ? error.code : 1
        });
      }
    );
  });
}
