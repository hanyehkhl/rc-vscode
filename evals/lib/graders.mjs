import fs from "node:fs";
import path from "node:path";
import { runProjectCheck } from "./projectCheck.mjs";

/**
 * Graders are deterministic and never call a model.
 *
 * An LLM judge would run through the same quota-limited web-chat backend as the
 * agent, roughly doubling the cost of a suite, and it would add a second
 * non-deterministic term to a measurement whose whole purpose is to separate
 * signal from noise. Regexes are blunter and honest about being blunt.
 */

function readFileSafe(repo, relative) {
  try {
    return fs.readFileSync(path.join(repo, relative), "utf8");
  } catch {
    return null;
  }
}

/** Files the agent must not be judged on: nothing here, kept for clarity. */
function normalize(list) {
  return [...new Set(list)].sort();
}

const GRADERS = {
  /** The project's own type-checker exits 0 in the sandbox. */
  async compiles(spec, ctx) {
    const check = await runProjectCheck(ctx.repo, {
      command: spec.command ?? ctx.task.checkCommand ?? "",
      timeoutMs: ctx.checkTimeoutMs
    });
    if (!check.ran) {
      return { ok: false, detail: "no project check could be detected in the sandbox" };
    }
    return {
      ok: check.ok,
      detail: check.ok ? `${check.label} exited 0` : `${check.label} failed:\n${check.output}`
    };
  },

  /** A named file contains a literal substring. */
  file_contains(spec, ctx) {
    const text = readFileSafe(ctx.repo, spec.file);
    if (text === null) {
      return { ok: false, detail: `${spec.file} does not exist` };
    }
    const haystack = spec.caseSensitive === false ? text.toLowerCase() : text;
    const needle = spec.caseSensitive === false ? spec.text.toLowerCase() : spec.text;
    const found = haystack.includes(needle);
    const want = spec.absent !== true;
    return {
      ok: found === want,
      detail: `${spec.file} ${found ? "contains" : "does not contain"} ${JSON.stringify(spec.text)}`
    };
  },

  /** A named file matches a regex. */
  file_matches(spec, ctx) {
    const text = readFileSafe(ctx.repo, spec.file);
    if (text === null) {
      return { ok: false, detail: `${spec.file} does not exist` };
    }
    const re = new RegExp(spec.pattern, spec.flags ?? "m");
    const found = re.test(text);
    const want = spec.absent !== true;
    return {
      ok: found === want,
      detail: `${spec.file} ${found ? "matches" : "does not match"} /${spec.pattern}/`
    };
  },

  /**
   * A tool appears in the RC_EVENT stream. This is the grounding test: it asks
   * whether the agent actually opened the file before it answered, which prose
   * alone cannot distinguish from a confident guess.
   */
  tool_used(spec, ctx) {
    const calls = ctx.events.filter(
      (event) => event.name === "tool_start" && event.payload.name === spec.tool
    );
    const matching = spec.pathContains
      ? calls.filter((event) => String(event.payload.path ?? "").includes(spec.pathContains))
      : calls;
    const want = spec.absent !== true;
    const min = spec.minCount ?? 1;
    const found = matching.length >= min;
    const where = spec.pathContains ? ` on a path containing "${spec.pathContains}"` : "";
    return {
      ok: found === want,
      detail: `${spec.tool}${where} called ${matching.length}× (needed ${want ? `≥${min}` : "0"})`
    };
  },

  /**
   * Nothing in the working tree changed. Read from `git status` rather than the
   * `edited` events, so a file written by `run_command` still counts.
   */
  no_edit(spec, ctx) {
    const changed = normalize(ctx.changedPaths);
    return {
      ok: changed.length === 0,
      detail: changed.length === 0 ? "working tree clean" : `changed: ${changed.join(", ")}`
    };
  },

  /** Exactly this set of paths changed (order-insensitive). */
  edited_files(spec, ctx) {
    const changed = normalize(ctx.changedPaths);
    const expected = normalize(spec.files);
    const missing = expected.filter((file) => !changed.includes(file));
    const extra = spec.exact === false ? [] : changed.filter((file) => !expected.includes(file));
    return {
      ok: missing.length === 0 && extra.length === 0,
      detail: `changed=[${changed.join(", ")}] missing=[${missing.join(", ")}] unexpected=[${extra.join(", ")}]`
    };
  },

  /** Deterministic regex over the final answer text. */
  answer_matches(spec, ctx) {
    const re = new RegExp(spec.pattern, spec.flags ?? "i");
    const found = re.test(ctx.answer);
    const want = spec.absent !== true;
    return {
      ok: found === want,
      detail: `answer ${found ? "matches" : "does not match"} /${spec.pattern}/`
    };
  },

  /** The run finished without the CLI erroring out. */
  succeeded(spec, ctx) {
    return { ok: ctx.ok, detail: ctx.ok ? "cli exited 0" : "cli run failed" };
  }
};

export function knownGraders() {
  return Object.keys(GRADERS);
}

export async function grade(task, ctx) {
  const results = [];
  for (const spec of task.graders) {
    const grader = GRADERS[spec.type];
    if (!grader) {
      results.push({ type: spec.type, ok: false, detail: `unknown grader type: ${spec.type}` });
      continue;
    }
    try {
      const outcome = await grader(spec, ctx);
      results.push({ type: spec.type, ok: Boolean(outcome.ok), detail: outcome.detail, spec });
    } catch (error) {
      results.push({
        type: spec.type,
        ok: false,
        detail: `grader threw: ${error instanceof Error ? error.message : String(error)}`,
        spec
      });
    }
  }
  return { pass: results.every((result) => result.ok), results };
}
