import type { ChatMessage } from "./client";

/**
 * Per-thread conversation memory for Ashna.
 *
 * The webview only replays final assistant texts, so without this a follow-up
 * like "now add a test for it" loses every file the model read and every edit
 * it made. The Chat Completions API is stateless, so the transcript (including
 * tool calls and results) is kept here and compacted to stay within budget.
 */

const MAX_THREADS = 20;
/** Rough character budget for the replayed transcript (~40k tokens). */
const TRANSCRIPT_CHAR_BUDGET = 160_000;
/** Tool results older than the last few exchanges are shortened first. */
const KEEP_RECENT_MESSAGES = 16;
const STALE_TOOL_OUTPUT_CHARS = 600;

const threads = new Map<string, ChatMessage[]>();

export function getSession(threadId: string): ChatMessage[] | undefined {
  const messages = threads.get(threadId);
  if (!messages) return undefined;
  // Refresh LRU position.
  threads.delete(threadId);
  threads.set(threadId, messages);
  return messages.slice();
}

export function saveSession(threadId: string, messages: ChatMessage[]): void {
  threads.delete(threadId);
  threads.set(threadId, compact(messages.filter((m) => m.role !== "system")));
  while (threads.size > MAX_THREADS) {
    const oldest = threads.keys().next().value;
    if (oldest === undefined) break;
    threads.delete(oldest);
  }
}

export function clearSession(threadId?: string): void {
  if (threadId) threads.delete(threadId);
  else threads.clear();
}

function size(message: ChatMessage): number {
  let total = typeof message.content === "string" ? message.content.length : 0;
  if (message.role === "assistant") {
    for (const call of message.tool_calls ?? []) total += call.function.arguments.length + call.function.name.length;
  }
  return total;
}

/**
 * Shrink the transcript: first shorten stale tool outputs, then drop whole
 * leading exchanges. A tool message is never left without its assistant
 * tool_calls message (the API rejects orphaned tool results).
 */
export function compact(messages: ChatMessage[]): ChatMessage[] {
  const out = messages.slice();
  let total = out.reduce((sum, m) => sum + size(m), 0);
  if (total <= TRANSCRIPT_CHAR_BUDGET) return out;

  const staleLimit = Math.max(0, out.length - KEEP_RECENT_MESSAGES);
  for (let i = 0; i < staleLimit && total > TRANSCRIPT_CHAR_BUDGET; i++) {
    const message = out[i];
    if (message.role === "tool" && message.content.length > STALE_TOOL_OUTPUT_CHARS) {
      const shortened = `${message.content.slice(0, STALE_TOOL_OUTPUT_CHARS)}\n… (older tool output trimmed; re-run the tool if needed)`;
      total -= message.content.length - shortened.length;
      out[i] = { ...message, content: shortened };
    }
  }

  // Drop from the front, one user-started exchange at a time.
  while (total > TRANSCRIPT_CHAR_BUDGET && out.length > 1) {
    let cut = 1;
    while (cut < out.length && out[cut].role !== "user") cut++;
    if (cut >= out.length) break; // keep the latest exchange intact
    for (const removed of out.splice(0, cut)) total -= size(removed);
  }
  return out;
}
