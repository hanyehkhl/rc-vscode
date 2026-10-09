import { execFile, spawn, type ChildProcess } from "child_process";
import * as vscode from "vscode";
import type { ChatTurn, UiAgentMode } from "../rcProcess";
import { getDeepSeekApiKey, getDeepSeekSettings, getHermesSettings } from "../deepseek/config";
import {
  cleanupContainerTurn,
  detectHermesContainer,
  dockerExecInvocation,
  isContainerRunning,
  killContainerTurn,
  mapPathIntoContainer,
  containerHostRoute,
  isLoopbackUrl,
  toContainerUrl
} from "./docker";

/**
 * Runs one chat turn through Nous Research's Hermes Agent CLI
 * (https://github.com/NousResearch/hermes-agent).
 *
 * Hermes brings its own agent loop, tools, memory and skills; we hand it the
 * prompt on stdin in quiet one-shot mode (`hermes chat -Q --query-file -`),
 * point it at the workspace with `--in`, and pass the DeepSeek API key through
 * the environment so nothing is written to Hermes' own config.
 *
 * Hermes can run either as a local CLI or inside a Docker container
 * (rc.hermes.docker.container; "auto" picks a running hermes-agent container
 * when no local CLI is installed). See docker.ts.
 */

export const HERMES_INSTALL_URL = "https://github.com/NousResearch/hermes-agent#installation";

const HISTORY_TURNS = 6;
const TURN_CHAR_LIMIT = 2_000;
const MAX_OUTPUT_CHARS = 400_000;

export type HermesTurnOptions = {
  mode: UiAgentMode;
  history: ChatTurn[];
  onStatus: (text: string) => void;
  onPreview: (text: string) => void;
  /** Overrides the DeepSeek API endpoint, e.g. the local Hermes Free gateway. */
  endpoint?: {
    baseUrl: string;
    apiKey: string;
    model: string;
    label: string;
    /** Makes a loopback endpoint reachable on another local address (Linux Docker bridge). */
    expose?: (host: string) => Promise<string>;
  };
};

export type HermesTurnResult =
  | { ok: true; text: string }
  | { ok: false; cancelled: boolean; error: string; notInstalled?: boolean };

let activeChild: ChildProcess | undefined;
let activeContainerTurn: { container: string; turnId: string } | undefined;
let cancelled = false;
let localCliKnown: string | undefined;

type Runtime = { kind: "local" } | { kind: "docker"; container: string };

function localCliWorks(command: string): Promise<boolean> {
  if (localCliKnown === command) return Promise.resolve(true);
  return new Promise((resolve) => {
    execFile(command, ["--version"], { windowsHide: true, timeout: 15_000 }, (error) => {
      if (!error) localCliKnown = command;
      resolve(!error);
    });
  });
}

async function resolveRuntime(): Promise<Runtime | { error: string }> {
  const { command, container } = getHermesSettings();
  if (!container || container === "off") return { kind: "local" };
  if (container !== "auto") {
    return (await isContainerRunning(container))
      ? { kind: "docker", container }
      : { error: `Docker container "${container}" (rc.hermes.docker.container) is not running. Start it, e.g. docker start ${container}.` };
  }
  if (await localCliWorks(command)) return { kind: "local" };
  const detected = await detectHermesContainer();
  return detected ? { kind: "docker", container: detected } : { kind: "local" };
}

export function isHermesTurnRunning(): boolean {
  return activeChild !== undefined;
}

export function abortHermesTurn(): boolean {
  if (!activeChild) return false;
  cancelled = true;
  if (activeContainerTurn) killContainerTurn(activeContainerTurn.container, activeContainerTurn.turnId);
  killTree(activeChild);
  return true;
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }).on("error", () => undefined);
    return;
  }
  // Local runs start in their own process group (detached), so its tools and
  // subprocesses stop with it; docker exec runs fall back to the child alone.
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

/** Drops Hermes' leading "⚠" notice lines (model normalisation, scanner warnings) from the answer. */
export function stripHermesNotices(output: string): string {
  const lines = output.split(/\r?\n/);
  let start = 0;
  while (start < lines.length && /^\s*(⚠|$)/.test(lines[start])) start++;
  return lines.slice(start).join("\n").trim();
}

/** Hermes runs one-shot, so recent turns are replayed as context in the query. */
function buildQuery(text: string, mode: UiAgentMode, history: ChatTurn[]): string {
  const parts: string[] = [];
  const recent = history
    .filter((turn) => (turn.role === "user" || turn.role === "assistant") && typeof turn.content === "string")
    .slice(-HISTORY_TURNS);
  if (recent.length) {
    const lines = recent.map((turn) => {
      const content =
        turn.content.length > TURN_CHAR_LIMIT ? `${turn.content.slice(0, TURN_CHAR_LIMIT)}\n… (truncated)` : turn.content;
      return `${turn.role === "user" ? "User" : "Assistant"}: ${content}`;
    });
    parts.push(`# Earlier in this conversation\n\n${lines.join("\n\n")}`, "---");
  }
  if (mode === "ask") {
    parts.push("(Chat mode: read-only. Do not modify files or run state-changing commands; explain or propose a patch instead.)");
  }
  parts.push(text);
  return parts.join("\n\n");
}

