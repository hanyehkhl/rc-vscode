import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

export const DEEPSEEK_URL = "https://chat.deepseek.com/";
export const DEEPSEEK_TOKEN_COMMAND = "JSON.parse(localStorage.getItem('userToken')).value";

export function tokenConfigDirectory(): string {
  return path.join(os.homedir(), ".config", "rp-cli");
}

export function tokenConfigPath(): string {
  return path.join(tokenConfigDirectory(), ".env");
}

/** Strip quotes / Bearer / accidental console copy junk. */
export function sanitizeDeepSeekToken(raw: string): string {
  let value = raw.trim();
  if (!value) {
    return "";
  }

  if (/localStorage\.getItem\s*\(\s*['"]userToken['"]\s*\)/i.test(value)) {
    return "";
  }

  for (let i = 0; i < 3; i++) {
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1).trim();
      continue;
    }
    break;
  }

  value = value.replace(/^Bearer\s+/i, "").trim();
  value = value.replace(/^\uFEFF/, "");
  return value;
}

export function openDeepSeekInBrowser(): void {
  void vscode.env.openExternal(vscode.Uri.parse(DEEPSEEK_URL));
}

export async function saveDeepSeekToken(token: string): Promise<string> {
  const normalized = sanitizeDeepSeekToken(token);
  if (!normalized) {
    throw new Error(
      "Token looks empty or invalid. Paste only the value from the console, not the JavaScript command."
    );
  }

  if (normalized.length < 20) {
    throw new Error("Token is too short. Copy the full value from DevTools console.");
  }

  const dir = tokenConfigDirectory();
  await fs.mkdir(dir, { recursive: true });
  const filePath = tokenConfigPath();
  await fs.writeFile(filePath, `DEEPSEEK_TOKEN=${JSON.stringify(normalized)}\n`, "utf8");

  try {
    await vscode.workspace.getConfiguration("rc").update("token", "", vscode.ConfigurationTarget.Global);
  } catch {
    // ignore
  }

  return filePath;
}

export async function clearDeepSeekToken(): Promise<void> {
  try {
    await fs.rm(tokenConfigPath(), { force: true });
  } catch {
    // ignore
  }
  try {
    await vscode.workspace.getConfiguration("rc").update("token", "", vscode.ConfigurationTarget.Global);
  } catch {
    // ignore
  }
}

export function getTokenSetupGuide(reason: "missing" | "expired" = "missing"): string {
  const title =
    reason === "expired"
      ? "Your DeepSeek token expired or is invalid."
      : "DeepSeek token is not configured.";

  return [
    title,
    "",
    "1. Sign in at: " + DEEPSEEK_URL,
    "2. Open the browser developer console (F12) and run:",
    DEEPSEEK_TOKEN_COMMAND,
    "3. Paste the returned value and save.",
    "",
    "Saved to: " + tokenConfigPath()
  ].join("\n");
}

export function isInvalidTokenOutput(text: string): boolean {
  return /invalid deepseek token|token is invalid|token.*(expired|invalid)|RC_INVALID_TOKEN/i.test(
    text
  );
}
