import { randomBytes } from "crypto";
import * as http from "http";
import type { AddressInfo } from "net";
import {
  ConversationStore,
  buildRepairPrompt,
  messageText,
  naiveReplaySize,
  parseReply,
  validateCalls,
  type OaiMessage,
  type OaiTool,
  type OaiToolCall,
  type SyncPlan,
  type ToolChoice
} from "./freeProtocol";

/**
 * Hermes Free gateway: an OpenAI-compatible endpoint on 127.0.0.1 that lets
 * Hermes Agent run on the free DeepSeek web chat (through `rc serve`'s raw
 * turn endpoint) instead of the paid API. See freeProtocol.ts for the
 * protocol; this file is transport, the repair loop and telemetry.
 *
 * It is not tied to VS Code: the upstream and logger are injected.
 */

export type RawTurnResult = { sessionId: string; content: string; reasoning: string };

export type Upstream = {
  /** Sends one prompt into a web session (new one when sessionId is empty). */
  rawTurn(prompt: string, sessionId: string, thinking: boolean, signal: AbortSignal): Promise<RawTurnResult>;
};

export type GatewayEvent = {
  /** bootstrap/delta: free web chat (Delta Sync); direct: forwarded to a custom endpoint. */
  kind: "bootstrap" | "delta" | "direct";
  sentChars: number;
  naiveChars: number;
  repairs: number;
  recovered: boolean;
  guardTrimmed: boolean;
  renamed: number;
  toolCalls: string[];
  latencyMs: number;
  failed?: string;
};

/**
 * Per-tool lifecycle, for UIs that show one card per call: "call" when the
 * model asks for a tool (ids are the ones the client will echo back), "result"
 * when the client sends that tool's output in its next request.
 */
export type ToolEvent =
  | { type: "call"; id: string; name: string; args: Record<string, unknown>; repaired: boolean }
  | { type: "result"; id: string; name: string; content: string };

export type GatewayStats = {
  requests: number;
  deltaHits: number;
  sentChars: number;
  naiveChars: number;
  repairs: number;
  recovered: number;
  guardTrims: number;
  failures: number;
};

/** A custom OpenAI-compatible endpoint (Ollama, vLLM, LM Studio, a hosted API, ...). */
export type DirectTarget = { baseUrl: string; apiKey: string; model: string };

export type GatewayOptions = {
  upstream: Upstream;
  /**
   * When this returns a target, requests are forwarded there with native tool
   * calling instead of going to the free web chat. Read per request, so a
   * settings change applies to the next model call.
   */
  direct?: () => DirectTarget | undefined;
  maxRepairs?: number;
  /** Forces DeepThink on/off; clients may rename models, so the name is only a fallback. */
  thinking?: () => boolean | undefined;
  log?: (line: string) => void;
  onEvent?: (event: GatewayEvent) => void;
};

const MODELS = ["deepseek-chat", "deepseek-reasoner"];

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code = "invalid_request_error") {
    super(message);
  }
}

function emptyStats(): GatewayStats {
  return { requests: 0, deltaHits: 0, sentChars: 0, naiveChars: 0, repairs: 0, recovered: 0, guardTrims: 0, failures: 0 };
}

function newId(prefix: string): string {
  return `${prefix}${randomBytes(12).toString("hex")}`;
}

function estimateTokens(chars: number): number {
  return Math.max(1, Math.ceil(chars / 4));
}

export class FreeGateway {
  readonly apiKey = `rcf-${randomBytes(24).toString("hex")}`;
  private server: http.Server | undefined;
  private readonly extraServers = new Map<string, http.Server>();
  private port = 0;
  private readonly store = new ConversationStore();
  private stats = emptyStats();
  private readonly maxRepairs: number;
  private readonly listeners = new Set<(event: GatewayEvent) => void>();
  private readonly toolListeners = new Set<(event: ToolEvent) => void>();
  /** Tool-call ids we issued, so results are only reported for our own calls. */
  private readonly issuedCalls = new Map<string, string>();

