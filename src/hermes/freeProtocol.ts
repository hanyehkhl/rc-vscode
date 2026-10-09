import { createHash } from "crypto";

/**
 * Protocol layer of the Hermes Free gateway.
 *
 * Hermes speaks the stateless OpenAI Chat Completions API: every request
 * carries the whole transcript plus every tool schema. The free DeepSeek web
 * chat behind `rc serve` is the opposite: a stateful session that only takes
 * one new message at a time and has no native function calling. This module
 * bridges the two:
 *
 * - Delta Sync: each conversation is fingerprinted as a hash chain over its
 *   canonical messages, so a request that extends a known chain only sends
 *   the new messages into the web session it already lives in.
 * - Compact tool manifest: schemas become one-line signatures, sent once per
 *   session; later turns only carry a diff when the tool set changes.
 * - Schema-aware tool calls: calls are parsed from a text protocol, arguments
 *   coerced by their declared types, and validated before Hermes sees them.
 *   Broken calls produce a precise repair prompt instead of an error.
 * - Hallucination guard: anything the model writes after its calls (typically
 *   an invented tool result) is cut, so Hermes always runs the real tool.
 *
 * Nothing here touches the network or VS Code, so it is unit-testable.
 */

// ---------------------------------------------------------------------------
// OpenAI wire types (the subset Hermes uses)

export type JsonSchema = {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
  default?: unknown;
};

export type OaiTool = {
  type: "function";
  function: { name: string; description?: string; parameters?: JsonSchema };
};

export type OaiToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type OaiMessage = {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: unknown;
  name?: string;
  tool_calls?: OaiToolCall[];
  tool_call_id?: string;
};

export type ToolChoice = "auto" | "none" | "required" | { type: "function"; function: { name: string } } | undefined;

// ---------------------------------------------------------------------------
// Text helpers

export function messageText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content);
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") {
        const p = part as { type?: string; text?: unknown };
        if (typeof p.text === "string") return p.text;
        if (p.type === "image_url") return "[image omitted: this model only receives text]";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

/** Stable JSON: sorted keys, so re-serialised arguments hash identically. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function canonicalArgs(raw: string): string {
  try {
    return stableStringify(JSON.parse(raw));
  } catch {
    return raw.trim();
  }
}

function isSystemRole(role: string): boolean {
  return role === "system" || role === "developer";
}

/**
 * Canonical form used for fingerprints. Tool-call ids are ignored on purpose:
 * clients are free to rewrite them, and what matters is what was said.
 */
export function canonicalMessage(message: OaiMessage): string {
  const text = messageText(message.content).trim();
  if (message.role === "assistant") {
    const calls = (message.tool_calls ?? [])
      .map((call) => `${call.function?.name}(${canonicalArgs(call.function?.arguments ?? "")})`)
      .join(";");
    return `assistant\u0000${text}\u0000${calls}`;
  }
  if (message.role === "tool") {
    return `tool\u0000${message.name ?? ""}\u0000${text}`;
  }
  return `${message.role}\u0000${text}`;
}

/** Cumulative hash chain: chain[i] fingerprints messages[0..i]. */
export function hashChain(messages: OaiMessage[]): string[] {
  const chain: string[] = [];
  let previous = "";
  for (const message of messages) {
    previous = sha1(`${previous}\u0001${canonicalMessage(message)}`);
    chain.push(previous);
  }
  return chain;
}

export function splitSystem(messages: OaiMessage[]): { system: string; dialog: OaiMessage[] } {
  const system = messages
    .filter((m) => isSystemRole(m.role))
    .map((m) => messageText(m.content).trim())
    .filter(Boolean)
    .join("\n\n");
  return { system, dialog: messages.filter((m) => !isSystemRole(m.role)) };
}

// ---------------------------------------------------------------------------
// Compact tool manifest

const MAX_TOOL_DESCRIPTION = 1_200;
const MAX_PARAM_DESCRIPTION = 300;

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

