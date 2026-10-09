import * as http from "http";
import * as vscode from "vscode";
import { resolveDeepSeekToken } from "../rcProcess";
import { getHermesFreeModel } from "../deepseek/config";
import { ensureRcServe, ownsRcServe, restartRcServe } from "../velocity/supervisor";
import { getVelocitySettings } from "../velocity/settings";
import { FreeGateway, rcServeUpstream, type GatewayEvent, type GatewayStats } from "./freeGateway";

/**
 * VS Code side of Hermes Free: owns the one gateway instance, makes sure the
 * bundled `rc serve` is up and new enough, and surfaces telemetry.
 */

let gateway: FreeGateway | undefined;
let output: vscode.OutputChannel | undefined;

function channel(): vscode.OutputChannel {
  output ??= vscode.window.createOutputChannel("RC Hermes Free");
  return output;
}

function log(line: string): void {
  channel().appendLine(`[${new Date().toLocaleTimeString()}] ${line}`);
}

/** POST an empty raw turn: 400 means the endpoint exists, 404 means an old rc serve. */
function probeRaw(serveUrl: string): Promise<number> {
  return new Promise((resolve) => {
    const target = new URL("/rc/raw/turn", serveUrl);
    const body = "{}";
    const request = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": body.length }
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      }
    );
    request.setTimeout(3_000, () => request.destroy());
    request.on("error", () => resolve(0));
    request.end(body);
  });
}

async function ensureServe(): Promise<string> {
  let url = await ensureRcServe();
  if (!url) throw new Error("Could not start the bundled rc serve (is your DeepSeek web token set? Use /token).");
  if ((await probeRaw(url)) === 404) {
    if (!ownsRcServe()) {
      throw new Error(
        `Port ${getVelocitySettings().servePort} is served by an older rc serve without the raw endpoint. ` +
          "Stop it, or change rc.velocity.servePort."
      );
    }
    restartRcServe();
    url = await ensureRcServe();
    if (!url || (await probeRaw(url)) === 404) throw new Error("The bundled rc CLI is outdated; run npm run prepare-cli.");
  }
  return url;
}

export type FreeEndpoint = { baseUrl: string; apiKey: string };

export async function ensureHermesFree(): Promise<FreeEndpoint> {
  if (!resolveDeepSeekToken()) throw new Error("Hermes Free needs your free DeepSeek web token. Use /token to add it.");
  await ensureServe();
  if (!gateway) {
    gateway = new FreeGateway({
      upstream: rcServeUpstream(ensureServe, resolveDeepSeekToken),
      maxRepairs: Math.max(0, vscode.workspace.getConfiguration("rc").get<number>("hermesFree.maxRepairs", 2)),
      thinking: () => getHermesFreeModel() === "deepseek-reasoner",
      log
    });
  }
  await gateway.start();
  return { baseUrl: gateway.baseUrl, apiKey: gateway.apiKey };
}

export function subscribeHermesFree(listener: (event: GatewayEvent) => void): () => void {
  return gateway ? gateway.subscribe(listener) : () => undefined;
}

export function resetHermesFreeSessions(): void {
  gateway?.resetSessions();
}

export async function stopHermesFree(): Promise<void> {
  await gateway?.stop();
  gateway = undefined;
}

export function formatBytes(chars: number): string {
  return chars >= 1024 ? `${(chars / 1024).toFixed(1)} KB` : `${chars} B`;
}

export function savedPercent(sent: number, naive: number): number {
  return naive > 0 ? Math.max(0, Math.round((1 - sent / naive) * 100)) : 0;
}

/** One-line summary of a single model call, for the chat's tool-event lines. */
export function describeEvent(event: GatewayEvent): string {
  const parts = [
    event.kind === "delta" ? "⚡ delta sync" : "◆ new session",
    `sent ${formatBytes(event.sentChars)}`,
    `saved ${savedPercent(event.sentChars, event.naiveChars)}%`
  ];
  if (event.toolCalls.length) parts.push(`→ ${event.toolCalls.join(", ")}`);
  if (event.repairs) parts.push(`🔧 ${event.repairs} self-repair${event.repairs > 1 ? "s" : ""}`);
  if (event.recovered) parts.push("recovered call");
  if (event.guardTrimmed) parts.push("🛡 guard");
  if (event.failed) parts.push(`✗ ${event.failed.slice(0, 120)}`);
  parts.push(`${(event.latencyMs / 1000).toFixed(1)}s`);
  return `Hermes Free · ${parts.join(" · ")}`;
}

export function summarizeEvents(events: GatewayEvent[]): string {
  if (!events.length) return "";
  const sent = events.reduce((n, e) => n + e.sentChars, 0);
  const naive = events.reduce((n, e) => n + e.naiveChars, 0);
  const repairs = events.reduce((n, e) => n + e.repairs, 0);
  const deltas = events.filter((e) => e.kind === "delta").length;
  return (
    `Hermes Free · ${events.length} model call(s), ${deltas} via delta sync · sent ${formatBytes(sent)} instead of ${formatBytes(naive)} ` +
    `(${savedPercent(sent, naive)}% less)${repairs ? ` · ${repairs} tool call(s) self-repaired` : ""}`
  );
}

export async function showHermesFreeStats(): Promise<void> {
  const stats: GatewayStats | undefined = gateway?.getStats();
  if (!stats || !stats.requests) {
    void vscode.window.showInformationMessage("Hermes Free has not handled any requests in this window yet.");
    return;
  }
  const lines = [
    `Model calls: ${stats.requests} (${stats.deltaHits} delta-synced, ${stats.requests - stats.deltaHits} new sessions)`,
    `Sent: ${formatBytes(stats.sentChars)} vs naive replay ${formatBytes(stats.naiveChars)} — ${savedPercent(stats.sentChars, stats.naiveChars)}% less`,
    `Self-repaired tool calls: ${stats.repairs} · recovered: ${stats.recovered} · hallucination guard: ${stats.guardTrims}`,
    `Failures: ${stats.failures} · live conversations: ${gateway?.conversations ?? 0}`
  ];
  for (const line of lines) log(line);
  channel().show(true);
  void vscode.window.showInformationMessage(lines.slice(0, 2).join(" · "));
}
