import { spawn, execFileSync, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { sanitizeDeepSeekToken } from "./tokenSetup";

export type UiAgentMode = "ask" | "write" | "auto";
export type ThinkingEffort = "off" | "low" | "medium" | "hard";

let extensionPath: string | undefined;

/** Call once from activate() so the bundled CLI can be found on any machine. */
export function setExtensionPath(extPath: string): void {
  extensionPath = extPath;
}

function getWorkspaceCwd(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function getConfiguredToken(): string {
  return vscode.workspace.getConfiguration("rc").get<string>("token")?.trim() || "";
}

function readTokenFromConfigFile(): string {
  try {
    const envPath = path.join(os.homedir(), ".config", "rp-cli", ".env");
    const raw = fs.readFileSync(envPath, "utf8");
    const match = raw.match(/^\s*DEEPSEEK_TOKEN\s*=\s*(.*)$/m);
    if (!match) {
      return "";
    }
    let value = match[1].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value.trim();
  } catch {
    return "";
  }
}

export function resolveDeepSeekToken(): string {
  const fromSettings = sanitizeDeepSeekToken(getConfiguredToken());
  if (fromSettings) {
    return fromSettings;
  }
  return sanitizeDeepSeekToken(readTokenFromConfigFile());
}

function existsFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function firstExistingFile(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    if (candidate && existsFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function nodeBinaryName(): string {
  return process.platform === "win32" ? "node.exe" : "node";
}

/** Extra PATH entries GUI-launched VS Code often lacks (nvm/fnm/volta/asdf). */
function extraNodeBinDirs(): string[] {
  const home = os.homedir();
  const dirs = [
    "/usr/local/bin",
    "/usr/bin",
    "/opt/homebrew/bin",
    "/snap/bin",
    path.join(home, ".local", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".asdf", "shims"),
    path.join(home, ".fnm"),
    path.join(home, ".nvm", "current", "bin")
  ];

  const nvmVersions = path.join(home, ".nvm", "versions", "node");
  try {
    const versions = fs.readdirSync(nvmVersions).sort().reverse();
    for (const version of versions) {
      dirs.push(path.join(nvmVersions, version, "bin"));
    }
  } catch {
    // ignore
  }

  const fnmRoot = path.join(home, ".local", "share", "fnm", "node-versions");
  try {
    const versions = fs.readdirSync(fnmRoot).sort().reverse();
    for (const version of versions) {
      dirs.push(path.join(fnmRoot, version, "installation", "bin"));
    }
  } catch {
    // ignore
  }

  return dirs;
}

function lookupNodeOnPath(searchPath: string): string | undefined {
  const name = nodeBinaryName();
  for (const dir of searchPath.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, name);
    if (existsFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function lookupNodeViaLoginShell(): string | undefined {
  if (process.platform === "win32") {
    return undefined;
  }

  const shells = [
    process.env.SHELL,
    "/bin/bash",
    "/bin/zsh",
    "/bin/sh"
  ].filter((value, index, all): value is string => Boolean(value) && all.indexOf(value) === index);

  for (const shell of shells) {
    try {
      const found = execFileSync(shell, ["-lc", "command -v node"], {
        encoding: "utf8",
        timeout: 4000,
        env: process.env
      })
        .trim()
        .split(/\r?\n/)[0];
      if (found && existsFile(found)) {
        return found;
      }
    } catch {
      // ignore
    }
  }

  return undefined;
}

function bundledNodePath(): string | undefined {
  if (!extensionPath) {
    return undefined;
  }

  const name = nodeBinaryName();
  const candidate = path.join(extensionPath, "vendor", "node", `${process.platform}-${process.arch}`, name);
  if (!existsFile(candidate)) {
    return undefined;
  }

  if (process.platform !== "win32") {
    try {
      fs.chmodSync(candidate, 0o755);
    } catch {
      // ignore
    }
  }

  return candidate;
}

/**
 * Prefer the Node binary shipped inside the extension so users do not need to
 * install Node.js. Fall back to a system Node if the bundle is missing.
 */
export function resolveNodePath(): string {
  const configured = vscode.workspace.getConfiguration("rc").get<string>("nodePath")?.trim();
  if (configured && existsFile(configured)) {
    return configured;
  }

  const bundled = bundledNodePath();
  if (bundled) {
    return bundled;
  }

  const fromProcessPath = lookupNodeOnPath(process.env.PATH || "");
  if (fromProcessPath) {
    return fromProcessPath;
  }

  const extraDirs = extraNodeBinDirs();
  const fromExtra = lookupNodeOnPath(extraDirs.join(path.delimiter));
  if (fromExtra) {
    return fromExtra;
  }

  if (process.platform === "win32") {
    try {
      const found = execFileSync("where.exe", ["node"], {
        encoding: "utf8",
        windowsHide: true
      })
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.toLowerCase().endsWith("node.exe"));
      if (found && existsFile(found)) {
        return found;
      }
    } catch {
      // ignore
    }

    const winFallback = firstExistingFile([
      path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe"),
      path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "nodejs", "node.exe")
    ]);
    if (winFallback) {
      return winFallback;
    }
  } else {
    const viaShell = lookupNodeViaLoginShell();
    if (viaShell) {
      return viaShell;
    }

    const unixFallback = firstExistingFile([
      "/usr/bin/node",
      "/usr/local/bin/node",
      "/opt/homebrew/bin/node",
      "/snap/bin/node"
    ]);
    if (unixFallback) {
      return unixFallback;
    }
  }

  return "";
}

function nodeSearchPath(): string {
  const bundled = bundledNodePath();
  const bundledDir = bundled ? path.dirname(bundled) : "";
  const extra = extraNodeBinDirs().join(path.delimiter);
  return [bundledDir, process.env.PATH || "", extra].filter(Boolean).join(path.delimiter);
}

/**
 * Resolve the bundled / installed rp-cli entry. Independent of whichever folder
 * the user has open in the workspace.
 */
export function resolveCliJsPath(): string | undefined {
  const configured = vscode.workspace.getConfiguration("rc").get<string>("cliPath")?.trim();
  if (configured) {
    if (configured.endsWith(".js") && existsFile(configured)) {
      return configured;
    }
    const asDir = path.join(configured, "dist", "source", "cli.js");
    if (existsFile(asDir)) {
      return asDir;
    }
  }

  const candidates: string[] = [];

  // 1) Self-contained CLI shipped inside the extension (any machine / any folder)
  if (extensionPath) {
    candidates.push(
      path.join(extensionPath, "vendor", "rp-cli", "dist", "source", "cli.js")
    );
    candidates.push(
      path.join(
        extensionPath,
        "node_modules",
        "@rezaparsian",
        "rp-cli",
        "dist",
        "source",
        "cli.js"
      )
    );
  }

  // 2) Global npm install of the same package
  try {
    const npmRoot = execFileSync("npm", ["root", "-g"], {
      encoding: "utf8",
      windowsHide: true,
      shell: process.platform === "win32"
    }).trim();
    if (npmRoot) {
      candidates.push(path.join(npmRoot, "@rezaparsian", "rp-cli", "dist", "source", "cli.js"));
    }
  } catch {
    // ignore
  }

  candidates.push(
    path.join(
      os.homedir(),
      "AppData",
      "Roaming",
      "npm",
      "node_modules",
      "@rezaparsian",
      "rp-cli",
      "dist",
      "source",
      "cli.js"
    )
  );

  for (const candidate of candidates) {
    const resolved = path.normalize(candidate);
    if (existsFile(resolved)) {
      return resolved;
    }
  }

  return undefined;
}

export function uiModeToCliMode(mode: UiAgentMode): string {
  if (mode === "ask") return "ask";
  if (mode === "auto") return "auto";
  return "write";
}

/** Expand @path mentions so the model sees concrete file references under cwd. */
export function expandAtMentions(prompt: string, cwd: string | undefined): string {
  if (!cwd) {
    return prompt;
  }

  return prompt.replace(/(^|\s)@([^\s@]+)/g, (full, prefix: string, mention: string) => {
    const cleaned = mention.replace(/^["']|["']$/g, "");
    const absolute = path.isAbsolute(cleaned) ? cleaned : path.resolve(cwd, cleaned);
    try {
      const relative = path.relative(cwd, absolute).replace(/\\/g, "/");
      if (relative.startsWith("..")) {
        return full;
      }
      const stat = fs.statSync(absolute);
      if (stat.isDirectory() || stat.isFile()) {
        return `${prefix}@${relative}`;
      }
    } catch {
      // keep original mention
    }
    return full;
  });
}

export type ChatTurn = { role: "user" | "assistant"; content: string };

export function buildPromptWithHistory(prompt: string, history: ChatTurn[]): string {
  if (history.length === 0) {
    return prompt;
  }

  const lines = ["Previous conversation:"];
  for (const turn of history.slice(-8)) {
    lines.push(`${turn.role === "user" ? "User" : "Assistant"}: ${turn.content}`);
  }
  lines.push("", "Current user message:", prompt);
  return lines.join("\n");
}

export type PlainPromptResult = {
  ok: boolean;
  cancelled?: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  cliJs?: string;
};

type PromptSession = {
  child: ChildProcess;
  aborted: boolean;
};

let currentSession: PromptSession | undefined;

function killChildProcess(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) {
    return;
  }

  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        timeout: 8000,
        stdio: "ignore"
      });
      return;
    } catch {
      // fall through to child.kill
    }
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
    setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }, 800);
    return;
  }

  try {
    child.kill();
  } catch {
    // ignore
  }
}

