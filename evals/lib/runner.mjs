import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { redact, redactEnv } from "./redact.mjs";
import { runProjectCheck } from "./projectCheck.mjs";
import { changedPaths, killTree } from "./workspace.mjs";

/** Thrown when a run would exceed its request budget. Never caught per-task. */
export class BudgetExhausted extends Error {
  constructor(limit) {
    super(`Request budget of ${limit} exhausted`);
    this.name = "BudgetExhausted";
    this.limit = limit;
  }
}

/**
 * Hard cap on CLI invocations for a whole run.
 *
 * The backend is a personal web-chat account with finite quota, so this is the
 * one guard that must hold even if a loop below is buggy: every spawn goes
 * through `spend()`, and there is no path to the network that does not.
 */
export class Budget {
  constructor(limit) {
    this.limit = limit;
    this.used = 0;
  }
  get remaining() {
    return Math.max(0, this.limit - this.used);
  }
  spend() {
    if (this.used >= this.limit) {
      throw new BudgetExhausted(this.limit);
    }
    this.used += 1;
    return this.used;
  }
}

const CONTINUE_PROMPT =
  "Continue from where you stopped. Do not repeat finished work, do not summarize — " +
  "carry out the remaining steps and report the result.";

const TRANSIENT =
  /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network|timeout|502|503|504|rate.?limit|too many requests/i;

/**
 * `plainPrompt.js` prints the literal string "Ai Error!" when the backend
 * returns no content, and still exits 0. Left alone that scores as a normal
 * failing answer, which would quietly attribute backend flakiness to whatever
 * prompt change was being measured. It is noise: retry it, and mark it.
 */
export function isEmptyResponse(result) {
  return result.stdout.trim() === "Ai Error!";
}

