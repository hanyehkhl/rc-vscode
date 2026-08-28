import * as vscode from "vscode";
import {
  getAbortEpoch,
  getThreadSession,
  runPlainPrompt,
  setThreadSession,
  type ChatTurn,
  type PlainPromptResult,
  type RcEvent,
  type ThinkingEffort,
  type UiAgentMode
} from "./rcProcess";
import { buildWorkspaceContext, countErrors, formatDiagnostics } from "./workspaceContext";
import { runProjectCheck } from "./projectCheck";

export type AgentSettings = {
  editorContext: boolean;
  sessionMemory: boolean;
  autoContinue: boolean;
  maxContinues: number;
  verifyEdits: boolean;
  runChecks: boolean;
  grounding: boolean;
  maxVerifyRounds: number;
  maxToolRounds: number;
};

export function getAgentSettings(): AgentSettings {
  const config = vscode.workspace.getConfiguration("rc.agent");
  return {
    editorContext: config.get<boolean>("editorContext", true),
    sessionMemory: config.get<boolean>("sessionMemory", true),
    autoContinue: config.get<boolean>("autoContinue", true),
    maxContinues: config.get<number>("maxContinues", 3),
    verifyEdits: config.get<boolean>("verifyEdits", true),
    runChecks: config.get<boolean>("runChecks", true),
    grounding: config.get<boolean>("grounding", true),
    maxVerifyRounds: config.get<number>("maxVerifyRounds", 2),
    maxToolRounds: config.get<number>("maxToolRounds", 14)
  };
}

export type AgentRunOptions = {
  mode: UiAgentMode;
  search: boolean;
  thinkingEffort: ThinkingEffort;
  history: ChatTurn[];
  threadId: string;
  onStatus?: (text: string) => void;
  onDelta?: (text: string) => void;
  onEvent?: (event: RcEvent) => void;
};

export type AgentRunResult = PlainPromptResult & {
  continues: number;
  verifyRounds: number;
};

const CONTINUE_PROMPT =
  "Continue from where you stopped. Do not repeat finished work, do not summarize — " +
  "carry out the remaining steps and report the result.";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Network blips and PoW challenge failures are worth one silent retry. */
const TRANSIENT_ERROR = /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network|timeout|502|503|504/i;

function isTransient(result: PlainPromptResult): boolean {
  if (result.ok || result.cancelled) {
    return false;
  }
  return TRANSIENT_ERROR.test(result.stderr || result.stdout || "");
}

function buildVerifyPrompt(source: string, details: string): string {
  return [
    `Your edits left the workspace failing. ${source} reports:`,
    "",
    details,
    "",
    "Re-read the affected files and fix these errors. If an error is pre-existing and",
    "unrelated to your change, say so instead of touching it. When you are done, state",
    "briefly what you fixed."
  ].join("\n");
}

type Problem = { source: string; details: string };

/**
 * Look for problems the edits introduced, cheapest signal first.
 *
 * Editor diagnostics are instant but only cover files a language server has
 * analyzed. The project's own type-checker is slower and authoritative, so it
 * runs second — and catches everything the editor never looked at.
 */
async function findProblems(
  paths: string[],
  onStatus?: (text: string) => void
): Promise<Problem | undefined> {
  if (countErrors(paths) > 0) {
    const diagnostics = formatDiagnostics(paths);
    if (diagnostics) {
      return { source: "The language server", details: diagnostics };
    }
  }

  const check = await runProjectCheck();
  if (!check.ran) {
    return undefined;
  }
  if (check.ok) {
    onStatus?.(`${check.label} passed`);
    return undefined;
  }

  return { source: `\`${check.label}\``, details: check.output };
}

/**
 * Run one user turn end to end: inject editor context, resume the thread's
 * session, continue past the tool-round ceiling, then check the edits against
 * the language server and let the agent fix its own mistakes.
 */
