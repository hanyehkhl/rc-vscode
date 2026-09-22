import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { buildVerifyPrompt, findProblems, getAgentSettings } from "../agentRunner";
import type { ChatTurn, UiAgentMode } from "../rcProcess";
import { buildWorkspaceContext } from "../workspaceContext";
import { AshnaApiError, AshnaClient, type AshnaErrorKind, type ChatMessage, type ToolCall } from "./client";
import { getAshnaApiKey, getAshnaSettings, type AshnaSettings } from "./config";
import { getSession, saveSession } from "./session";
import {
  describeToolCall,
  executeTool,
  isMutatingTool,
  parseToolArguments,
  samePath,
  toolDefinitions,
  type ToolContext
} from "./tools";

export type AshnaTurnOptions = {
  mode: UiAgentMode;
  /** Webview thread id; keys the per-thread transcript memory. */
  threadId: string;
  /** Fallback transcript (final texts only) when no in-memory session exists. */
  history: ChatTurn[];
  onStatus: (text: string) => void;
  /** Receives the full assistant text streamed so far (not just the delta). */
  onPreview: (text: string) => void;
  onToolEvent: (text: string) => void;
};

export type AshnaTurnResult =
  | { ok: true; text: string; limitReached: boolean; target: string }
  | { ok: false; cancelled: boolean; error: string; kind?: AshnaErrorKind };

type Target = { id: string; isAgent: boolean; withTools: boolean; readOnly: boolean };

const HISTORY_CHAR_BUDGET = 16_000;
const TURN_CHAR_LIMIT = 4_000;
const AGENTS_MD_MAX_CHARS = 20_000;
const MENTION_MAX_FILES = 4;
const MENTION_MAX_FILE_BYTES = 40 * 1024;
const MENTION_MAX_TOTAL_CHARS = 80_000;
const VERIFY_SETTLE_MS = 1500;

let activeController: AbortController | undefined;

export function isAshnaTurnRunning(): boolean {
  return activeController !== undefined;
}