export function schemaType(schema: JsonSchema | undefined, depth = 0): string {
  if (!schema || typeof schema !== "object") return "any";
  if (Array.isArray(schema.enum) && schema.enum.length) {
    return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  }
  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union) && union.length) {
    return union.map((s) => schemaType(s, depth)).join(" | ");
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length > 1) return types.map((t) => schemaType({ ...schema, type: t }, depth)).join(" | ");
  const type = types[0];
  if (type === "array") return `${wrapUnion(schemaType(schema.items, depth + 1))}[]`;
  if (type === "object" || (!type && schema.properties)) {
    if (!schema.properties || depth >= 2) return "object";
    const required = new Set(schema.required ?? []);
    const fields = Object.entries(schema.properties).map(
      ([key, sub]) => `${key}${required.has(key) ? "" : "?"}: ${schemaType(sub, depth + 1)}`
    );
    return `{${fields.join(", ")}}`;
  }
  if (type === "integer") return "int";
  return type || "any";
}

function wrapUnion(type: string): string {
  return type.includes(" | ") ? `(${type})` : type;
}

export function toolSignature(tool: OaiTool): string {
  const fn = tool.function;
  const params = fn.parameters?.properties ?? {};
  const required = new Set(fn.parameters?.required ?? []);
  const args = Object.entries(params).map(
    ([key, schema]) => `${key}${required.has(key) ? "" : "?"}: ${schemaType(schema, 1)}`
  );
  const lines = [`${fn.name}(${args.join(", ")})`];
  if (fn.description) lines.push(`  ${clip(fn.description, MAX_TOOL_DESCRIPTION)}`);
  for (const [key, schema] of Object.entries(params)) {
    if (schema?.description) lines.push(`  - ${key}: ${clip(schema.description, MAX_PARAM_DESCRIPTION)}`);
  }
  return lines.join("\n");
}

export function compactManifest(tools: OaiTool[]): string {
  return tools.map(toolSignature).join("\n\n");
}

export function toolsHash(tools: OaiTool[]): string {
  return sha1(stableStringify(tools));
}

export const CALL_PROTOCOL = [
  "How to call a function: you do NOT execute functions; the client does, and sends you the result.",
  "To call one, output exactly this block (several blocks = parallel calls):",
  '<function_call name="function_name">',
  '<argument name="param">value</argument>',
  "</function_call>",
  "Rules:",
  "- One <argument> per parameter. Strings are raw text: no quotes, no JSON escaping, no Markdown fences; keep code indentation as-is.",
  "- Numbers and booleans are written plainly (42, true). Arrays and objects are written as JSON.",
  "- After your last </function_call> STOP. Never write a <tool_result> yourself and never guess what a function returns.",
  "- If no function is needed, just answer normally."
].join("\n");

// ---------------------------------------------------------------------------
// Prompt rendering

function renderToolCallsAsText(calls: OaiToolCall[]): string {
  return calls
    .map((call) => {
      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(call.function.arguments || "{}");
        if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
      } catch {
        // keep empty
      }
      const body = Object.entries(args)
        .map(([k, v]) => `<argument name="${k}">${typeof v === "string" ? v : JSON.stringify(v)}</argument>`)
        .join("\n");
      return `<function_call name="${call.function.name}">\n${body}\n</function_call>`;
    })
    .join("\n");
}

/** Renders dialog messages the way the web model is told to read them. */
export function renderDialog(messages: OaiMessage[]): string {
  return messages
    .map((message) => {
      const text = messageText(message.content).trim();
      if (message.role === "tool") {
        const attrs = [message.name ? `name="${message.name}"` : "", message.tool_call_id ? `id="${message.tool_call_id}"` : ""]
          .filter(Boolean)
          .join(" ");
        return `<tool_result${attrs ? ` ${attrs}` : ""}>\n${text}\n</tool_result>`;
      }
      if (message.role === "assistant") {
        const calls = message.tool_calls?.length ? renderToolCallsAsText(message.tool_calls) : "";
        return `<assistant>\n${[text, calls].filter(Boolean).join("\n")}\n</assistant>`;
      }
      return `<user>\n${text}\n</user>`;
    })
    .join("\n\n");
}

