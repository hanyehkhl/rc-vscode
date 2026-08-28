import fs from "node:fs";
import path from "node:path";
import { evalsRoot } from "./env.mjs";
import { knownGraders } from "./graders.mjs";

const MODES = new Set(["ask", "write", "auto"]);

/**
 * One file per task. Validation is strict and happens before any request is
 * made — a typo in a grader name should cost nothing, not a slot of quota.
 */
export function loadTasks({ dir = path.join(evalsRoot, "tasks"), filter = "", only = [] } = {}) {
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();

  const tasks = [];
  const problems = [];

  for (const file of files) {
    const full = path.join(dir, file);
    let task;
    try {
      task = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch (error) {
      problems.push(`${file}: not valid JSON (${error.message})`);
      continue;
    }

    const id = task.id ?? path.basename(file, ".json");
    const where = (message) => problems.push(`${file}: ${message}`);

    if (typeof task.prompt !== "string" || !task.prompt.trim()) {
      where("missing `prompt`");
    }
    if (!MODES.has(task.mode)) {
      where(`\`mode\` must be one of ${[...MODES].join(", ")}`);
    }
    if (!Array.isArray(task.graders) || task.graders.length === 0) {
      where("needs at least one grader");
    } else {
      for (const spec of task.graders) {
        if (!knownGraders().includes(spec.type)) {
          where(`unknown grader type "${spec.type}"`);
        }
      }
    }
    if (typeof task.fixture !== "string" || !task.fixture) {
      where("missing `fixture`");
    }

    tasks.push({ ...task, id, file });
  }

  if (problems.length > 0) {
    throw new Error(`Invalid task definitions:\n  ${problems.join("\n  ")}`);
  }

  let selected = tasks;
  if (only.length > 0) {
    selected = selected.filter((task) => only.includes(task.id));
  }
  if (filter) {
    const re = new RegExp(filter, "i");
    selected = selected.filter((task) => re.test(task.id) || re.test(task.title ?? ""));
  }
  return selected;
}

export function loadConfig(name) {
  const file = path.isAbsolute(name)
    ? name
    : path.join(evalsRoot, "configs", name.endsWith(".json") ? name : `${name}.json`);
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  return { name: config.name ?? path.basename(file, ".json"), ...config };
}

/**
 * Worst case requests for a task under a config: the first call, one transient
 * retry, every continuation, and every verify round. Used to warn before a run
 * rather than to cap it — the cap is `Budget`.
 */
export function worstCaseRequests(config) {
  const continues = config.autoContinue === false ? 0 : config.maxContinues ?? 3;
  const verifies = config.verifyEdits === false ? 0 : config.maxVerifyRounds ?? 2;
  return 1 + 1 + continues + verifies;
}
