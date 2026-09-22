import * as vscode from "vscode";

/**
 * Ashna configuration.
 *
 * The API key is a secret, so it lives in VS Code SecretStorage (OS keychain),
 * never in settings.json. Non-secret choices (model, agent id, base URL) are
 * ordinary settings so users can also edit them from the Settings UI.
 */

export type ChatProviderId = "rc" | "ashna";

export const ASHNA_DEFAULT_BASE_URL = "https://api.ashna.ai/v1/api";
export const ASHNA_DEFAULT_MODEL = "claude-fable-5";
export const ASHNA_KEYS_URL = "https://app.ashna.ai/account";
export const ASHNA_DOCS_URL = "https://www.ashna.ai/api-docs";

const SECRET_KEY = "rc.ashna.apiKey";
const MIN_KEY_LENGTH = 16;

let secrets: vscode.SecretStorage | undefined;
let cachedKey = "";

/** Call once from activate(). Loads the key into memory so sync checks work. */
export async function initAshnaConfig(storage: vscode.SecretStorage): Promise<void> {
  secrets = storage;
  cachedKey = (await storage.get(SECRET_KEY))?.trim() ?? "";
  storage.onDidChange(async (event) => {
    if (event.key === SECRET_KEY) {
      cachedKey = (await storage.get(SECRET_KEY))?.trim() ?? "";
    }
  });
}

function requireSecrets(): vscode.SecretStorage {
  if (!secrets) {
    throw new Error("Ashna config is not initialised (initAshnaConfig was not called).");
  }
  return secrets;
}

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("rc");
}

export function getActiveProvider(): ChatProviderId {
  return config().get<string>("provider") === "ashna" ? "ashna" : "rc";
}

export async function setActiveProvider(provider: ChatProviderId): Promise<void> {
  await config().update("provider", provider, vscode.ConfigurationTarget.Global);
}

/** Strip whitespace, quotes and an accidental "Bearer " prefix. */
export function sanitizeAshnaKey(raw: string): string {
  let value = raw.trim().replace(/^﻿/, "");
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value.replace(/^Bearer\s+/i, "").trim();
}

export function getAshnaApiKey(): string {
  return cachedKey;
}

export function hasAshnaApiKey(): boolean {
  return cachedKey.length > 0;
}

export async function saveAshnaApiKey(raw: string): Promise<void> {
  const key = sanitizeAshnaKey(raw);
  if (!key) {
    throw new Error("API key is empty.");
  }
  if (key.length < MIN_KEY_LENGTH || /\s/.test(key)) {
    throw new Error("That does not look like an Ashna API key. Copy it again from Account → API.");
  }
  await requireSecrets().store(SECRET_KEY, key);
  cachedKey = key;
}

export async function clearAshnaApiKey(): Promise<void> {
  await requireSecrets().delete(SECRET_KEY);
  cachedKey = "";
}

export type AshnaSettings = {
  baseUrl: string;
  /** Foundation model used for Agent modes (client tools run in the workspace). */
  model: string;
  /** Optional custom agent id; used for Chat mode (server-side prompt + tools). */
  agentId: string;
  /** Also route Agent modes to the custom agent (experimental — see README). */
  useAgentForAgentModes: boolean;
  maxToolRounds: number;
  requestTimeoutMs: number;
  commandTimeoutMs: number;
  editorContext: boolean;
};

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function getAshnaSettings(): AshnaSettings {
  const cfg = config();
  const baseUrl = (cfg.get<string>("ashna.baseUrl") || ASHNA_DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  return {
    baseUrl,
    model: (cfg.get<string>("ashna.model") || ASHNA_DEFAULT_MODEL).trim(),
    agentId: (cfg.get<string>("ashna.agentId") || "").trim(),
    useAgentForAgentModes: cfg.get<boolean>("ashna.useAgentForAgentModes") === true,
    maxToolRounds: positiveNumber(cfg.get("ashna.maxToolRounds"), 25),
    requestTimeoutMs: positiveNumber(cfg.get("ashna.requestTimeoutMs"), 180_000),
    commandTimeoutMs: positiveNumber(cfg.get("ashna.commandTimeoutMs"), 120_000),
    editorContext: cfg.get<boolean>("agent.editorContext") !== false
  };
}

export async function updateAshnaSettings(
  patch: Partial<Pick<AshnaSettings, "model" | "agentId">>
): Promise<void> {
  const cfg = config();
  if (patch.model !== undefined) {
    await cfg.update("ashna.model", patch.model.trim(), vscode.ConfigurationTarget.Global);
  }
  if (patch.agentId !== undefined) {
    await cfg.update("ashna.agentId", patch.agentId.trim(), vscode.ConfigurationTarget.Global);
  }
}
