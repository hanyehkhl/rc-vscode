import * as vscode from "vscode";

/**
 * DeepSeek API configuration (platform.deepseek.com), shared by two providers:
 *
 * - "deepseek": the built-in agent loop (same tools as Ashna) against the
 *   OpenAI-compatible DeepSeek API.
 * - "hermes": Nous Research's Hermes Agent CLI, driven with the same key.
 *
 * This is the paid API key, not the chat.deepseek.com web token the bundled
 * rc CLI uses. The key lives in SecretStorage; everything else is a setting.
 */

export const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_DEFAULT_MODEL = "deepseek-chat";
export const DEEPSEEK_KEYS_URL = "https://platform.deepseek.com/api_keys";

const SECRET_KEY = "rc.deepseek.apiKey";
const CUSTOM_SECRET_KEY = "rc.hermesFree.customApiKey";
const REMOTE_SECRET_KEY = "rc.hermesRemote.apiKey";
const MIN_KEY_LENGTH = 16;

let secrets: vscode.SecretStorage | undefined;
let cachedKey = "";
let cachedCustomKey = "";
let cachedRemoteKey = "";

/** Call once from activate(). */
export async function initDeepSeekConfig(storage: vscode.SecretStorage): Promise<void> {
  secrets = storage;
  cachedKey = (await storage.get(SECRET_KEY))?.trim() ?? "";
  cachedCustomKey = (await storage.get(CUSTOM_SECRET_KEY))?.trim() ?? "";
  cachedRemoteKey = (await storage.get(REMOTE_SECRET_KEY))?.trim() ?? "";
  storage.onDidChange(async (event) => {
    if (event.key === REMOTE_SECRET_KEY) {
      cachedRemoteKey = (await storage.get(REMOTE_SECRET_KEY))?.trim() ?? "";
    }
    if (event.key === SECRET_KEY) {
      cachedKey = (await storage.get(SECRET_KEY))?.trim() ?? "";
    }
    if (event.key === CUSTOM_SECRET_KEY) {
      cachedCustomKey = (await storage.get(CUSTOM_SECRET_KEY))?.trim() ?? "";
    }
  });
}

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("rc");
}

export function getDeepSeekApiKey(): string {
  return cachedKey;
}

export function hasDeepSeekApiKey(): boolean {
  return cachedKey.length > 0;
}

export async function saveDeepSeekApiKey(raw: string): Promise<void> {
  const key = raw.trim().replace(/^["']|["']$/g, "").replace(/^Bearer\s+/i, "").trim();
  if (key.length < MIN_KEY_LENGTH || /\s/.test(key)) {
    throw new Error("That does not look like a DeepSeek API key (platform.deepseek.com → API keys).");
  }
  if (!secrets) throw new Error("DeepSeek config is not initialised.");
  await secrets.store(SECRET_KEY, key);
  cachedKey = key;
}

export async function clearDeepSeekApiKey(): Promise<void> {
  await secrets?.delete(SECRET_KEY);
  cachedKey = "";
}

export function getDeepSeekSettings(): { baseUrl: string; model: string } {
  const cfg = config();
  return {
    baseUrl: (cfg.get<string>("deepseek.baseUrl") || DEEPSEEK_DEFAULT_BASE_URL).trim().replace(/\/+$/, ""),
    model: (cfg.get<string>("deepseek.model") || DEEPSEEK_DEFAULT_MODEL).trim()
  };
}

export async function setDeepSeekModel(model: string): Promise<void> {
  await config().update("deepseek.model", model.trim(), vscode.ConfigurationTarget.Global);
}

export type HermesSettings = {
  /** Executable name or absolute path of the Hermes Agent CLI. */
  command: string;
  /** Hermes --provider value. */
  provider: string;
  model: string;
  toolsets: string;
  timeoutMs: number;
  /** "auto" (local CLI, else a running hermes-agent container), "off", or a container name. */
  container: string;
  /** Host path prefix → container path prefix, for the workspace. */
  pathMappings: Record<string, string>;
};

/** Model Hermes asks the Hermes Free gateway for; reasoner turns on web "DeepThink". */
export function getHermesFreeModel(): string {
  return (config().get<string>("hermesFree.model") || DEEPSEEK_DEFAULT_MODEL).trim();
}

/**
 * Where Hermes Free's gateway gets its answers: the free DeepSeek web chat, or
 * any OpenAI-compatible endpoint (Ollama, vLLM, LM Studio, your own server).
 */
export type HermesFreeSource = "deepseek-web" | "custom";

export function getHermesFreeSource(): HermesFreeSource {
  return config().get<string>("hermesFree.source") === "custom" ? "custom" : "deepseek-web";
}

export type CustomEndpoint = { baseUrl: string; model: string; apiKey: string };

/** The custom endpoint, or undefined until both URL and model are set. */
export function getCustomEndpoint(): CustomEndpoint | undefined {
  const cfg = config();
  const baseUrl = (cfg.get<string>("hermesFree.custom.baseUrl") || "").trim().replace(/\/+$/, "");
  const model = (cfg.get<string>("hermesFree.custom.model") || "").trim();
  return baseUrl && model ? { baseUrl, model, apiKey: cachedCustomKey } : undefined;
}

export async function saveCustomApiKey(raw: string): Promise<void> {
  if (!secrets) throw new Error("DeepSeek config is not initialised.");
  const key = raw.trim().replace(/^Bearer\s+/i, "");
  if (key) await secrets.store(CUSTOM_SECRET_KEY, key);
  else await secrets.delete(CUSTOM_SECRET_KEY);
  cachedCustomKey = key;
}

export function getHermesSettings(): HermesSettings {
  const cfg = config();
  const timeout = cfg.get<number>("hermes.timeoutMs");
  return {
    command: (cfg.get<string>("hermes.command") || "hermes").trim(),
    provider: (cfg.get<string>("hermes.provider") || "deepseek").trim(),
    model: (cfg.get<string>("hermes.model") || DEEPSEEK_DEFAULT_MODEL).trim(),
    toolsets: (cfg.get<string>("hermes.toolsets") || "").trim(),
    timeoutMs: typeof timeout === "number" && timeout > 0 ? Math.floor(timeout) : 900_000,
    container: (cfg.get<string>("hermes.docker.container") ?? "auto").trim(),
    pathMappings: cfg.get<Record<string, string>>("hermes.docker.pathMappings") ?? {}
  };
}

/**
 * Hermes running elsewhere (a server, another machine), reached through its API
 * server: base URL in settings, API_SERVER_KEY in the OS keychain.
 */
export function getHermesRemote(): { baseUrl: string; apiKey: string } | undefined {
  const baseUrl = (config().get<string>("hermesRemote.url") || "").trim();
  return baseUrl ? { baseUrl, apiKey: cachedRemoteKey } : undefined;
}

export async function saveHermesRemote(baseUrl: string, apiKey: string): Promise<void> {
  if (!secrets) throw new Error("DeepSeek config is not initialised.");
  await config().update("hermesRemote.url", baseUrl.trim(), vscode.ConfigurationTarget.Global);
  const key = apiKey.trim().replace(/^Bearer\s+/i, "");
  await secrets.store(REMOTE_SECRET_KEY, key);
  cachedRemoteKey = key;
}
