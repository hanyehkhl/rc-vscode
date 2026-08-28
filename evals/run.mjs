#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { evalsRoot, gitAvailable, resolveCliJs, resolveNode, resolveToken } from "./lib/env.mjs";
import { grade } from "./lib/graders.mjs";
import { redactValue } from "./lib/redact.mjs";
import { renderComparison, renderSummary, summarize } from "./lib/report.mjs";
import { Budget, BudgetExhausted, runAgentTask } from "./lib/runner.mjs";
import { loadConfig, loadTasks, worstCaseRequests } from "./lib/tasks.mjs";
import {
  createSandbox,
  defaultWorkDir,
  ensureSeedRepo,
  removeDirSync
} from "./lib/workspace.mjs";

const USAGE = `
rc eval harness

  npm run eval -- [options]

Options
  --config <name>       Configuration from evals/configs (default: baseline)
  --tasks <regex>       Only tasks whose id or title matches
  --only <a,b,c>        Only these task ids
  --repeats <n>         Run each task n times (default: 1)
  --max-requests <n>    Hard cap on CLI invocations for the run (default: 60)
  --run-id <id>         Name the run; reuse the same id to resume it
  --resume              Skip tasks already recorded under this run id
  --workdir <path>      Where sandboxes are created (default: <tmp>/rc-evals)
  --keep                Do not delete sandboxes after grading
  --dry-run             Plan and validate only; make no requests
  --out <path>          Result JSON path (default: evals/results/<run-id>.json)
  --compare <a> <b>     Print a side-by-side of two result files and exit
  --list                Print the task table and exit
  --help
`;