export function abortAshnaTurn(): boolean {
  if (!activeController) return false;
  activeController.abort();
  return true;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

/**
 * Which Ashna model answers this turn.
 *
 * Chat mode → the custom agent when one is configured (its own prompt, data and
 * server-side tools). Agent modes → a foundation model with our workspace tools,
 * because custom agents run their tools on Ashna's servers and cannot touch the
 * local workspace. `useAgentForAgentModes` opts into sending tools to the agent.
 */
function chooseTarget(mode: UiAgentMode, settings: AshnaSettings): Target {
  const agentId = settings.agentId;
  if (mode === "ask") {
    return agentId
      ? { id: agentId, isAgent: true, withTools: false, readOnly: true }
      : { id: settings.model, isAgent: false, withTools: true, readOnly: true };
  }
  if (agentId && settings.useAgentForAgentModes) {
    return { id: agentId, isAgent: true, withTools: true, readOnly: false };
  }
  return { id: settings.model, isAgent: false, withTools: true, readOnly: false };
}

async function readAgentsMarkdown(root: string | undefined): Promise<string> {
  if (!root) return "";
  try {
    const text = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");
    return text.length > AGENTS_MD_MAX_CHARS ? `${text.slice(0, AGENTS_MD_MAX_CHARS)}\n… (truncated)` : text;
  } catch {
    return "";
  }
}

function systemPrompt(mode: UiAgentMode, readOnly: boolean, agentsMd: string): string {
  const root = vscode.workspace.workspaceFolders?.[0];
  const shell = process.platform === "win32" ? "cmd.exe (Windows) — use Windows command syntax" : "/bin/sh";
  const lines = [
    "You are RC, an expert software engineer working inside the user's VS Code workspace through tools.",
    root ? `Workspace root: ${root.name}. All tool paths are relative to it.` : "No folder is open; file tools are unavailable.",
    `Platform: ${os.platform()} ${os.release()}. run_command uses ${shell}.`,
    "",
    "How to work:",
    "1. Understand first: locate code with find_files / search_files, then read_file the relevant parts. Never describe or change code you have not read in this conversation.",
    "2. Plan briefly, then make the smallest correct change. Match the existing style, naming, imports and error handling.",
    "3. Edit with edit_file: old_text must be copied verbatim from read_file output WITHOUT the 'N| ' line-number prefix, small but unique. Several small edits beat one huge one. Use write_file only for new files or deliberate full rewrites.",
    "4. Verify: run the project's own tests / type-check / build with run_command when one exists, read the output, and fix what you broke. After you finish, the editor's diagnostics are checked and any errors are sent back to you.",
    "5. Do not invent APIs, packages, files or config keys. If something is missing, check package manifests or ask.",
    "6. Never paste whole files into chat — write them with tools. Do not leave TODOs or placeholder code.",
    "7. Finish with a short summary: what changed (files), why, and how it was verified. Say clearly if anything could not be verified.",
    "",
    "Independent read-only calls (e.g. reading several files) may be issued together in one response."
  ];
  if (readOnly) {
    lines.push("", "This is Chat mode: read-only. Do not modify files or run commands; read code and explain, or propose a patch in the reply.");
  } else if (mode === "write") {
    lines.push("", "The user approves each file change and command. If an action is declined, do not retry it; adapt or ask.");
  }
  if (agentsMd.trim()) {
    lines.push(
      "",
      "---",
      "# Project-specific instructions (from AGENTS.md — treat as ground truth for this project)",
      "",
      agentsMd.trim()
    );
  }
  return lines.join("\n");
}

function historyToMessages(history: ChatTurn[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i];
    if (!turn || (turn.role !== "user" && turn.role !== "assistant") || typeof turn.content !== "string") continue;
    const content =
      turn.content.length > TURN_CHAR_LIMIT ? `${turn.content.slice(0, TURN_CHAR_LIMIT)}\n… (truncated)` : turn.content;
    if (used + content.length > HISTORY_CHAR_BUDGET) break;
    used += content.length;
    out.unshift({ role: turn.role, content });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

/**
 * Some providers reject tool_call / tool messages when the request carries no
 * tool definitions (e.g. Anthropic-backed models). When this turn sends no
 * tools, fold earlier tool traffic into plain assistant text.
 */
function withoutToolTraffic(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === "tool") continue;
    if (message.role === "assistant" && message.tool_calls?.length) {
      const names = message.tool_calls.map((call) => call.function.name).join(", ");
      const text = [message.content ?? "", `(used tools: ${names})`].filter(Boolean).join("\n");
      out.push({ role: "assistant", content: text });
      continue;
    }
    out.push(message);
  }
  return out;
}

/** Inline small files the user referenced with @path, saving the model a round trip. */
async function mentionedFiles(text: string, root: string | undefined): Promise<string> {
  if (!root) return "";
  const seen = new Set<string>();
  const blocks: string[] = [];
  let total = 0;
  for (const match of text.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
    if (blocks.length >= MENTION_MAX_FILES) break;
    const relative = match[1].replace(/^["']|["'.,;:!?)]+$/g, "");
    const absolute = path.resolve(root, relative);
    const rel = path.relative(root, absolute);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || seen.has(absolute)) continue;
    seen.add(absolute);
    try {
      const stats = await fs.stat(absolute);
      if (!stats.isFile() || stats.size > MENTION_MAX_FILE_BYTES) continue;
      // fsPath has a lower-case drive letter on Windows; compare case-insensitively there.
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === "file" && samePath(d.uri.fsPath, absolute));
      const content = doc ? doc.getText() : await fs.readFile(absolute, "utf8");
      if (content.includes("\u0000") || total + content.length > MENTION_MAX_TOTAL_CHARS) continue;
      total += content.length;
      const numbered = content
        .split(/\r?\n/)
        .map((line, i) => `${i + 1}| ${line}`)
        .join("\n");
      blocks.push(`## ${rel.split(path.sep).join("/")}\n\`\`\`\n${numbered}\n\`\`\``);
    } catch {
      // not a file — leave the mention as a plain reference
    }
  }
  return blocks.length ? `# Files referenced with @ (current content)\n\n${blocks.join("\n\n")}` : "";
}

async function buildUserMessage(text: string, root: string | undefined, settings: AshnaSettings): Promise<string> {
  const parts: string[] = [];
  if (settings.editorContext) {
    try {
      const context = await buildWorkspaceContext();
      if (context) parts.push(context);
    } catch {
      // editor context is best-effort
    }
  }
  const files = await mentionedFiles(text, root);
  if (files) parts.push(files);
  parts.push(parts.length ? `---\n\n${text}` : text);
  return parts.join("\n\n");
}