  constructor(private readonly options: GatewayOptions) {
    this.maxRepairs = options.maxRepairs ?? 2;
    if (options.onEvent) this.listeners.add(options.onEvent);
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  get running(): boolean {
    return this.server !== undefined;
  }

  get conversations(): number {
    return this.store.size;
  }

  getStats(): GatewayStats {
    return { ...this.stats };
  }

  resetSessions(): void {
    this.store.clear();
  }

  /** Subscribe to per-request events; returns an unsubscribe function. */
  subscribe(listener: (event: GatewayEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Subscribe to per-tool call/result events; returns an unsubscribe function. */
  subscribeTools(listener: (event: ToolEvent) => void): () => void {
    this.toolListeners.add(listener);
    return () => this.toolListeners.delete(listener);
  }

  private emitTool(event: ToolEvent): void {
    for (const listener of this.toolListeners) {
      try {
        listener(event);
      } catch {
        // listeners must not break the gateway
      }
    }
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => void this.handle(req, res));
    // Agent turns on the web chat can take minutes; never let Node cut them.
    server.requestTimeout = 0;
    server.headersTimeout = 60_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    this.port = (server.address() as AddressInfo).port;
    this.server = server;
    this.log(`listening on ${this.baseUrl}`);
  }

  /**
   * Also listens on another local address (the Docker bridge gateway on Linux,
   * where containers cannot reach the host's 127.0.0.1) and returns its URL.
   * Same handler and per-launch key; one extra listener per address.
   */
  async exposeOn(host: string): Promise<string> {
    const existing = this.extraServers.get(host);
    if (existing) return `http://${host}:${(existing.address() as AddressInfo).port}/v1`;
    const server = http.createServer((req, res) => void this.handle(req, res));
    server.requestTimeout = 0;
    server.headersTimeout = 60_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    this.extraServers.set(host, server);
    const url = `http://${host}:${(server.address() as AddressInfo).port}/v1`;
    this.log(`also listening on ${url}`);
    return url;
  }

  async stop(): Promise<void> {
    const servers = [this.server, ...this.extraServers.values()].filter((s): s is http.Server => Boolean(s));
    this.server = undefined;
    this.extraServers.clear();
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }

  private log(line: string): void {
    this.options.log?.(line);
  }

  private emit(event: GatewayEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // listeners must not break the gateway
      }
    }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = (req.url || "/").split("?")[0].replace(/\/+$/, "") || "/";
    try {
      if (req.method === "GET" && (url === "/health" || url === "/v1/health")) {
        return sendJson(res, 200, { status: "ok" });
      }
      // Bound to loopback, but other local processes could still reach it.
      const auth = req.headers.authorization || "";
      if (auth !== `Bearer ${this.apiKey}`) throw new HttpError(401, "Invalid API key for the Hermes Free gateway.", "invalid_api_key");

      if (req.method === "GET" && (url === "/v1/models" || url === "/models")) {
        return sendJson(res, 200, {
          object: "list",
          data: MODELS.map((id) => ({ id, object: "model", created: 0, owned_by: "rc-free" }))
        });
      }
      if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) {
        return await this.completions(req, res);
      }
      throw new HttpError(404, `Unknown route ${req.method} ${url}`);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const code = error instanceof HttpError ? error.code : "server_error";
      const message = error instanceof Error ? error.message : String(error);
      if (status >= 500) this.log(`error: ${message}`);
      if (!res.headersSent) {
        sendJson(res, status, { error: { message, type: status >= 500 ? "server_error" : "invalid_request_error", code } });
      } else if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: { message, type: "server_error", code } })}\n\n`);
        res.end("data: [DONE]\n\n");
      }
    }
  }

  private async completions(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = (await readJson(req)) as Record<string, unknown>;
    const messages = body.messages;
    if (!Array.isArray(messages) || !messages.length) throw new HttpError(400, "'messages' must be a non-empty array.");
    const tools = (Array.isArray(body.tools) ? body.tools : []).filter(
      (t): t is OaiTool => Boolean(t && typeof t === "object" && (t as OaiTool).function?.name)
    );
    const choice = body.tool_choice as ToolChoice;
    const model = typeof body.model === "string" && body.model ? body.model : MODELS[0];
    const thinking =
      this.options.thinking?.() ??
      (/reasoner|r1\b/i.test(model) || (typeof body.reasoning_effort === "string" && body.reasoning_effort !== "none"));
    const stream = body.stream === true;
    const includeUsage = Boolean((body.stream_options as { include_usage?: boolean } | undefined)?.include_usage);

    // Cancel the upstream generation as soon as Hermes hangs up (Ctrl+C, stop).
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });

    // Results of our earlier calls arrive as the trailing tool messages.
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i] as OaiMessage;
      if (m?.role !== "tool") break;
      const id = typeof m.tool_call_id === "string" ? m.tool_call_id : "";
      const name = this.issuedCalls.get(id);
      if (!name) continue;
      this.issuedCalls.delete(id);
      this.emitTool({ type: "result", id, name, content: messageText(m.content) });
    }

    const started = Date.now();
    const target = this.options.direct?.();
    if (target) {
      const event = this.newEvent("direct", JSON.stringify(body).length);
      try {
        const outcome = await forwardDirect(target, body, abort.signal);
        event.sentChars = event.naiveChars;
        this.finishEvent(event, outcome, started);
        return this.respond(res, { stream, includeUsage, model, outcome, promptChars: event.sentChars });
      } catch (error) {
        if (abort.signal.aborted) return;
        event.latencyMs = Date.now() - started;
        event.failed = error instanceof Error ? error.message : String(error);
        this.record(event);
        throw error;
      }
    }

    const plan = this.store.plan(messages as OaiMessage[], tools, choice);
    const event: GatewayEvent = {
      kind: plan.kind,
      sentChars: 0,
      naiveChars: naiveReplaySize(messages as OaiMessage[], tools),
      repairs: 0,
      recovered: false,
      guardTrimmed: false,
      renamed: 0,
      toolCalls: [],
      latencyMs: 0
    };

    try {
      const outcome = await this.runWithRepairs(plan, tools, choice, thinking, abort.signal, event);
      const reply: OaiMessage = {
        role: "assistant",
        content: outcome.content,
        ...(outcome.toolCalls.length ? { tool_calls: outcome.toolCalls } : {})
      };
      this.store.commit(plan, outcome.sessionId, tools, reply);
      this.finishEvent(event, outcome, started);
      this.respond(res, { stream, includeUsage, model, outcome, promptChars: event.sentChars });
    } catch (error) {
      if (abort.signal.aborted) return;
      event.latencyMs = Date.now() - started;
      event.failed = error instanceof Error ? error.message : String(error);
      this.record(event);
      // A failed delta leaves the web session in an unknown state: drop it so
      // the next request bootstraps cleanly instead of compounding the error.
      if (plan.kind === "delta") this.store.forget(plan.conversation);
      throw error;
    }
  }

  private newEvent(kind: GatewayEvent["kind"], naiveChars: number): GatewayEvent {
    return { kind, sentChars: 0, naiveChars, repairs: 0, recovered: false, guardTrimmed: false, renamed: 0, toolCalls: [], latencyMs: 0 };
  }

  /** Tool-call bookkeeping, telemetry and logging shared by both upstream paths. */
  private finishEvent(event: GatewayEvent, outcome: CompletionOutcome, started: number): void {
    for (const call of outcome.toolCalls) {
      if (this.issuedCalls.size > 500) this.issuedCalls.clear(); // results that never came back
      this.issuedCalls.set(call.id, call.function.name);
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments) as Record<string, unknown>;
      } catch {
        // direct endpoints may send malformed JSON; the card just shows no detail
      }
      this.emitTool({ type: "call", id: call.id, name: call.function.name, args, repaired: event.repairs > 0 });
    }
    event.latencyMs = Date.now() - started;
    event.toolCalls = outcome.toolCalls.map((c) => c.function.name);
    this.record(event);
    this.log(
      `${event.kind} · sent ${event.sentChars} chars (naive ${event.naiveChars}) · ${event.toolCalls.length} call(s)` +
        `${event.repairs ? ` · ${event.repairs} repair(s)` : ""}${event.guardTrimmed ? " · guard" : ""} · ${event.latencyMs} ms`
    );
  }

  /** Answers the client as a chat completion, streamed (SSE) or not. */
  private respond(
    res: http.ServerResponse,
    o: { stream: boolean; includeUsage: boolean; model: string; outcome: CompletionOutcome; promptChars: number }
  ): void {
    const { outcome, model } = o;
    const usage = {
      prompt_tokens: estimateTokens(o.promptChars),
      completion_tokens: estimateTokens(outcome.content.length + JSON.stringify(outcome.toolCalls).length),
      total_tokens: 0
    };
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    const finish = outcome.toolCalls.length ? "tool_calls" : "stop";
    const id = newId("chatcmpl-");
    const created = Math.floor(Date.now() / 1000);

    if (!o.stream) {
      return sendJson(res, 200, {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: outcome.toolCalls.length && !outcome.content ? null : outcome.content,
              ...(outcome.toolCalls.length ? { tool_calls: outcome.toolCalls } : {}),
              ...(outcome.reasoning ? { reasoning_content: outcome.reasoning } : {})
            },
            finish_reason: finish
          }
        ],
        usage
      });
    }

    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`
      );
    chunk({ role: "assistant", content: "" });
    if (outcome.reasoning) chunk({ reasoning_content: outcome.reasoning });
    if (outcome.content) chunk({ content: outcome.content });
    if (outcome.toolCalls.length) chunk({ tool_calls: outcome.toolCalls.map((call, index) => ({ index, ...call })) });
    chunk({}, finish);
    if (o.includeUsage) {
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage })}\n\n`);
    }
    res.end("data: [DONE]\n\n");
  }

  private async runWithRepairs(
    plan: SyncPlan,
    tools: OaiTool[],
    choice: ToolChoice,
    thinking: boolean,
    signal: AbortSignal,
    event: GatewayEvent
  ): Promise<CompletionOutcome & { sessionId: string }> {
    let sessionId = plan.kind === "delta" ? plan.conversation.sessionId : "";
    let prompt = plan.prompt;
    let lastErrors: string[] = [];

    for (let attempt = 0; attempt <= this.maxRepairs; attempt++) {
      event.sentChars += prompt.length;
      const turn = await this.options.upstream.rawTurn(prompt, sessionId, thinking, signal);
      sessionId = turn.sessionId || sessionId;
      if (!sessionId) throw new HttpError(502, "The DeepSeek web session could not be created.", "upstream_error");

      const parsed = parseReply(turn.content, tools);
      if (parsed.guardTrimmed) event.guardTrimmed = true;
      if (parsed.recovered) event.recovered = true;
      const validated = tools.length || parsed.calls.length ? validateCalls(parsed, tools, choice) : { calls: [], errors: [], renamed: 0 };
      event.renamed += validated.renamed;

      if (!validated.errors.length) {
        if (!parsed.content && !validated.calls.length) {
          lastErrors = ["The reply was empty."];
        } else {
          return {
            sessionId,
            content: parsed.content,
            reasoning: turn.reasoning,
            toolCalls: validated.calls.map((call) => ({
              id: newId("call_"),
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.args) }
            }))
          };
        }
      } else {
        lastErrors = validated.errors;
      }
      if (attempt < this.maxRepairs) {
        event.repairs++;
        this.log(`repair ${attempt + 1}: ${lastErrors.join(" | ")}`);
        prompt = buildRepairPrompt(lastErrors);
      }
    }
    throw new HttpError(502, `The model's tool call stayed invalid after ${this.maxRepairs} repair attempt(s): ${lastErrors.join(" ")}`, "invalid_tool_call");
  }

  private record(event: GatewayEvent): void {
    const s = this.stats;
    s.requests++;
    if (event.kind === "delta") s.deltaHits++;
    s.sentChars += event.sentChars;
    s.naiveChars += event.naiveChars;
    s.repairs += event.repairs;
    if (event.recovered) s.recovered++;
    if (event.guardTrimmed) s.guardTrims++;
    if (event.failed) s.failures++;
    this.emit(event);
  }
}