export function toolChoiceLine(choice: ToolChoice): string {
  if (choice === "none") return "Do not call any function in this reply.";
  if (choice === "required") return "You must call at least one function in this reply.";
  if (choice && typeof choice === "object") return `You must call the function "${choice.function.name}" in this reply.`;
  return "";
}

export type BootstrapInput = {
  system: string;
  tools: OaiTool[];
  history: OaiMessage[];
  pending: OaiMessage[];
  choice: ToolChoice;
};

/** First message of a fresh web session: the whole agent context, compacted. */
export function buildBootstrapPrompt(input: BootstrapInput): string {
  const parts = [
    "You are the language model inside an agent runtime. Adopt the instructions below as your own system prompt for this entire conversation.",
    `<system_instructions>\n${input.system || "You are a helpful assistant."}\n</system_instructions>`
  ];
  if (input.tools.length) {
    parts.push(`<functions>\n${compactManifest(input.tools)}\n</functions>`, CALL_PROTOCOL);
  }
  if (input.history.length) {
    parts.push(`<conversation_so_far>\n${renderDialog(input.history)}\n</conversation_so_far>`);
  }
  parts.push(renderDialog(input.pending));
  const choice = toolChoiceLine(input.choice);
  parts.push(["Reply now as the assistant to the latest message.", choice].filter(Boolean).join(" "));
  return parts.join("\n\n");
}

export type ToolDiff = { added: OaiTool[]; removed: string[] };

export function diffTools(previous: OaiTool[], next: OaiTool[]): ToolDiff {
  const before = new Map(previous.map((t) => [t.function.name, stableStringify(t)]));
  const after = new Set(next.map((t) => t.function.name));
  return {
    added: next.filter((t) => before.get(t.function.name) !== stableStringify(t)),
    removed: [...before.keys()].filter((name) => !after.has(name))
  };
}

export type DeltaInput = {
  pending: OaiMessage[];
  systemChanged?: string;
  toolDiff?: ToolDiff;
  protocolNeeded?: boolean;
  choice: ToolChoice;
};

/** Follow-up message into an existing web session: only what is new. */
export function buildDeltaPrompt(input: DeltaInput): string {
  const parts: string[] = [];
  if (input.systemChanged) {
    parts.push(`<system_instructions_updated>\n${input.systemChanged}\n</system_instructions_updated>`);
  }
  const diff = input.toolDiff;
  if (diff && (diff.added.length || diff.removed.length)) {
    const lines: string[] = [];
    if (diff.removed.length) lines.push(`Removed (do not call): ${diff.removed.join(", ")}`);
    if (diff.added.length) lines.push(`Added or changed:\n${compactManifest(diff.added)}`);
    parts.push(`<functions_update>\n${lines.join("\n\n")}\n</functions_update>`);
  }
  if (input.protocolNeeded) parts.push(CALL_PROTOCOL);
  parts.push(renderDialog(input.pending));
  const onlyToolResults = input.pending.length > 0 && input.pending.every((m) => m.role === "tool");
  const lead = onlyToolResults ? "Continue using these function results." : "Reply as the assistant.";
  parts.push([lead, toolChoiceLine(input.choice)].filter(Boolean).join(" "));
  return parts.join("\n\n");
}

/** What a naive bridge would send: full transcript + pretty JSON schemas, every time. */
export function naiveReplaySize(messages: OaiMessage[], tools: OaiTool[]): number {
  const { system, dialog } = splitSystem(messages);
  return system.length + renderDialog(dialog).length + (tools.length ? JSON.stringify(tools, null, 2).length : 0);
}

// ---------------------------------------------------------------------------
// Parsing model output into tool calls

export type ParsedReply = {
  content: string;
  calls: Array<{ name: string; rawArgs: Record<string, unknown> | string }>;
  /** Invented <tool_result> or text after the calls was removed. */
  guardTrimmed: boolean;
  /** Calls recovered from a non-protocol format (JSON block). */
  recovered: boolean;
  /** Syntax problems that make the reply unusable as-is. */
  syntaxErrors: string[];
};

