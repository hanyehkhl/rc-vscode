/**
 * Minimal OpenAI-compatible Chat Completions client for the Ashna API.
 *
 * No SDK dependency: the extension host (Node 18+) has fetch and web streams,
 * and we only need one streaming endpoint plus GET /models.
 */

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
};

export type Usage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };

export type ChatResult = {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage?: Usage;
};

export type AshnaErrorKind =
  | "auth"
  | "forbidden"
  | "not_found"
  | "rate_limit"
  | "bad_request"
  | "server"
  | "network"
  | "timeout"
  | "aborted";

export class AshnaApiError extends Error {
  constructor(
    message: string,
    readonly kind: AshnaErrorKind,
    readonly status?: number
  ) {
    super(message);
    this.name = "AshnaApiError";
  }
}

/** Identify this client honestly to the API (name/version + project URL). */
function userAgent(): string {
  let version = "0.0.0";
  try {
    // out/ashna/client.js → ../../package.json
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    version = String((require("../../package.json") as { version?: unknown }).version ?? version);
  } catch {
    // keep the fallback version
  }
  return `rc-vscode/${version} (+https://github.com/hanyehkhl/rc-vscode)`;
}

const USER_AGENT = userAgent();

type ClientOptions = {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
};

function kindForStatus(status: number): AshnaErrorKind {
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  return "bad_request";
}

function friendlyStatusMessage(status: number, serverMessage: string): string {
  const detail = serverMessage ? ` (${serverMessage})` : "";
  switch (status) {
    case 401:
      return `Ashna rejected the API key${detail}. Set a new key with /ashna.`;
    case 403:
      return `This API key is not allowed to use that model or agent${detail}. Check your Ashna plan, or pick another model.`;
    case 404:
      return `Unknown model or agent id${detail}. Check rc.ashna.model / rc.ashna.agentId.`;
    case 429:
      return `Ashna rate limit reached${detail}. Wait a moment and try again.`;
    default:
      return `Ashna API error ${status}${detail}.`;
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  const raw = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: unknown } | string; message?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
    if (parsed.error && typeof parsed.error.message === "string") return parsed.error.message;
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // not JSON
  }
  return raw.slice(0, 300).trim();
}

/** Combine the caller's abort signal with a wall-clock timeout. */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  timedOut: () => boolean;
  dispose: () => void;
} {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => expired,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  };
}

type StreamChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: Usage;
  error?: { message?: string };
};

/** Accumulates streamed tool-call fragments keyed by their index. */
class ToolCallAccumulator {
  private readonly calls = new Map<number, ToolCall>();

  add(fragments: NonNullable<NonNullable<StreamChunk["choices"]>[number]["delta"]>["tool_calls"]): void {
    for (const fragment of fragments ?? []) {
      const index = fragment.index ?? this.calls.size;
      let call = this.calls.get(index);
      if (!call) {
        call = { id: "", type: "function", function: { name: "", arguments: "" } };
        this.calls.set(index, call);
      }
      if (fragment.id) call.id = fragment.id;
      if (fragment.function?.name) call.function.name += fragment.function.name;
      if (fragment.function?.arguments) call.function.arguments += fragment.function.arguments;
    }
  }

  result(): ToolCall[] {
    return [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, call]) => ({ ...call, id: call.id || `call_${index}_${Date.now().toString(36)}` }))
      .filter((call) => call.function.name);
  }
}