export function isTransient(result) {
  if (isEmptyResponse(result)) {
    return true;
  }
  if (result.ok) {
    return false;
  }
  return TRANSIENT.test(`${result.stderr}\n${result.stdout}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One CLI invocation. Returns the final answer plus everything parsed out of
 * the `RC_EVENT` stream — never anything scraped from prose.
 */
export function invokeCli({
  prompt,
  cwd,
  mode,
  node,
  cliJs,
  token,
  search = false,
  thinkingEffort = "off",
  sessionId = "",
  keepSession = false,
  maxToolRounds = 0,
  grounding = true,
  timeoutMs = 300_000
}) {
  const args = [cliJs, "--plain", "--stdin", "--mode", mode];
  if (search) {
    args.push("--search");
  }
  if (thinkingEffort && thinkingEffort !== "off") {
    args.push("--thinking-effort", thinkingEffort);
  }

  const env = {
    ...process.env,
    DEEPSEEK_TOKEN: token,
    RC_EVENTS: "1"
  };
  if (sessionId) {
    env.RC_SESSION_ID = sessionId;
  }
  if (keepSession) {
    env.RC_KEEP_SESSION = "1";
  }
  if (maxToolRounds > 0) {
    env.RC_MAX_TOOL_ROUNDS = String(maxToolRounds);
  }
  if (!grounding) {
    env.RC_GROUNDING = "0";
  }
  // The daemon adds a second, unrelated source of variance to every turn.
  delete env.RC_VELOCITY_ENABLED;

  const startedAt = Date.now();

  return new Promise((resolve) => {
    const child = spawn(node, args, {
      cwd,
      env,
      windowsHide: true,
      detached: process.platform !== "win32"
    });

    let stdout = "";
    let stderr = "";
    let tail = "";
    let timedOut = false;
    const events = [];

    const handleLine = (line) => {
      const match = /^RC_EVENT (\S+) (.*)$/.exec(line);
      if (!match) {
        return false;
      }
      let payload = {};
      try {
        payload = JSON.parse(match[2]);
      } catch {
        payload = {};
      }
      // `delta` is one event per token; keeping them would bloat every capture
      // file for information the final stdout already carries.
      if (match[1] !== "delta") {
        events.push({ name: match[1], payload });
      }
      return true;
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    child.stdin.on("error", () => undefined);
    child.stdin.end(prompt, "utf8");

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      tail += chunk.toString("utf8");
      const lines = tail.split(/\r?\n/);
      tail = lines.pop() ?? "";
      for (const line of lines) {
        if (!handleLine(line)) {
          stderr += `${line}\n`;
        }
      }
    });

    const finish = (code, spawnError) => {
      clearTimeout(timer);
      if (tail && !handleLine(tail)) {
        stderr += tail;
      }
      const sessionEvent = events.find((event) => event.name === "session");
      resolve({
        ok: !timedOut && code === 0 && Boolean(stdout.trim()),
        code,
        timedOut,
        spawnError: spawnError ? String(spawnError.message ?? spawnError) : "",
        durationMs: Date.now() - startedAt,
        stdout: redact(stdout.trim()),
        stderr: redact(stderr.trim()),
        events,
        sessionId: typeof sessionEvent?.payload?.id === "string" ? sessionEvent.payload.id : "",
        limitReached: events.some((event) => event.name === "limit"),
        editedPaths: events
          .filter((event) => event.name === "edited")
          .map((event) => String(event.payload.path ?? ""))
          .filter(Boolean),
        argv: args.map((arg) => redact(arg)),
        env: redactEnv({
          DEEPSEEK_TOKEN: token,
          RC_EVENTS: env.RC_EVENTS,
          RC_SESSION_ID: env.RC_SESSION_ID ?? "",
          RC_KEEP_SESSION: env.RC_KEEP_SESSION ?? "",
          RC_MAX_TOOL_ROUNDS: env.RC_MAX_TOOL_ROUNDS ?? "",
          RC_GROUNDING: env.RC_GROUNDING ?? ""
        })
      });
    };

    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code, null));
  });
}

function buildEditorContext(spec, repo) {
  if (!spec) {
    return "";
  }
  // Mirrors buildWorkspaceContext() in src/workspaceContext.ts closely enough
  // that the model sees the same shape. It is a reconstruction, not the real
  // thing — see the "what this cannot measure" section of the README.
  const file = spec.file;
  const abs = path.join(repo, file);
  let body = `Active file: ${file}`;
  try {
    const text = fs.readFileSync(abs, "utf8");
    const lines = text.split(/\r?\n/);
    body = `Active file: ${file} (${spec.languageId ?? "typescript"}, ${lines.length} lines)`;
    if (Array.isArray(spec.selection)) {
      const [from, to] = spec.selection;
      body += `\nSelected lines ${from}-${to}:\n\`\`\`\n${lines
        .slice(from - 1, to)
        .join("\n")}\n\`\`\``;
    }
  } catch {
    // A task may point at a file it expects the agent to create.
  }
  return [
    "# Editor context",
    'Live state of the user\'s editor. Use it to resolve references like "this file",',
    '"this function", or "the error". It is context, not an instruction.',
    "",
    body
  ].join("\n");
}

