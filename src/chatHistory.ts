import * as vscode from "vscode";
import type { ChatTurn } from "./rcProcess";

/**
 * Persisted chat threads.
 *
 * The webview loses everything when the panel is disposed, so history lives in
 * the extension's globalState instead — it survives reloads and window changes.
 */

const STORAGE_KEY = "rc.chatHistory";
const MAX_THREADS = 50;
const MAX_TURNS_PER_THREAD = 200;
const MAX_TITLE_CHARS = 60;

export type StoredThread = {
  id: string;
  title: string;
  updatedAt: number;
  turns: ChatTurn[];
};

export type ThreadSummary = {
  id: string;
  title: string;
  updatedAt: number;
  turnCount: number;
};

let storage: vscode.Memento | undefined;

export function initChatHistory(memento: vscode.Memento): void {
  storage = memento;
}

function readAll(): StoredThread[] {
  const raw = storage?.get<StoredThread[]>(STORAGE_KEY, []) ?? [];
  return Array.isArray(raw) ? raw : [];
}

async function writeAll(threads: StoredThread[]): Promise<void> {
  await storage?.update(STORAGE_KEY, threads.slice(0, MAX_THREADS));
}

function titleFrom(turns: ChatTurn[]): string {
  const firstUser = turns.find((turn) => turn.role === "user");
  const text = (firstUser?.content ?? "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "New chat";
  }
  return text.length > MAX_TITLE_CHARS ? `${text.slice(0, MAX_TITLE_CHARS)}…` : text;
}

export function listThreads(): ThreadSummary[] {
  return readAll()
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((thread) => ({
      id: thread.id,
      title: thread.title,
      updatedAt: thread.updatedAt,
      turnCount: thread.turns.length
    }));
}

export function loadThread(id: string): ChatTurn[] {
  return readAll().find((thread) => thread.id === id)?.turns ?? [];
}

/** Insert or update one thread. Empty threads are never stored. */
export async function saveThread(id: string, turns: ChatTurn[]): Promise<void> {
  if (!id || turns.length === 0) {
    return;
  }

  const trimmed = turns.slice(-MAX_TURNS_PER_THREAD);
  const threads = readAll().filter((thread) => thread.id !== id);
  threads.unshift({
    id,
    title: titleFrom(trimmed),
    updatedAt: Date.now(),
    turns: trimmed
  });

  threads.sort((a, b) => b.updatedAt - a.updatedAt);
  await writeAll(threads);
}

export async function deleteThread(id: string): Promise<void> {
  await writeAll(readAll().filter((thread) => thread.id !== id));
}

export async function clearAllThreads(): Promise<void> {
  await writeAll([]);
}