function buildArgs(mode: UiAgentMode, root: string | undefined, model: string, provider: string): string[] {
  const settings = getHermesSettings();
  // --in is a global option, so it must come before the `chat` subcommand.
  const args = root ? ["--in", root] : [];
  args.push("chat", "-Q", "--oneshot", "--query-file", "-", "--provider", provider, "-m", model);
  if (settings.toolsets) args.push("-t", settings.toolsets);
  // Auto mode means "no approval prompts", matching the built-in agent.
  if (mode === "auto") args.push("--yolo");
  return args;
}

export async function runHermesTurn(text: string, options: HermesTurnOptions): Promise<HermesTurnResult> {
  if (activeChild) {
    return { ok: false, cancelled: false, error: "Another Hermes turn is still running." };
  }
  const settings = getHermesSettings();
  const runtime = await resolveRuntime();
  if ("error" in runtime) {
    return { ok: false, cancelled: false, error: runtime.error };
  }
  const hostRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const root = runtime.kind === "docker" && hostRoot ? mapPathIntoContainer(hostRoot, settings.pathMappings) : hostRoot;
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONIOENCODING: "utf-8", NO_COLOR: "1" };
  const endpoint = options.endpoint;
  if (endpoint) {
    // Hermes' deepseek provider reads these; the gateway speaks the same API.
    env.DEEPSEEK_API_KEY = endpoint.apiKey;
    env.DEEPSEEK_BASE_URL = endpoint.baseUrl;
  } else {
    const key = getDeepSeekApiKey();
    if (key) {
      env.DEEPSEEK_API_KEY = key;
      const { baseUrl } = getDeepSeekSettings();
      if (baseUrl) env.DEEPSEEK_BASE_URL = baseUrl;
    }
  }
  const model = endpoint?.model || settings.model;

  const hermesArgs = buildArgs(options.mode, root, model, endpoint ? "deepseek" : settings.provider);
  let command = settings.command;
  let args = hermesArgs;
  let containerTurn: { container: string; turnId: string } | undefined;
  if (runtime.kind === "docker") {
    const base = env.DEEPSEEK_BASE_URL;
    if (base && isLoopbackUrl(base)) {
      // Docker Desktop forwards host.docker.internal to our loopback; Docker
      // Engine on Linux needs us to listen on the container's bridge gateway.
      const route = await containerHostRoute(runtime.container);
      if (route.bindHost && endpoint?.expose) env.DEEPSEEK_BASE_URL = await endpoint.expose(route.bindHost);
      else if (route.bindHost) {
        return { ok: false, cancelled: false, error: `Hermes in Docker cannot reach ${base} on Linux; use a non-loopback DeepSeek base URL.` };
      } else env.DEEPSEEK_BASE_URL = toContainerUrl(base, route.host);
    }
    const forwarded = ["PYTHONIOENCODING", "NO_COLOR", ...["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"].filter((n) => env[n])];
    const invocation = dockerExecInvocation(runtime.container, hermesArgs, forwarded);
    command = invocation.command;
    args = invocation.args;
    containerTurn = { container: runtime.container, turnId: invocation.turnId };
  }

  cancelled = false;
  const where = runtime.kind === "docker" ? ` · docker:${runtime.container}${root ? "" : " (own workspace)"}` : "";
  options.onStatus(`${endpoint?.label ?? "Hermes"} · ${model}${where}…`);

  return new Promise<HermesTurnResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: runtime.kind === "docker" ? undefined : root,
        detached: process.platform !== "win32",
        env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      resolve({ ok: false, cancelled: false, error: String(error), notInstalled: true });
      return;
    }
    activeChild = child;
    activeContainerTurn = containerTurn;

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: HermesTurnResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (activeChild === child) {
        activeChild = undefined;
        activeContainerTurn = undefined;
      }
      if (containerTurn && !cancelled) cleanupContainerTurn(containerTurn.container, containerTurn.turnId);
      resolve(result);
    };
    const timer = setTimeout(() => {
      if (containerTurn) killContainerTurn(containerTurn.container, containerTurn.turnId);
      killTree(child);
      finish({ ok: false, cancelled: false, error: `Hermes did not finish within ${Math.round(settings.timeoutMs / 1000)}s.` });
    }, settings.timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk;
      options.onPreview(stdout);
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk;
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      const notInstalled = error.code === "ENOENT" && runtime.kind === "local";
      finish({
        ok: false,
        cancelled: false,
        notInstalled,
        error: notInstalled
          ? `Hermes Agent CLI "${settings.command}" was not found. Install it (${HERMES_INSTALL_URL}) or set rc.hermes.command to its full path.`
          : `Could not start Hermes: ${error.message}`
      });
    });
    child.on("close", (code) => {
      if (cancelled) {
        finish({ ok: false, cancelled: true, error: "Cancelled." });
        return;
      }
      const output = stdout.trim();
      if (code === 0) {
        finish({ ok: true, text: stripHermesNotices(output) || "(no response)" });
        return;
      }
      const detail = (stderr.trim() || output).split(/\r?\n/).slice(-15).join("\n");
      finish({ ok: false, cancelled: false, error: `Hermes exited with code ${code}.\n${detail}` });
    });

    child.stdin?.on("error", () => undefined);
    child.stdin?.end(buildQuery(text, options.mode, options.history), "utf8");
  });
}