type Approval = "allow" | "allowAll" | "deny";

async function askApproval(name: string, args: Record<string, unknown>): Promise<Approval> {
  const detail =
    name === "run_command"
      ? `Command:\n${String(args.command ?? "")}`
      : name === "write_file"
        ? `Write file: ${String(args.path ?? "")}`
        : name === "edit_file"
          ? `Edit file: ${String(args.path ?? "")}`
          : name === "delete_file"
            ? `Delete file: ${String(args.path ?? "")}`
            : describeToolCall(name, args);
  const choice = await vscode.window.showWarningMessage(
    `Ashna wants to run ${name}`,
    { modal: true, detail },
    "Allow",
    "Allow all this turn"
  );
  if (choice === "Allow") return "allow";
  if (choice === "Allow all this turn") return "allowAll";
  return "deny";
}

type TurnState = { allowAll: boolean; changed: Set<string> };

async function runToolCalls(
  calls: ToolCall[],
  mode: UiAgentMode,
  readOnly: boolean,
  ctx: ToolContext,
  state: TurnState,
  options: AshnaTurnOptions
): Promise<ChatMessage[]> {
  const results: ChatMessage[] = [];
  let declined = false;

  for (const call of calls) {
    const name = call.function.name;
    const reply = (content: string) => results.push({ role: "tool", tool_call_id: call.id, content });

    if (ctx.signal.aborted) {
      reply("Cancelled by the user.");
      continue;
    }
    if (declined) {
      reply("Skipped: an earlier action in this batch was declined by the user.");
      continue;
    }

    let args: Record<string, unknown>;
    try {
      args = parseToolArguments(call.function.arguments);
    } catch (error) {
      reply(
        `Error: arguments are not valid JSON (${error instanceof Error ? error.message : String(error)}). ` +
          "Send the call again with a valid JSON object; for large content prefer several smaller edit_file calls."
      );
      options.onToolEvent(`${name} failed: invalid arguments`);
      continue;
    }

    const label = describeToolCall(name, args);
    const mutating = isMutatingTool(name);

    if (mutating && readOnly) {
      reply("Blocked: Chat mode is read-only. Ask the user to switch to Agent mode.");
      options.onToolEvent(`${name} blocked — Chat mode cannot change files. Switch to Agent and send again.`);
      continue;
    }

    if (mutating && mode === "write" && !state.allowAll) {
      const approval = await askApproval(name, args);
      if (approval === "deny") {
        declined = true;
        reply("The user declined this action.");
        options.onToolEvent(`${label} — declined`);
        continue;
      }
      if (approval === "allowAll") state.allowAll = true;
    }

    options.onToolEvent(label);
    const outcome = await executeTool(name, args, ctx);
    if (!outcome.ok) {
      options.onToolEvent(`${name} failed: ${outcome.output.slice(0, 200)}`);
    }
    for (const file of outcome.changed ?? []) {
      state.changed.add(file);
      options.onToolEvent(`edited ${file}`);
    }
    reply(outcome.output);
  }
  return results;
}