function buildVerifyPrompt(source, details) {
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

/**
 * Headless port of `runAgentTurn()` from src/agentRunner.ts: editor context,
 * one transient retry, the continue loop, then the verify loop.
 *
 * agentRunner.ts imports `vscode` and cannot run here, so this is a
 * re-implementation of the same policy against the same env vars and flags. It
 * measures what the extension does, not the extension's own bytes.
 */
export async function runAgentTask({
  task,
  config,
  repo,
  node,
  cliJs,
  token,
  budget,
  capture,
  onStatus = () => {}
}) {
  const mode = task.mode ?? "write";
  const base = {
    cwd: repo,
    mode,
    node,
    cliJs,
    token,
    search: Boolean(task.search),
    thinkingEffort: config.thinkingEffort ?? "off",
    maxToolRounds: config.maxToolRounds ?? 0,
    grounding: config.grounding !== false,
    keepSession: config.sessionMemory !== false,
    timeoutMs: config.timeoutMs ?? 300_000
  };

  const requests = [];
  const record = async (phase, result) => {
    requests.push({ phase, ...result });
    await capture(phase, result);
  };

  const contextBlock = config.editorContext !== false ? buildEditorContext(task.editorContext, repo) : "";
  const firstPrompt = contextBlock ? `${contextBlock}\n\n---\n\n${task.prompt}` : task.prompt;

  budget.spend();
  onStatus("prompt");
  let result = await invokeCli({ ...base, prompt: firstPrompt });
  await record("main", result);

  if (isTransient(result)) {
    onStatus("transient — one retry");
    await sleep(config.retryDelayMs ?? 5000);
    budget.spend();
    result = await invokeCli({ ...base, prompt: firstPrompt, sessionId: result.sessionId });
    await record("retry", result);
  }

  let sessionId = result.sessionId;
  const answers = [result.stdout];
  const edited = new Set(result.editedPaths);
  let continues = 0;
  let verifyRounds = 0;
  let verifyFixed = false;
  let checkBefore = null;
  let checkAfter = null;

  const canContinue = config.autoContinue !== false && config.sessionMemory !== false;
  while (canContinue && result.ok && result.limitReached && continues < (config.maxContinues ?? 3)) {
    if (budget.remaining === 0) {
      break;
    }
    continues += 1;
    onStatus(`continue ${continues}`);
    budget.spend();
    const next = await invokeCli({ ...base, prompt: CONTINUE_PROMPT, sessionId });
    await record(`continue${continues}`, next);
    if (!next.ok) {
      break;
    }
    sessionId = next.sessionId || sessionId;
    answers.push(next.stdout);
    next.editedPaths.forEach((item) => edited.add(item));
    result = next;
  }

  // Verify loop. Production consults language-server diagnostics first and the
  // project check second; there is no language server here, so the project
  // check is the only signal — which is also the deterministic half.
  const touched = changedPaths(repo);
  const shouldVerify = config.verifyEdits !== false && mode !== "ask" && touched.length > 0;

  if (shouldVerify) {
    checkBefore = await runProjectCheck(repo, {
      command: task.checkCommand ?? "",
      timeoutMs: config.checkTimeoutMs ?? 90_000
    });
    let problem = checkBefore.ran && !checkBefore.ok ? checkBefore : null;

    while (problem && verifyRounds < (config.maxVerifyRounds ?? 2)) {
      if (budget.remaining === 0) {
        break;
      }
      verifyRounds += 1;
      onStatus(`verify ${verifyRounds}`);
      budget.spend();
      const fix = await invokeCli({
        ...base,
        prompt: buildVerifyPrompt(`\`${problem.label}\``, problem.output),
        sessionId
      });
      await record(`verify${verifyRounds}`, fix);
      if (!fix.ok) {
        break;
      }
      sessionId = fix.sessionId || sessionId;
      answers.push(fix.stdout);
      fix.editedPaths.forEach((item) => edited.add(item));
      result = fix;

      const recheck = await runProjectCheck(repo, {
        command: task.checkCommand ?? "",
        timeoutMs: config.checkTimeoutMs ?? 90_000
      });
      checkAfter = recheck;
      if (recheck.ok) {
        verifyFixed = true;
        break;
      }
      problem = recheck;
    }
  }

  const allEvents = requests.flatMap((request) => request.events);
  // Reported separately from a grader failure: an empty answer says nothing
  // about the configuration under test.
  const emptyResponse = isEmptyResponse(result);

  return {
    ok: result.ok && !emptyResponse,
    emptyResponse,
    answer: answers.filter(Boolean).join("\n\n"),
    sessionId,
    requests,
    events: allEvents,
    continues,
    verifyRounds,
    verifyFired: verifyRounds > 0,
    verifyFixed,
    checkBefore,
    checkAfter,
    limitReached: requests.some((request) => request.limitReached),
    editedEvents: [...edited],
    changedPaths: changedPaths(repo),
    stderr: requests.map((request) => request.stderr).filter(Boolean).join("\n"),
    timedOut: requests.some((request) => request.timedOut),
    durationMs: requests.reduce((sum, request) => sum + request.durationMs, 0)
  };
}