/** Stop the in-flight `rc --plain` run, if any. */
export function abortPlainPrompt(): boolean {
  const session = currentSession;
  if (!session) {
    return false;
  }
  session.aborted = true;
  killChildProcess(session.child);
  return true;
}

export function runPlainPrompt(
  prompt: string,
  mode: UiAgentMode = "write",
  history: ChatTurn[] = [],
  options: { search?: boolean; thinking?: boolean; thinkingEffort?: ThinkingEffort } = {}
): Promise<PlainPromptResult> {
  const token = resolveDeepSeekToken();
  if (!token) {
    return Promise.resolve({
      ok: false,
      stdout: "",
      stderr:
        "DeepSeek token not found. Use /token or RC: Set DeepSeek Token.",
      code: 1
    });
  }

  const cliJs = resolveCliJsPath();
  if (!cliJs) {
    return Promise.resolve({
      ok: false,
      stdout: "",
      stderr:
        "Bundled rp-cli is missing from the extension. Reinstall the extension (VSIX) or run npm install in the extension folder.",
      code: 1
    });
  }

  const nodePath = resolveNodePath();
  if (!nodePath) {
    return Promise.resolve({
      ok: false,
      stdout: "",
      stderr:
        "Bundled Node.js is missing from this install. Reinstall RC from the latest VSIX (0.1.3+).",
      code: 1
    });
  }

  const cwd = getWorkspaceCwd() || os.homedir();
  const expanded = expandAtMentions(prompt, getWorkspaceCwd());
  const fullPrompt = buildPromptWithHistory(expanded, history);
  const env = {
    ...process.env,
    PATH: nodeSearchPath(),
    DEEPSEEK_TOKEN: token
  };

  const thinkingEffort: ThinkingEffort =
    options.thinkingEffort || (options.thinking ? "medium" : "off");

  const args = [cliJs, "--plain", "--mode", uiModeToCliMode(mode)];
  if (options.search) {
    args.push("--search");
  }
  if (thinkingEffort !== "off") {
    args.push("--thinking-effort", thinkingEffort);
  }
  args.push(fullPrompt);

  return new Promise((resolve) => {
    if (currentSession) {
      currentSession.aborted = true;
      killChildProcess(currentSession.child);
    }

    const child = spawn(nodePath, args, {
      cwd,
      env,
      windowsHide: true,
      detached: process.platform !== "win32"
    });
    const session: PromptSession = { child, aborted: false };
    currentSession = session;

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: PlainPromptResult) => {
      if (settled) {
        return;
      }
      settled = true;
      if (currentSession === session) {
        currentSession = undefined;
      }
      resolve(result);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      finish({
        ok: false,
        cancelled: session.aborted,
        stdout,
        stderr: session.aborted
          ? ""
          : `Could not start the bundled Node.js (${error.message}).\nnode=${nodePath}\ncli=${cliJs}\nReinstall the RC extension.`,
        code: 1,
        cliJs
      });
    });
    child.on("close", (code) => {
      finish({
        ok: !session.aborted && code === 0 && Boolean(stdout.trim()),
        cancelled: session.aborted,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        code,
        cliJs
      });
    });
  });
}