function parseArgs(argv) {
  const args = {
    config: "baseline",
    tasks: "",
    only: [],
    repeats: 1,
    maxRequests: 60,
    runId: "",
    resume: false,
    workdir: defaultWorkDir(),
    keep: false,
    dryRun: false,
    out: "",
    compare: [],
    list: false,
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "--config": args.config = next(); break;
      case "--tasks": args.tasks = next(); break;
      case "--only": args.only = next().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--repeats": args.repeats = Math.max(1, Number.parseInt(next(), 10) || 1); break;
      case "--max-requests": args.maxRequests = Math.max(1, Number.parseInt(next(), 10) || 60); break;
      case "--run-id": args.runId = next(); break;
      case "--resume": args.resume = true; break;
      case "--workdir": args.workdir = path.resolve(next()); break;
      case "--keep": args.keep = true; break;
      case "--dry-run": args.dryRun = true; break;
      case "--out": args.out = path.resolve(next()); break;
      case "--compare": args.compare = [next(), next()]; break;
      case "--list": args.list = true; break;
      case "--help": case "-h": args.help = true; break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return args;
}

function metricsFor(outcome) {
  const toolCalls = {};
  let toolRounds = 0;
  for (const event of outcome.events) {
    if (event.name === "round") {
      toolRounds += 1;
    } else if (event.name === "tool_start") {
      const name = String(event.payload.name ?? "unknown");
      toolCalls[name] = (toolCalls[name] ?? 0) + 1;
    }
  }
  return {
    toolRounds,
    toolCalls,
    requests: outcome.requests.length,
    limitReached: outcome.limitReached,
    continues: outcome.continues,
    verifyFired: outcome.verifyFired,
    verifyRounds: outcome.verifyRounds,
    verifyFixed: outcome.verifyFixed,
    timedOut: outcome.timedOut,
    emptyResponse: outcome.emptyResponse,
    editedEvents: outcome.editedEvents,
    changedPaths: outcome.changedPaths,
    checkBefore: outcome.checkBefore ? { ok: outcome.checkBefore.ok, label: outcome.checkBefore.label } : null,
    checkAfter: outcome.checkAfter ? { ok: outcome.checkAfter.ok, label: outcome.checkAfter.label } : null,
    stderrErrors: outcome.stderr
      .split(/\r?\n/)
      .filter((line) => /error|failed|invalid|declined/i.test(line))
      .slice(0, 20)
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }

  if (args.compare.length === 2) {
    const [a, b] = args.compare.map((file) => JSON.parse(fs.readFileSync(path.resolve(file), "utf8")));
    console.log(renderComparison(a, b));
    return;
  }

  const config = loadConfig(args.config);
  const tasks = loadTasks({ filter: args.tasks, only: args.only });

  if (args.list) {
    for (const task of tasks) {
      console.log(`${task.id.padEnd(30)} ${task.mode.padEnd(6)} ${task.title ?? ""}`);
    }
    console.log(`\n${tasks.length} task(s)`);
    return;
  }

  if (tasks.length === 0) {
    console.error("No tasks selected.");
    process.exitCode = 1;
    return;
  }

  const runId = args.runId || `${config.name}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const resultsDir = path.join(evalsRoot, "results", runId);
  const outFile = args.out || path.join(evalsRoot, "results", `${runId}.json`);
  const ledgerFile = path.join(resultsDir, "ledger.jsonl");

  const planned = tasks.length * args.repeats;
  const worstCase = planned * worstCaseRequests(config);

  console.log(`config        ${config.name}`);
  console.log(`tasks         ${tasks.length} × ${args.repeats} repeat(s) = ${planned} attempt(s)`);
  console.log(`worst case    ${worstCase} request(s); budget is ${args.maxRequests}`);
  if (worstCase > args.maxRequests) {
    console.log(`              budget will stop the run early if every task hits its ceiling`);
  }

  if (args.dryRun) {
    console.log("\nDRY RUN — no requests will be made.\n");
    for (const task of tasks) {
      const graders = task.graders.map((spec) => spec.type).join(", ");
      console.log(`  ${task.id.padEnd(30)} mode=${task.mode.padEnd(5)} fixture=${task.fixture}`);
      console.log(`  ${"".padEnd(30)} graders: ${graders}`);
    }
    console.log(`\nnode          ${resolveNode()}`);
    console.log(`cli           ${resolveCliJs(config.cliPath) || "NOT FOUND"}`);
    console.log(`git           ${gitAvailable() ? "available" : "MISSING"}`);
    console.log(`token         ${resolveToken() ? "found" : "NOT FOUND"}`);
    console.log(`workdir       ${args.workdir}`);
    console.log(`would write   ${outFile}\n`);
    return;
  }

  const token = resolveToken();
  if (!token) {
    console.error("No DeepSeek token. Set DEEPSEEK_TOKEN or run `rc` once to save one.");
    process.exitCode = 1;
    return;
  }
  const cliJs = resolveCliJs(config.cliPath);
  if (!cliJs) {
    console.error("Could not find the overlaid rp-cli. Run `npm run prepare-cli` first.");
    process.exitCode = 1;
    return;
  }
  if (!gitAvailable()) {
    console.error("git is required for task isolation.");
    process.exitCode = 1;
    return;
  }
  const node = resolveNode();

  fs.mkdirSync(resultsDir, { recursive: true });

  // Resume: the ledger is append-only, one JSON object per finished attempt.
  const done = new Map();
  if (args.resume && fs.existsSync(ledgerFile)) {
    for (const line of fs.readFileSync(ledgerFile, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        done.set(entry.key, entry);
      } catch {
        // A crash mid-write can truncate the last line; ignore it.
      }
    }
    console.log(`resume        ${done.size} attempt(s) already recorded`);
  }

  const budget = new Budget(args.maxRequests);
  const attempts = [...done.values()];
  const leaked = [];
  let stoppedEarly = "";

  const startedAt = Date.now();

  outer: for (let repeat = 1; repeat <= args.repeats; repeat++) {
    for (const task of tasks) {
      const key = `${task.id}#${repeat}`;
      if (done.has(key)) {
        continue;
      }

      const seed = ensureSeedRepo(task.fixture, args.workdir);
      const sandbox = createSandbox(seed, args.workdir, key.replace(/[^\w.-]/g, "_"));
      const rawDir = path.join(resultsDir, "raw", key.replace(/[^\w.-]/g, "_"));
      fs.mkdirSync(rawDir, { recursive: true });

      const started = Date.now();
      process.stdout.write(`\n▶ ${key.padEnd(32)} `);

      let attempt;
      try {
        const outcome = await runAgentTask({
          task,
          config,
          repo: sandbox.repo,
          node,
          cliJs,
          token,
          budget,
          onStatus: (text) => process.stdout.write(`${text} `),
          capture: async (phase, result) => {
            // Every raw request and response, so a suite can be re-scored
            // offline without spending quota again.
            fs.writeFileSync(
              path.join(rawDir, `${phase}.json`),
              JSON.stringify(redactValue(result), null, 2),
              "utf8"
            );
          }
        });

        const graded = await grade(task, {
          repo: sandbox.repo,
          task,
          events: outcome.events,
          answer: outcome.answer,
          changedPaths: outcome.changedPaths,
          ok: outcome.ok,
          checkTimeoutMs: config.checkTimeoutMs ?? 90_000
        });

        attempt = {
          key,
          taskId: task.id,
          repeat,
          title: task.title ?? "",
          mode: task.mode,
          pass: graded.pass,
          graders: graded.results,
          durationMs: Date.now() - started,
          metrics: metricsFor(outcome),
          answerChars: outcome.answer.length,
          error: outcome.emptyResponse
            ? "backend returned an empty response (\"Ai Error!\") after a retry"
            : ""
        };
      } catch (error) {
        if (error instanceof BudgetExhausted) {
          stoppedEarly = error.message;
          if (!args.keep && !removeDirSync(sandbox.dir)) {
            leaked.push(sandbox.dir);
          }
          process.stdout.write("budget exhausted\n");
          break outer;
        }
        attempt = {
          key,
          taskId: task.id,
          repeat,
          title: task.title ?? "",
          mode: task.mode,
          pass: false,
          graders: [],
          durationMs: Date.now() - started,
          metrics: {
            toolRounds: 0,
            toolCalls: {},
            requests: 0,
            limitReached: false,
            continues: 0,
            verifyFired: false,
            verifyRounds: 0,
            verifyFixed: false,
            timedOut: false,
            editedEvents: [],
            changedPaths: [],
            checkBefore: null,
            checkAfter: null,
            stderrErrors: []
          },
          answerChars: 0,
          error: error instanceof Error ? error.message : String(error)
        };
      }

      attempts.push(attempt);
      fs.appendFileSync(ledgerFile, `${JSON.stringify(redactValue(attempt))}\n`, "utf8");
      process.stdout.write(`${attempt.pass ? "PASS" : "FAIL"} (${(attempt.durationMs / 1000).toFixed(1)}s)\n`);

      if (!args.keep && !removeDirSync(sandbox.dir)) {
        leaked.push(sandbox.dir);
      }

      // Serial, with a pause between tasks. The backend solves a
      // proof-of-work challenge per request; hammering it is how a run gets
      // throttled into uselessness.
      if (config.taskDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, config.taskDelayMs));
      }
    }
  }

  const run = {
    runId,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    wallClockMs: Date.now() - startedAt,
    config: redactValue(config),
    requestBudget: budget.limit,
    requestsUsed: budget.used,
    stoppedEarly,
    repeats: args.repeats,
    taskCount: tasks.length,
    attempts,
    summary: summarize(attempts),
    leakedWorkspaces: leaked,
    rawCaptureDir: path.relative(evalsRoot, resultsDir).replace(/\\/g, "/")
  };

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(run, null, 2)}\n`, "utf8");

  console.log(renderSummary(run));
  if (stoppedEarly) {
    console.log(`STOPPED EARLY: ${stoppedEarly}`);
    console.log(`Resume with: npm run eval -- --config ${args.config} --run-id ${runId} --resume\n`);
  }
  console.log(`result  ${outFile}`);
  console.log(`raw     ${resultsDir}\n`);
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
