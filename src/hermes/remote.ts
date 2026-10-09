import type { UiAgentMode } from "../rcProcess";
import { resultStatus, toolDetail, toolIcon, type ToolCard } from "./toolCards";

/**
 * Client for a Hermes Agent running elsewhere (a server, another machine, a
 * container) through its own API server (API_SERVER_ENABLED, default port 8642).
 *
 * It uses Hermes' session API rather than plain chat completions, because that
 * keeps the conversation on the server and streams what the agent is doing:
 *
 *   POST /api/sessions                         -> { session: { id } }
 *   POST /api/sessions/{id}/chat/stream        -> SSE: run.started, assistant.delta,
 *        tool.started / tool.completed / tool.failed, approval.request,
 *        assistant.completed, run.completed|failed|cancelled, error, done
 *   POST /v1/runs/{run_id}/approval            <- { choice: once|session|always|deny }
 *   POST /v1/runs/{run_id}/stop
 *
 * Tools execute on the Hermes host, against the files there. Nothing here
 * touches VS Code: UI hooks are passed in, so the client is testable.
 */

export type RemoteConfig = { baseUrl: string; apiKey: string };

export type ApprovalRequest = { command: string; description: string; choices: string[] };

export type RemoteTurnHooks = {
  onText: (textSoFar: string) => void;
  onStatus: (text: string) => void;
  onCard: (card: ToolCard) => void;
  /** Resolves to one of request.choices. */
  onApproval: (request: ApprovalRequest) => Promise<string>;
};

export type RemoteTurnResult =
  | { ok: true; text: string; sessionId: string }
  | { ok: false; cancelled: boolean; error: string; sessionGone?: boolean };

const READ_ONLY_NOTE =
  "(Chat mode: read-only. Do not modify files or run state-changing commands; explain or propose a patch instead.)";

/** Accepts "https://host:8642", ".../v1" or a trailing slash. */
export function normalizeRemoteUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

type SseEvent = { event: string; data: Record<string, unknown> };

/** Incremental SSE parser: feed text chunks, get complete events back. */
export class SseParser {
  private buffer = "";

  push(chunk: string): SseEvent[] {
    this.buffer += chunk.replace(/\r\n/g, "\n");
    const events: SseEvent[] = [];
    let cut: number;
    while ((cut = this.buffer.indexOf("\n\n")) >= 0) {
      const block = this.buffer.slice(0, cut);
      this.buffer = this.buffer.slice(cut + 2);
      let name = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) continue; // keepalive comment
        if (line.startsWith("event:")) name = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (!data.length) continue;
      try {
        const parsed = JSON.parse(data.join("\n"));
        events.push({ event: name, data: parsed && typeof parsed === "object" ? parsed : { value: parsed } });
      } catch {
        events.push({ event: name, data: { value: data.join("\n") } });
      }
    }
    return events;
  }
}

/**
 * Tool events from the API carry no call id, only the tool name. Cards are
 * matched first-in-first-out per tool name, which is exact for sequential calls
 * and close enough for parallel calls of the same tool.
 */
export class RemoteCardTracker {
  private readonly open = new Map<string, string[]>();
  private readonly cards = new Map<string, ToolCard>();
  private counter = 0;

  started(name: string, args: unknown, preview: unknown): ToolCard {
    const id = `remote-${++this.counter}`;
    const argObj = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
    const detail = toolDetail(name, argObj) || (typeof preview === "string" ? preview.replace(/\s+/g, " ").slice(0, 64) : "");
    const card: ToolCard = { id, icon: toolIcon(name), name, detail, state: "running", status: "…", repaired: false };
    this.cards.set(id, card);
    this.open.set(name, [...(this.open.get(name) ?? []), id]);
    return card;
  }

  finished(name: string, failed: boolean, preview: unknown): ToolCard | undefined {
    const queue = this.open.get(name) ?? [];
    const id = queue.shift();
    this.open.set(name, queue);
    const card = id ? this.cards.get(id) : undefined;
    if (!card) return undefined;
    const text = typeof preview === "string" ? preview : "";
    const judged = text ? resultStatus(name, text) : { state: "ok" as const, status: "✓" };
    const next: ToolCard = failed ? { ...card, state: "fail", status: judged.state === "fail" ? judged.status : "✗" } : { ...card, ...judged };
    this.cards.set(card.id, next);
    return next;
  }

  /** Cards still running when the turn ends (stopped, failed). */
  unfinished(): ToolCard[] {
    return [...this.cards.values()].filter((c) => c.state === "running");
  }
}

export class HermesRemoteClient {
  private activeRun: { runId: string; abort: AbortController } | undefined;

  constructor(private readonly config: RemoteConfig) {}