export class AshnaClient {
  constructor(private readonly options: ClientOptions) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.options.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "User-Agent": USER_AGENT
    };
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const guard = withTimeout(signal, this.options.timeoutMs);
    try {
      const response = await fetch(`${this.options.baseUrl}${path}`, {
        ...init,
        headers: this.headers(),
        signal: guard.signal
      });
      if (!response.ok) {
        const message = await readErrorMessage(response);
        throw new AshnaApiError(
          friendlyStatusMessage(response.status, message),
          kindForStatus(response.status),
          response.status
        );
      }
      return response;
    } catch (error) {
      throw this.normalizeError(error, signal, guard.timedOut());
    } finally {
      guard.dispose();
    }
  }

  private normalizeError(error: unknown, signal: AbortSignal | undefined, timedOut: boolean): AshnaApiError {
    if (error instanceof AshnaApiError) return error;
    if (signal?.aborted) return new AshnaApiError("Cancelled.", "aborted");
    if (timedOut) {
      return new AshnaApiError(
        `Ashna did not respond within ${Math.round(this.options.timeoutMs / 1000)}s.`,
        "timeout"
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return new AshnaApiError(`Could not reach Ashna: ${message}`, "network");
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const response = await this.request("/models", { method: "GET" }, signal);
    const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
    return (body.data ?? [])
      .map((entry) => (typeof entry.id === "string" ? entry.id : ""))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  }

  /**
   * One streamed Chat Completions call. `onText` receives content deltas as they
   * arrive; tool calls are assembled and returned once the stream ends.
   */
  async streamChat(
    body: ChatRequest,
    onText: (delta: string) => void,
    signal?: AbortSignal
  ): Promise<ChatResult> {
    const payload: Record<string, unknown> = {
      model: body.model,
      messages: body.messages,
      stream: true
    };
    if (body.tools?.length) {
      payload.tools = body.tools;
      payload.tool_choice = "auto";
    }

    // The timeout covers the whole stream, not only the headers.
    const guard = withTimeout(signal, this.options.timeoutMs);
    try {
      const response = await fetch(`${this.options.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(payload),
        signal: guard.signal
      });
      if (!response.ok) {
        const message = await readErrorMessage(response);
        throw new AshnaApiError(
          friendlyStatusMessage(response.status, message),
          kindForStatus(response.status),
          response.status
        );
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/event-stream")) {
        // Server ignored stream:true — handle a plain chat.completion body.
        return this.parseNonStreaming(await response.json(), onText);
      }
      return await this.consumeStream(response, onText);
    } catch (error) {
      throw this.normalizeError(error, signal, guard.timedOut());
    } finally {
      guard.dispose();
    }
  }

  private parseNonStreaming(json: unknown, onText: (delta: string) => void): ChatResult {
    const body = json as {
      choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] }; finish_reason?: string }>;
      usage?: Usage;
    };
    const choice = body.choices?.[0];
    const content = choice?.message?.content ?? "";
    if (content) onText(content);
    return {
      content,
      toolCalls: choice?.message?.tool_calls ?? [],
      finishReason: choice?.finish_reason ?? "stop",
      usage: body.usage
    };
  }

  private async consumeStream(response: Response, onText: (delta: string) => void): Promise<ChatResult> {
    if (!response.body) {
      throw new AshnaApiError("Ashna returned an empty stream.", "server");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const toolCalls = new ToolCallAccumulator();
    let buffer = "";
    let content = "";
    let finishReason = "";
    let usage: Usage | undefined;
    let done = false;

    const handleEvent = (data: string) => {
      if (data === "[DONE]") {
        done = true;
        return;
      }
      let chunk: StreamChunk;
      try {
        chunk = JSON.parse(data) as StreamChunk;
      } catch {
        return; // keep-alive or non-JSON noise
      }
      if (chunk.error?.message) {
        throw new AshnaApiError(`Ashna stream error: ${chunk.error.message}`, "server");
      }
      if (chunk.usage) usage = chunk.usage;
      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta;
        if (delta?.content) {
          content += delta.content;
          onText(delta.content);
        }
        if (delta?.tool_calls) toolCalls.add(delta.tool_calls);
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    };

    while (!done) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by a blank line; each has one or more data: lines.
      let boundary: number;
      while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, "");
        const data = rawEvent
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) handleEvent(data);
        if (done) break;
      }
    }
    if (!done && buffer.trim().startsWith("data:")) {
      handleEvent(buffer.trim().slice(5).trimStart());
    }
    await reader.cancel().catch(() => undefined);

    const calls = toolCalls.result();
    return {
      content,
      toolCalls: calls,
      finishReason: finishReason || (calls.length ? "tool_calls" : "stop"),
      usage
    };
  }
}
