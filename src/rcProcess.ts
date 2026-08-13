import { spawn, execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { sanitizeDeepSeekToken } from "./tokenSetup";

export type UiAgentMode = "ask" | "write" | "auto";

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

export function resolveNodePath(): string {
  const configured = vscode.workspace.getConfiguration("rc").get<string>("nodePath")?.trim();
  if (configured && existsFile(configured)) {
    return configured;
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

    const fallbacks = [
      path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe"),
      path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "nodejs", "node.exe")
    ];
    for (const candidate of fallbacks) {
      if (existsFile(candidate)) {
        return candidate;
      }
    }
  } else {
    try {
      const found = execFileSync("which", ["node"], { encoding: "utf8" }).trim();
      if (found && existsFile(found)) {
        return found;
      }
    } catch {
      // ignore
    }
  }

  return "node";
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
  stdout: string;
  stderr: string;
  code: number | null;
  cliJs?: string;
};

export function runPlainPrompt(
  prompt: string,
  mode: UiAgentMode = "write",
  history: ChatTurn[] = [],
  options: { search?: boolean; thinking?: boolean } = {}
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
  const cwd = getWorkspaceCwd() || os.homedir();
  const expanded = expandAtMentions(prompt, getWorkspaceCwd());
  const fullPrompt = buildPromptWithHistory(expanded, history);
  const env = {
    ...process.env,
    DEEPSEEK_TOKEN: token
  };

  const args = [cliJs, "--plain", "--mode", uiModeToCliMode(mode)];
  if (options.search) {
    args.push("--search");
  }
  if (options.thinking) {
    args.push("--thinking");
  }
  args.push(fullPrompt);

  return new Promise((resolve) => {
    const child = spawn(nodePath, args, {
      cwd,
      env,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      resolve({
        ok: false,
        stdout,
        stderr: `${error.message}\nnode=${nodePath}\ncli=${cliJs}`,
        code: 1,
        cliJs
      });
    });
    child.on("close", (code) => {
      resolve({
        ok: code === 0 && Boolean(stdout.trim()),
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        code,
        cliJs
      });
    });
  });
}