const CALL_PATTERN = /<function_call\s+name\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)<\/function_call>/g;
const ARG_PATTERN = /<argument\s+name\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)<\/argument>/g;
const PARAM_PATTERN = /<parameter\s+name\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/g;

function stripFence(text: string): string {
  return text.trim().replace(/^```[a-zA-Z]*\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
}

function trimEdgeNewlines(value: string): string {
  return value.replace(/^\r?\n/, "").replace(/\r?\n[ \t]*$/, "");
}

/** Recognises `{"name": ..., "arguments": {...}}` style calls some replies fall back to. */
function recoverJsonCalls(content: string, toolNames: Set<string>): ParsedReply["calls"] {
  const calls: ParsedReply["calls"] = [];
  const candidates = content.match(/```(?:json)?\s*([\s\S]*?)```/g) ?? [];
  for (const block of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripFence(block));
    } catch {
      continue;
    }
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const fn = obj.function && typeof obj.function === "object" ? (obj.function as Record<string, unknown>) : obj;
      const name = [fn.name, obj.tool, obj.tool_name].find((v) => typeof v === "string") as string | undefined;
      if (!name || !toolNames.has(name)) continue;
      let args = fn.arguments ?? obj.parameters ?? obj.args ?? obj.input ?? {};
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          continue;
        }
      }
      if (args && typeof args === "object" && !Array.isArray(args)) {
        calls.push({ name, rawArgs: args as Record<string, unknown> });
      }
    }
  }
  return calls;
}

// DeepSeek models sometimes ignore the requested protocol and emit their own
// native "DSML" call markup, e.g.
//   <｜DSML｜invoke name="read_file"><｜DSML｜parameter name="path" string="true">a</｜DSML｜parameter></｜DSML｜invoke>
// The web chat may double the bars or add spaces, so match loosely.
const DSML = String.raw`[｜|]+\s*DSML\s*[｜|]+\s*`;
const DSML_WRAPPER = new RegExp(String.raw`<\s*/?\s*${DSML}(?:function_)?calls\s*>`, "g");
const DSML_INVOKE_OPEN = new RegExp(String.raw`<\s*${DSML}invoke\s+name\s*=\s*["']([^"']+)["'][^>]*>`, "g");
const DSML_INVOKE_CLOSE = new RegExp(String.raw`<\s*/\s*${DSML}invoke\s*>`, "g");
const DSML_PARAM_OPEN = new RegExp(String.raw`<\s*${DSML}parameter\s+name\s*=\s*["']([^"']+)["'][^>]*>`, "g");
const DSML_PARAM_CLOSE = new RegExp(String.raw`<\s*/\s*${DSML}parameter\s*>`, "g");

/** Rewrites native DSML call markup into the gateway's own protocol. */
export function normalizeNativeCalls(raw: string): { text: string; native: boolean } {
  if (!/DSML/.test(raw)) return { text: raw, native: false };
  const text = raw
    .replace(DSML_WRAPPER, "")
    .replace(DSML_INVOKE_OPEN, '<function_call name="$1">')
    .replace(DSML_INVOKE_CLOSE, "</function_call>")
    .replace(DSML_PARAM_OPEN, '<argument name="$1">')
    .replace(DSML_PARAM_CLOSE, "</argument>");
  return { text, native: text !== raw };
}

export function parseReply(input: string, tools: OaiTool[]): ParsedReply {
  const { text: raw, native } = normalizeNativeCalls(input);
  const toolNames = new Set(tools.map((t) => t.function.name));
  const calls: ParsedReply["calls"] = [];
  const syntaxErrors: string[] = [];
  let guardTrimmed = false;
  let lastEnd = -1;
  let firstStart = -1;
  let recoveredParams = false;

  CALL_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CALL_PATTERN.exec(raw)) !== null) {
    if (firstStart < 0) firstStart = match.index;
    lastEnd = match.index + match[0].length;
    const name = match[1].trim();
    const body = match[2];
    // Models sometimes write <parameter> (the DSML word) instead of <argument>.
    // Only honour it when no <argument> is present, so a <parameter> tag inside
    // file content being written is never mistaken for a call argument.
    const tag = /<argument\b/.test(body) ? "argument" : /<parameter\b/.test(body) ? "parameter" : "";
    if (tag) {
      const pattern = tag === "argument" ? ARG_PATTERN : PARAM_PATTERN;
      const args: Record<string, string> = {};
      pattern.lastIndex = 0;
      let arg: RegExpExecArray | null;
      while ((arg = pattern.exec(body)) !== null) {
        args[arg[1].trim()] = trimEdgeNewlines(arg[2]);
      }
      if (!Object.keys(args).length) syntaxErrors.push(`"${name}": <${tag}> blocks are malformed (each needs a closing </${tag}>).`);
      if (tag === "parameter" && Object.keys(args).length) recoveredParams = true;
      calls.push({ name, rawArgs: args });
    } else if (body.trim()) {
      calls.push({ name, rawArgs: stripFence(body) });
    } else {
      calls.push({ name, rawArgs: {} });
    }
  }

  let content = raw;
  if (calls.length) {
    // Text before the first call is the assistant's visible message; anything
    // after the last call is either an invented result or noise.
    const tail = raw.slice(lastEnd).trim();
    if (tail) guardTrimmed = true;
    content = raw.slice(0, firstStart).trim();
    const between = raw.slice(firstStart, lastEnd).replace(CALL_PATTERN, "").trim();
    if (/<tool_result\b/.test(between)) guardTrimmed = true;
  } else {
    const open = raw.search(/<function_call\b/);
    if (open >= 0) {
      syntaxErrors.push("A <function_call> block was opened but never closed with </function_call>.");
    }
    const invented = raw.search(/<tool_result\b/);
    if (invented >= 0) {
      content = raw.slice(0, invented).trim();
      guardTrimmed = true;
    }
  }

  let recovered = (native || recoveredParams) && calls.length > 0;
  if (!calls.length && !syntaxErrors.length && toolNames.size) {
    const jsonCalls = recoverJsonCalls(raw, toolNames);
    if (jsonCalls.length) {
      calls.push(...jsonCalls);
      recovered = true;
      content = raw.replace(/```(?:json)?\s*[\s\S]*?```/g, "").trim();
    }
  }

  return { content: content.trim(), calls, guardTrimmed, recovered, syntaxErrors };
}

// ---------------------------------------------------------------------------
// Schema-aware coercion and validation

function primaryType(schema: JsonSchema | undefined): string | undefined {
  if (!schema) return undefined;
  if (Array.isArray(schema.type)) return schema.type.find((t) => t !== "null");
  if (schema.type) return schema.type;
  if (schema.properties) return "object";
  if (schema.items) return "array";
  const union = schema.anyOf ?? schema.oneOf;
  return union ? primaryType(union.find((s) => primaryType(s) !== "null")) : undefined;
}

type Coerced = { ok: true; value: unknown } | { ok: false; error: string };

export function coerceValue(value: unknown, schema: JsonSchema | undefined): Coerced {
  const type = primaryType(schema);
  if (typeof value !== "string") {
    if (type === "string" && value !== null && typeof value !== "object") return { ok: true, value: String(value) };
    return { ok: true, value };
  }
  const text = value;
  switch (type) {
    case "integer":
    case "number": {
      const n = Number(text.trim());
      if (text.trim() === "" || Number.isNaN(n)) return { ok: false, error: `expected a ${type}, got "${clip(text, 40)}"` };
      if (type === "integer" && !Number.isInteger(n)) return { ok: false, error: `expected an integer, got ${n}` };
      return { ok: true, value: n };
    }
    case "boolean": {
      const t = text.trim().toLowerCase();
      if (t === "true" || t === "false") return { ok: true, value: t === "true" };
      return { ok: false, error: `expected true or false, got "${clip(text, 40)}"` };
    }
    case "array":
    case "object": {
      try {
        const parsed = JSON.parse(stripFence(text));
        const isArray = Array.isArray(parsed);
        if ((type === "array") !== isArray || parsed === null || typeof parsed !== "object") {
          return { ok: false, error: `expected a JSON ${type}` };
        }
        return { ok: true, value: parsed };
      } catch {
        if (type === "array" && !text.trim().startsWith("[")) {
          // A single bare item where a list was expected.
          return { ok: true, value: [text.trim()] };
        }
        return { ok: false, error: `expected valid JSON ${type}` };
      }
    }
    case "string":
      return { ok: true, value: text };
    default: {
      // Unknown type: accept JSON when it parses, else keep the raw text.
      try {
        return { ok: true, value: JSON.parse(text) };
      } catch {
        return { ok: true, value: text };
      }
    }
  }
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

export function closestName(name: string, names: string[]): string | undefined {
  let best: string | undefined;
  let bestScore = Infinity;
  for (const candidate of names) {
    const score = editDistance(name.toLowerCase(), candidate.toLowerCase());
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best && bestScore <= Math.max(2, Math.floor(name.length / 3)) ? best : undefined;
}

export type ValidatedCall = { name: string; args: Record<string, unknown> };

export type ValidationResult = {
  calls: ValidatedCall[];
  errors: string[];
  /** Calls whose tool name was auto-corrected (e.g. a near-miss typo). */
  renamed: number;
};

export function validateCalls(parsed: ParsedReply, tools: OaiTool[], choice: ToolChoice): ValidationResult {
  const byName = new Map(tools.map((t) => [t.function.name, t]));
  const names = [...byName.keys()];
  const errors = [...parsed.syntaxErrors];
  const calls: ValidatedCall[] = [];
  let renamed = 0;

  for (const call of parsed.calls) {
    let tool = byName.get(call.name);
    if (!tool) {
      const guess = closestName(call.name, names);
      // Only silently correct an unambiguous casing/separator slip.
      if (guess && guess.replace(/[-_]/g, "").toLowerCase() === call.name.replace(/[-_]/g, "").toLowerCase()) {
        tool = byName.get(guess);
        renamed++;
      } else {
        errors.push(`Unknown function "${call.name}".${guess ? ` Did you mean "${guess}"?` : ""} Available: ${names.join(", ")}.`);
        continue;
      }
    }
    const fn = tool!.function;
    let rawArgs = call.rawArgs;
    if (typeof rawArgs === "string") {
      try {
        const parsedJson = JSON.parse(rawArgs);
        if (!parsedJson || typeof parsedJson !== "object" || Array.isArray(parsedJson)) throw new Error("not an object");
        rawArgs = parsedJson as Record<string, unknown>;
      } catch {
        errors.push(`"${fn.name}": arguments must be <argument> blocks (or one JSON object).`);
        continue;
      }
    }
    const schema = fn.parameters ?? {};
    const props = schema.properties ?? {};
    const args: Record<string, unknown> = {};
    const callErrors: string[] = [];
    for (const [key, value] of Object.entries(rawArgs)) {
      const propSchema = props[key];
      if (!propSchema && schema.additionalProperties === false) {
        callErrors.push(`unknown parameter "${key}"`);
        continue;
      }
      const coerced = coerceValue(value, propSchema);
      if (!coerced.ok) {
        callErrors.push(`parameter "${key}": ${coerced.error}`);
        continue;
      }
      const allowed = propSchema?.enum;
      if (Array.isArray(allowed) && allowed.length && !allowed.some((v) => v === coerced.value)) {
        callErrors.push(`parameter "${key}" must be one of ${allowed.map((v) => JSON.stringify(v)).join(", ")}`);
        continue;
      }
      args[key] = coerced.value;
    }
    for (const key of schema.required ?? []) {
      if (!(key in args) && !callErrors.some((e) => e.includes(`"${key}"`))) callErrors.push(`missing required parameter "${key}"`);
    }
    if (callErrors.length) {
      errors.push(`"${fn.name}": ${callErrors.join("; ")}. Signature: ${toolSignature(tool!).split("\n")[0]}`);
      continue;
    }
    calls.push({ name: fn.name, args });
  }

  if (!errors.length) {
    if (choice === "required" && !calls.length) errors.push("This reply must call at least one function.");
    if (choice && typeof choice === "object" && !calls.some((c) => c.name === choice.function.name)) {
      errors.push(`This reply must call "${choice.function.name}".`);
    }
  }
  return { calls, errors, renamed };
}

export function buildRepairPrompt(errors: string[]): string {
  return [
    "Your previous reply could not be executed:",
    ...errors.map((e) => `- ${e}`),
    "",
    "Send the corrected reply now. Use the exact <function_call>/<argument> format, then stop; or answer without functions if none are needed."
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Conversation store (Delta Sync)

export type Conversation = {
  sessionId: string;
  /** Hash chain over the non-system dialog as the web session knows it. */
  chain: string[];
  system: string;
  tools: OaiTool[];
  toolsHash: string;
  lastUsed: number;
};

export type SyncPlan =
  | { kind: "bootstrap"; prompt: string; dialog: OaiMessage[]; system: string }
  | { kind: "delta"; prompt: string; dialog: OaiMessage[]; system: string; conversation: Conversation; pending: OaiMessage[] };

export class ConversationStore {
  private readonly conversations: Conversation[] = [];

  constructor(private readonly capacity = 24) {}

  get size(): number {
    return this.conversations.length;
  }

  clear(): void {
    this.conversations.length = 0;
  }

  /** Longest stored conversation that the request strictly extends. */
  findPrefix(dialog: OaiMessage[]): Conversation | undefined {
    const chain = hashChain(dialog);
    let best: Conversation | undefined;
    for (const conversation of this.conversations) {
      const n = conversation.chain.length;
      if (n === 0 || n >= chain.length) continue;
      if (chain[n - 1] !== conversation.chain[n - 1]) continue;
      if (!best || n > best.chain.length) best = conversation;
    }
    return best;
  }

  plan(messages: OaiMessage[], tools: OaiTool[], choice: ToolChoice): SyncPlan {
    const { system, dialog } = splitSystem(messages);
    const conversation = this.findPrefix(dialog);
    if (conversation) {
      const pending = dialog.slice(conversation.chain.length);
      const hadTools = conversation.tools.length > 0;
      const diff = toolsHash(tools) === conversation.toolsHash ? undefined : diffTools(conversation.tools, tools);
      const prompt = buildDeltaPrompt({
        pending,
        systemChanged: system !== conversation.system ? system : undefined,
        toolDiff: diff,
        protocolNeeded: !hadTools && tools.length > 0,
        choice
      });
      return { kind: "delta", prompt, dialog, system, conversation, pending };
    }
    // Replay the transcript in one message; the last user/tool run is "now".
    let split = dialog.length;
    while (split > 0 && dialog[split - 1].role !== "assistant") split--;
    if (split === dialog.length) split = Math.max(0, dialog.length - 1);
    const prompt = buildBootstrapPrompt({
      system,
      tools,
      history: dialog.slice(0, split),
      pending: dialog.slice(split),
      choice
    });
    return { kind: "bootstrap", prompt, dialog, system };
  }

  /** Records the session state after the reply that was returned to the client. */
  commit(plan: SyncPlan, sessionId: string, tools: OaiTool[], reply: OaiMessage): Conversation {
    const chain = hashChain([...plan.dialog, reply]);
    let conversation = plan.kind === "delta" ? plan.conversation : undefined;
    if (conversation && conversation.sessionId === sessionId) {
      conversation.chain = chain;
      conversation.system = plan.system;
      conversation.tools = tools;
      conversation.toolsHash = toolsHash(tools);
      conversation.lastUsed = Date.now();
    } else {
      conversation = { sessionId, chain, system: plan.system, tools, toolsHash: toolsHash(tools), lastUsed: Date.now() };
      this.conversations.push(conversation);
    }
    this.evict();
    return conversation;
  }

  forget(conversation: Conversation): void {
    const index = this.conversations.indexOf(conversation);
    if (index >= 0) this.conversations.splice(index, 1);
  }

  private evict(): void {
    if (this.conversations.length <= this.capacity) return;
    this.conversations.sort((a, b) => b.lastUsed - a.lastUsed);
    this.conversations.length = this.capacity;
  }
}