  private url(path: string): string {
    return `${normalizeRemoteUrl(this.config.baseUrl)}${path}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.config.apiKey}`, "Content-Type": "application/json", ...extra };
  }

  private async request(path: string, body?: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetch(this.url(path), {
        method: body === undefined ? "GET" : "POST",
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal
      });
    } catch (error) {
      throw new Error(`Cannot reach Hermes at ${normalizeRemoteUrl(this.config.baseUrl)}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // keep the raw text for the error below
    }
    if (!res.ok) {
      const message = (json.error as { message?: string } | undefined)?.message || text.slice(0, 200) || `HTTP ${res.status}`;
      throw new Error(res.status === 401 ? `Hermes rejected the API key (API_SERVER_KEY): ${message}` : `Hermes API ${res.status}: ${message}`);
    }
    return json;
  }

  /** Checks reachability + key; returns the server's model label. */
  async probe(): Promise<{ model: string; toolExecution: string }> {
    const caps = await this.request("/v1/capabilities");
    const runtime = (caps.runtime ?? {}) as { tool_execution?: string };
    return { model: String(caps.model ?? "hermes-agent"), toolExecution: String(runtime.tool_execution ?? "server") };
  }

  async createSession(title: string): Promise<string> {
    const json = await this.request("/api/sessions", { title, source: "api_server" });
    const session = (json.session ?? json) as { id?: unknown };
    if (typeof session.id !== "string" || !session.id) throw new Error("Hermes did not return a session id.");
    return session.id;
  }

  isRunning(): boolean {
    return this.activeRun !== undefined;
  }

  /** Stops the server-side run and drops the stream. */
  async stop(): Promise<boolean> {
    const run = this.activeRun;
    if (!run) return false;
    run.abort.abort();
    if (run.runId) {
      await this.request(`/v1/runs/${encodeURIComponent(run.runId)}/stop`, {}).catch(() => undefined);
    }
    return true;
  }

  async runTurn(sessionId: string, text: string, mode: UiAgentMode, hooks: RemoteTurnHooks): Promise<RemoteTurnResult> {
    if (this.activeRun) return { ok: false, cancelled: false, error: "Another Hermes turn is still running." };
    const abort = new AbortController();
    const run = { runId: "", abort };
    this.activeRun = run;
    const message = mode === "ask" ? `${READ_ONLY_NOTE}\n\n${text}` : text;
    const tracker = new RemoteCardTracker();
    let answer = "";
    let finalText: string | undefined;
    let failure: string | undefined;
    let status = "";
    try {
      const res = await fetch(this.url(`/api/sessions/${encodeURIComponent(sessionId)}/chat/stream`), {
        method: "POST",
        headers: this.headers({ Accept: "text/event-stream" }),
        body: JSON.stringify({ message }),
        signal: abort.signal
      });
      if (res.status === 404) return { ok: false, cancelled: false, error: "Hermes session not found.", sessionGone: true };
      if (!res.ok || !res.body) {
        const detail = (await res.text().catch(() => "")).slice(0, 200);
        return { ok: false, cancelled: false, error: res.status === 401 ? "Hermes rejected the API key (API_SERVER_KEY)." : `Hermes API ${res.status}: ${detail}` };
      }
      const parser = new SseParser();
      const decoder = new TextDecoder();
      const reader = res.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const { event, data } of parser.push(decoder.decode(value, { stream: true }))) {
          if (typeof data.run_id === "string" && data.run_id) run.runId = data.run_id;
          switch (event) {
            case "assistant.delta":
              if (typeof data.delta === "string") {
                answer += data.delta;
                hooks.onText(answer);
              }
              break;
            case "assistant.commentary":
              if (typeof data.text === "string" && !data.already_streamed) {
                answer += (answer ? "\n\n" : "") + data.text;
                hooks.onText(answer);
              }
              break;
            case "tool.started":
              hooks.onCard(tracker.started(String(data.tool_name ?? "tool"), data.args, data.preview));
              break;
            case "tool.completed":
            case "tool.failed": {
              const card = tracker.finished(String(data.tool_name ?? "tool"), event === "tool.failed", data.preview);
              if (card) hooks.onCard(card);
              break;
            }
            case "tool.progress":
              if (data.tool_name === "_thinking") hooks.onStatus("Hermes is thinking…");
              break;
            case "approval.request": {
              const choices = Array.isArray(data.choices) ? data.choices.map(String) : ["once", "deny"];
              const choice = await hooks.onApproval({
                command: String(data.command ?? data.description ?? "a guarded action"),
                description: String(data.description ?? data.reason ?? ""),
                choices
              });
              await this.request(`/v1/runs/${encodeURIComponent(run.runId)}/approval`, {
                choice: choices.includes(choice) ? choice : "deny",
                ...(typeof data.request_id === "string" ? { request_id: data.request_id } : {})
              }).catch((error) => hooks.onStatus(`Approval not delivered: ${error instanceof Error ? error.message : String(error)}`));
              break;
            }
            case "assistant.completed":
              if (typeof data.content === "string") finalText = data.content;
              break;
            case "run.failed":
              failure = String(data.error ?? data.message ?? "The Hermes run failed.");
              break;
            case "run.cancelled":
              status = "cancelled";
              break;
            case "error":
              failure = String(data.message ?? "Hermes reported an error.");
              break;
          }
        }
      }
    } catch (error) {
      if (abort.signal.aborted) status = "cancelled";
      else failure = error instanceof Error ? error.message : String(error);
    } finally {
      if (this.activeRun === run) this.activeRun = undefined;
    }
    for (const card of tracker.unfinished()) hooks.onCard({ ...card, state: "fail", status: status === "cancelled" ? "stopped" : "✗" });
    if (status === "cancelled") return { ok: false, cancelled: true, error: "Cancelled." };
    if (failure) return { ok: false, cancelled: false, error: failure };
    return { ok: true, text: (finalText ?? answer).trim() || "(no response)", sessionId };
  }
}
