import {
  abortPlainPrompt,
  runPlainPrompt,
  type ThinkingEffort,
  type UiAgentMode
} from "./rcProcess";
import {
  DEFAULT_PAIR_ROUNDS,
  REVIEWER_SYSTEM,
  WRITER_SYSTEM
} from "./prompts/pairMode";
import { buildWorkspaceContext } from "./workspaceContext";

export type PairRole = "writer" | "reviewer";

export type PairMessageHandler = (role: PairRole, text: string, round: number) => void;
export type PairStatusHandler = (text: string) => void;

type PairOptions = {
  task: string;
  rounds?: number;
  mode?: UiAgentMode;
  search?: boolean;
  thinkingEffort?: ThinkingEffort;
  onMessage: PairMessageHandler;
  onStatus?: PairStatusHandler;
};

type PairResult = {
  ok: boolean;
  cancelled?: boolean;
  error?: string;
};

let pairRunning = false;
let pairAbort = false;
const pendingUserNotes: string[] = [];

export function isPairRunning(): boolean {
  return pairRunning;
}

export function queuePairUserMessage(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }
  pendingUserNotes.push(trimmed);
}

export function abortPairMode(): boolean {
  pairAbort = true;
  pendingUserNotes.length = 0;
  return abortPlainPrompt();
}

function takeUserNotes(): string {
  if (pendingUserNotes.length === 0) {
    return "";
  }
  const notes = pendingUserNotes.splice(0, pendingUserNotes.length);
  return notes.map((note, index) => `${index + 1}. ${note}`).join("\n");
}

function buildWriterPrompt(task: string, transcript: string, userNotes: string): string {
  const parts = [
    WRITER_SYSTEM,
    "",
    "Task:",
    task
  ];

  if (transcript.trim()) {
    parts.push("", "Conversation so far:", transcript.trim());
  }

  if (userNotes) {
    parts.push("", "User notes (high priority):", userNotes);
  }

  parts.push(
    "",
    "Now respond as Writer. Produce or improve the solution."
  );

  return parts.join("\n");
}

function buildReviewerPrompt(task: string, transcript: string, writerOutput: string, userNotes: string): string {
  const parts = [
    REVIEWER_SYSTEM,
    "",
    "Task:",
    task
  ];

  if (transcript.trim()) {
    parts.push("", "Conversation so far:", transcript.trim());
  }

  parts.push("", "Writer's latest output:", writerOutput);

  if (userNotes) {
    parts.push("", "User notes (high priority):", userNotes);
  }

  parts.push(
    "",
    "Now respond as Reviewer. Critique the Writer's latest output."
  );

  return parts.join("\n");
}

async function callRole(
  prompt: string,
  mode: UiAgentMode,
  search: boolean,
  thinkingEffort: ThinkingEffort,
  contextBlock: string
): Promise<{ ok: boolean; cancelled?: boolean; text: string; error?: string }> {
  const result = await runPlainPrompt(prompt, mode, [], {
    search,
    thinkingEffort,
    contextBlock
  });

  if (result.cancelled || pairAbort) {
    return { ok: false, cancelled: true, text: "" };
  }

  if (!result.ok) {
    return {
      ok: false,
      text: "",
      error: result.stderr || result.stdout || "Pair mode call failed."
    };
  }

  return { ok: true, text: result.stdout };
}

/**
 * Run Writer ↔ Reviewer for a fixed number of rounds.
 * One round = Writer then Reviewer.
 * User notes queued via queuePairUserMessage() are injected before the next role call.
 */
export async function runPairLoop(options: PairOptions): Promise<PairResult> {
  if (pairRunning) {
    return { ok: false, error: "Pair mode is already running." };
  }

  const rounds = Math.max(1, options.rounds ?? DEFAULT_PAIR_ROUNDS);
  const mode = options.mode ?? "ask";
  const search = Boolean(options.search);
  const thinkingEffort = options.thinkingEffort ?? "off";

  pairRunning = true;
  pairAbort = false;
  pendingUserNotes.length = 0;

  const transcriptParts: string[] = [];
  const contextBlock = await buildWorkspaceContext();

  try {
    for (let round = 1; round <= rounds; round++) {
      if (pairAbort) {
        return { ok: false, cancelled: true };
      }

      options.onStatus?.(`Pair mode · round ${round}/${rounds} · Writer…`);

      const writerPrompt = buildWriterPrompt(
        options.task,
        transcriptParts.join("\n\n"),
        takeUserNotes()
      );
      const writerResult = await callRole(writerPrompt, mode, search, thinkingEffort, contextBlock);

      if (writerResult.cancelled) {
        return { ok: false, cancelled: true };
      }
      if (!writerResult.ok) {
        return { ok: false, error: writerResult.error };
      }

      transcriptParts.push(`Writer (round ${round}):\n${writerResult.text}`);
      options.onMessage("writer", writerResult.text, round);

      if (pairAbort) {
        return { ok: false, cancelled: true };
      }

      options.onStatus?.(`Pair mode · round ${round}/${rounds} · Reviewer…`);

      const reviewerPrompt = buildReviewerPrompt(
        options.task,
        transcriptParts.join("\n\n"),
        writerResult.text,
        takeUserNotes()
      );
      const reviewerResult = await callRole(reviewerPrompt, mode, search, thinkingEffort, contextBlock);

      if (reviewerResult.cancelled) {
        return { ok: false, cancelled: true };
      }
      if (!reviewerResult.ok) {
        return { ok: false, error: reviewerResult.error };
      }

      transcriptParts.push(`Reviewer (round ${round}):\n${reviewerResult.text}`);
      options.onMessage("reviewer", reviewerResult.text, round);
    }

    return { ok: true };
  } finally {
    pairRunning = false;
    pairAbort = false;
    pendingUserNotes.length = 0;
  }
}
