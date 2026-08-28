import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerSecret } from "./redact.mjs";

export const evalsRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const repoRoot = path.resolve(evalsRoot, "..");

/**
 * Token discovery mirrors `resolveDeepSeekToken()` in src/rcProcess.ts: the
 * environment first, then ~/.config/rp-cli/.env. The VS Code setting is not
 * reachable from a plain Node process, so it is not consulted.
 */
export function resolveToken() {
  const fromEnv = (process.env.DEEPSEEK_TOKEN ?? "").trim();
  if (fromEnv) {
    registerSecret(fromEnv);
    return fromEnv;
  }
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
    value = value.trim();
    registerSecret(value);
    return value;
  } catch {
    return "";
  }
}

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Locate the overlaid rp-cli entry point. Prefers `vendor/`, which is what the
 * packaged extension actually ships, and falls back to the copy the overlay is
 * also applied to under node_modules (the local F5 path).
 */
export function resolveCliJs(override) {
  const candidates = [
    override,
    path.join(repoRoot, "vendor", "rp-cli", "dist", "source", "cli.js"),
    path.join(repoRoot, "node_modules", "@rezaparsian", "rp-cli", "dist", "source", "cli.js")
  ].filter(Boolean);

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (isFile(resolved)) {
      return resolved;
    }
  }
  return "";
}

export function resolveNode() {
  const name = process.platform === "win32" ? "node.exe" : "node";
  const bundled = path.join(repoRoot, "vendor", "node", `${process.platform}-${process.arch}`, name);
  if (isFile(bundled)) {
    return bundled;
  }
  // The harness itself is Node, so this always exists.
  return process.execPath;
}

export function gitAvailable() {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