export async function runAshnaTurn(text: string, options: AshnaTurnOptions): Promise<AshnaTurnResult> {
  const apiKey = getAshnaApiKey();
  if (!apiKey) {
    return { ok: false, cancelled: false, error: "Ashna API key is not set.", kind: "auth" };
  }
  if (activeController) {
    return { ok: false, cancelled: false, error: "Another Ashna turn is still running." };
  }

  const settings = getAshnaSettings();
  const agentSettings = getAgentSettings();
  const target = chooseTarget(options.mode, settings);
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const withTools = target.withTools && Boolean(root);

  const controller = new AbortController();
  activeController = controller;
  const client = new AshnaClient({ baseUrl: settings.baseUrl, apiKey, timeoutMs: settings.requestTimeoutMs });

  try {
    const prior = getSession(options.threadId) ?? historyToMessages(options.history);
    // Conversation without the system prompt: this is what gets remembered.
    const conversation: ChatMessage[] = [
      ...(withTools ? prior : withoutToolTraffic(prior)),
      { role: "user", content: await buildUserMessage(text, root, settings) }
    ];
    // A custom agent carries its own system prompt; do not override it.
    const system: ChatMessage[] = target.isAgent
      ? []
      : [{ role: "system", content: systemPrompt(options.mode, target.readOnly, await readAgentsMarkdown(root)) }];

    const tools = withTools ? toolDefinitions({ readOnly: target.readOnly }) : undefined;
    const ctx: ToolContext = { root: root ?? "", signal: controller.signal, commandTimeoutMs: settings.commandTimeoutMs };
    const state: TurnState = { allowAll: options.mode === "auto", changed: new Set<string>() };
    const canVerify = agentSettings.verifyEdits && !target.readOnly;
    const maxContinues = agentSettings.autoContinue ? Math.max(0, agentSettings.maxContinues) : 0;

    options.onStatus(`Ashna · ${target.isAgent ? "agent" : "model"} ${target.id}…`);

    let transcript = "";
    let budget = settings.maxToolRounds;
    let continues = 0;
    let verifyRounds = 0;
    let round = 0;

    for (;;) {
      if (round >= budget) {
        if (continues >= maxContinues) {
          saveSession(options.threadId, conversation);
          return {
            ok: true,
            text: `${transcript || "Stopped."}\n\n_Reached the tool-round limit. Send "continue" to keep going._`,
            limitReached: true,
            target: target.id
          };
        }
        continues++;
        budget += settings.maxToolRounds;
        options.onStatus(`Continuing (${continues}/${maxContinues})…`);
      }
      round++;

      // The preview keeps earlier rounds' narration visible while tools run.
      const roundPrefix = transcript ? `${transcript}\n\n` : "";
      let roundText = "";
      const result = await client.streamChat(
        { model: target.id, messages: [...system, ...conversation], tools },
        (delta) => {
          roundText += delta;
          options.onPreview(roundPrefix + roundText);
        },
        controller.signal
      );
      if (result.content.trim()) {
        transcript = roundPrefix + result.content.trim();
      }

      if (result.toolCalls.length) {
        conversation.push({ role: "assistant", content: result.content || null, tool_calls: result.toolCalls });
        conversation.push(...(await runToolCalls(result.toolCalls, options.mode, target.readOnly, ctx, state, options)));
        if (controller.signal.aborted) {
          return { ok: false, cancelled: true, error: "Cancelled." };
        }
        options.onStatus(`Ashna · step ${round + 1}…`);
        continue;
      }

      conversation.push({ role: "assistant", content: result.content || "" });

      // Verify: language-server errors and the project's type-check go back to
      // the model so it fixes what it broke before the turn ends.
      if (canVerify && state.changed.size && verifyRounds < agentSettings.maxVerifyRounds) {
        await delay(VERIFY_SETTLE_MS, controller.signal);
        if (controller.signal.aborted) {
          return { ok: false, cancelled: true, error: "Cancelled." };
        }
        options.onStatus("Verifying edits…");
        const problem = await findProblems([...state.changed], options.onStatus);
        if (problem) {
          verifyRounds++;
          options.onStatus(`Fixing errors (${verifyRounds}/${agentSettings.maxVerifyRounds})…`);
          options.onToolEvent(`verify: ${problem.source} reported errors`);
          conversation.push({ role: "user", content: buildVerifyPrompt(problem.source, problem.details) });
          continue;
        }
      }

      saveSession(options.threadId, conversation);
      return { ok: true, text: transcript || "(no response)", limitReached: false, target: target.id };
    }
  } catch (error) {
    if (error instanceof AshnaApiError) {
      return { ok: false, cancelled: error.kind === "aborted", error: error.message, kind: error.kind };
    }
    if (controller.signal.aborted) {
      return { ok: false, cancelled: true, error: "Cancelled." };
    }
    return { ok: false, cancelled: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (activeController === controller) activeController = undefined;
  }
}

/** Fetch the foundation-model catalog for the model picker. */
export async function listAshnaModels(): Promise<string[]> {
  const apiKey = getAshnaApiKey();
  if (!apiKey) throw new AshnaApiError("Ashna API key is not set.", "auth");
  const settings = getAshnaSettings();
  const client = new AshnaClient({ baseUrl: settings.baseUrl, apiKey, timeoutMs: 30_000 });
  return client.listModels();
}