export async function runAgentTurn(
  prompt: string,
  options: AgentRunOptions
): Promise<AgentRunResult> {
  const settings = getAgentSettings();
  const startEpoch = getAbortEpoch();
  const cancelled = () => getAbortEpoch() !== startEpoch;
  const contextBlock = settings.editorContext ? await buildWorkspaceContext() : "";
  const sessionId = settings.sessionMemory ? getThreadSession(options.threadId) : undefined;

  const base = {
    search: options.search,
    thinkingEffort: options.thinkingEffort,
    keepSession: settings.sessionMemory,
    maxToolRounds: settings.maxToolRounds,
    grounding: settings.grounding,
    onDelta: options.onDelta,
    onEvent: options.onEvent
  };

  let result = await runPlainPrompt(prompt, options.mode, options.history, {
    ...base,
    sessionId,
    contextBlock
  });

  if (isTransient(result) && !cancelled()) {
    options.onStatus?.("Connection hiccup — retrying…");
    await delay(1200);
    result = await runPlainPrompt(prompt, options.mode, options.history, {
      ...base,
      sessionId: settings.sessionMemory
        ? (result.sessionId || getThreadSession(options.threadId))
        : undefined,
      contextBlock
    });
  }

  const rememberSession = (next: PlainPromptResult) => {
    if (settings.sessionMemory && next.sessionId) {
      setThreadSession(options.threadId, next.sessionId);
    }
  };
  rememberSession(result);

  if (!result.ok || result.cancelled) {
    return { ...result, continues: 0, verifyRounds: 0 };
  }

  const parts = [result.stdout];
  const editedPaths = new Set(result.editedPaths ?? []);
  let continues = 0;
  let verifyRounds = 0;

  // The agent stops at the tool-round ceiling mid-task. Without this the user
  // just gets a truncated answer and has no way to resume from the panel.
  // Without session memory a continuation carries no conversation, so
  // "carry on from where you stopped" would have nothing to refer to.
  while (
    settings.autoContinue &&
    settings.sessionMemory &&
    result.limitReached &&
    continues < settings.maxContinues
  ) {
    if (cancelled()) {
      return { ...result, cancelled: true, stdout: parts.join("\n\n"), continues, verifyRounds };
    }
    continues++;
    options.onStatus?.(`Continuing (${continues}/${settings.maxContinues})…`);

    const next = await runPlainPrompt(CONTINUE_PROMPT, options.mode, [], {
      ...base,
      sessionId: settings.sessionMemory ? getThreadSession(options.threadId) : undefined,
      contextBlock: ""
    });
    rememberSession(next);

    if (next.cancelled) {
      return { ...next, stdout: parts.join("\n\n"), continues, verifyRounds };
    }
    if (!next.ok) {
      break;
    }

    parts.push(next.stdout);
    for (const editedPath of next.editedPaths ?? []) {
      editedPaths.add(editedPath);
    }
    result = next;
  }

  // Verify loop: the language server already knows what the edits broke, so
  // feeding those errors back costs nothing and catches most bad edits.
  const canVerify =
    settings.verifyEdits && options.mode !== "ask" && editedPaths.size > 0;

  if (canVerify) {
    for (let round = 0; round < settings.maxVerifyRounds; round++) {
      // Give language servers a moment to reanalyze the files just written.
      await delay(1500);
      if (cancelled()) {
        return { ...result, cancelled: true, stdout: parts.join("\n\n"), continues, verifyRounds };
      }

      options.onStatus?.("Verifying edits…");
      const problem = await findProblems([...editedPaths], options.onStatus);
      if (!problem) {
        break;
      }
      if (cancelled()) {
        return { ...result, cancelled: true, stdout: parts.join("\n\n"), continues, verifyRounds };
      }

      verifyRounds++;
      options.onStatus?.(`Fixing errors (${verifyRounds}/${settings.maxVerifyRounds})…`);

      const fix = await runPlainPrompt(
        buildVerifyPrompt(problem.source, problem.details),
        options.mode,
        [],
        {
          ...base,
          sessionId: settings.sessionMemory
            ? getThreadSession(options.threadId)
            : undefined,
          contextBlock: ""
        }
      );
      rememberSession(fix);

      if (fix.cancelled) {
        return { ...fix, stdout: parts.join("\n\n"), continues, verifyRounds };
      }
      if (!fix.ok) {
        break;
      }

      parts.push(fix.stdout);
      for (const editedPath of fix.editedPaths ?? []) {
        editedPaths.add(editedPath);
      }
      result = fix;
    }
  }

  return {
    ...result,
    ok: true,
    stdout: parts.join("\n\n"),
    editedPaths: [...editedPaths],
    continues,
    verifyRounds
  };
}