type CompletionOutcome = { content: string; reasoning: string; toolCalls: OaiToolCall[] };

/**
 * Forwards a chat completion to a custom endpoint with its own model name and
 * native tool calling (non-streamed upstream; the client still gets SSE if it
 * asked). Tool-call ids missing from weaker servers are filled in.
 */
export async function forwardDirect(target: DirectTarget, body: Record<string, unknown>, signal: AbortSignal): Promise<CompletionOutcome> {
  const payload: Record<string, unknown> = { ...body, model: target.model, stream: false };
  delete payload.stream_options;
  const url = `${target.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}) },
      body: JSON.stringify(payload),
      signal
    });
  } catch (error) {
    if (signal.aborted) throw error;
    // fetch() only says "fetch failed"; the useful part is the socket error underneath.
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    const why =
      cause?.code === "ECONNREFUSED"
        ? "connection refused — is the server running?"
        : cause?.code === "ENOTFOUND"
          ? "host not found"
          : cause?.code || cause?.message || (error instanceof Error ? error.message : String(error));
    throw new HttpError(502, `Custom endpoint unreachable (${url}): ${why}`, "upstream_error");
  }
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // reported below
  }
  if (!res.ok) {
    const message = (json.error as { message?: string } | undefined)?.message || text.slice(0, 300) || `HTTP ${res.status}`;
    const auth = res.status === 401 || res.status === 403;
    throw new HttpError(auth ? 401 : 502, `Custom endpoint: ${message}`, auth ? "invalid_api_key" : "upstream_error");
  }
  const choice = (json.choices as Array<{ message?: Record<string, unknown> }> | undefined)?.[0];
  if (!choice) throw new HttpError(502, `Custom endpoint returned no choices: ${text.slice(0, 200)}`, "upstream_error");
  const message = choice.message ?? {};
  const rawCalls = Array.isArray(message.tool_calls) ? (message.tool_calls as Array<Record<string, unknown>>) : [];
  const toolCalls: OaiToolCall[] = rawCalls
    .map((call) => {
      const fn = (call.function ?? {}) as { name?: unknown; arguments?: unknown };
      const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
      return {
        id: typeof call.id === "string" && call.id ? call.id : newId("call_"),
        type: "function" as const,
        function: { name: String(fn.name ?? ""), arguments: args }
      };
    })
    .filter((call) => call.function.name);
  return {
    content: typeof message.content === "string" ? message.content : messageText(message.content),
    reasoning: typeof message.reasoning_content === "string" ? message.reasoning_content : "",
    toolCalls
  };
}

function readJson(req: http.IncomingMessage, limit = 16 * 1024 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, "Request body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new HttpError(400, "Request body is not valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

/** Upstream that talks to `rc serve`'s POST /rc/raw/turn. */
export function rcServeUpstream(serveUrl: () => Promise<string>, token: () => string, timeoutMs = 600_000): Upstream {
  return {
    async rawTurn(prompt, sessionId, thinking, signal) {
      const base = await serveUrl();
      const payload = JSON.stringify({ prompt, session_id: sessionId || undefined, thinking });
      return new Promise<RawTurnResult>((resolve, reject) => {
        const target = new URL("/rc/raw/turn", base);
        const request = http.request(
          {
            hostname: target.hostname,
            port: target.port,
            path: target.pathname,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
              Authorization: `Bearer ${token()}`
            }
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (c: Buffer) => chunks.push(c));
            response.on("end", () => {
              const text = Buffer.concat(chunks).toString("utf8");
              let json: Record<string, unknown> = {};
              try {
                json = JSON.parse(text) as Record<string, unknown>;
              } catch {
                // fall through
              }
              if ((response.statusCode ?? 500) >= 400) {
                const err = (json.error as { message?: string } | undefined)?.message || text.slice(0, 300) || `HTTP ${response.statusCode}`;
                const status = response.statusCode === 401 ? 401 : 502;
                reject(new HttpError(status, `rc serve: ${err}`, status === 401 ? "invalid_api_key" : "upstream_error"));
                return;
              }
              resolve({
                sessionId: typeof json.session_id === "string" ? json.session_id : "",
                content: typeof json.content === "string" ? json.content : "",
                reasoning: typeof json.reasoning === "string" ? json.reasoning : ""
              });
            });
          }
        );
        request.setTimeout(timeoutMs, () => request.destroy(new HttpError(504, "The DeepSeek web chat did not answer in time.", "timeout")));
        request.on("error", (error) => reject(error instanceof HttpError ? error : new HttpError(502, `rc serve unreachable: ${error.message}`, "upstream_error")));
        const onAbort = () => request.destroy(new Error("aborted"));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
        request.end(payload);
      });
    }
  };
}
