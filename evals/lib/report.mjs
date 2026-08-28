/** Aggregation and human-readable output. No I/O beyond returning strings. */

function percentile(values, p) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function summarize(attempts) {
  const durations = attempts.map((attempt) => attempt.durationMs);
  const rounds = attempts.map((attempt) => attempt.metrics.toolRounds);
  const passed = attempts.filter((attempt) => attempt.pass).length;

  const toolCalls = {};
  for (const attempt of attempts) {
    for (const [name, count] of Object.entries(attempt.metrics.toolCalls)) {
      toolCalls[name] = (toolCalls[name] ?? 0) + count;
    }
  }

  return {
    attempts: attempts.length,
    passed,
    failed: attempts.length - passed,
    passRate: attempts.length ? passed / attempts.length : 0,
    medianDurationMs: percentile(durations, 50),
    p90DurationMs: percentile(durations, 90),
    meanToolRounds: rounds.length ? rounds.reduce((a, b) => a + b, 0) / rounds.length : 0,
    roundCapHits: attempts.filter((attempt) => attempt.metrics.limitReached).length,
    verifyFired: attempts.filter((attempt) => attempt.metrics.verifyFired).length,
    verifyFixed: attempts.filter((attempt) => attempt.metrics.verifyFixed).length,
    timeouts: attempts.filter((attempt) => attempt.metrics.timedOut).length,
    errored: attempts.filter((attempt) => attempt.error).length,
    toolCalls
  };
}

/**
 * Per-task pass counts, so repeats are visible as "2/3" rather than averaged
 * into a number that hides which run disagreed.
 */
export function perTask(attempts) {
  const byId = new Map();
  for (const attempt of attempts) {
    const entry = byId.get(attempt.taskId) ?? { taskId: attempt.taskId, runs: 0, passes: 0, details: [] };
    entry.runs += 1;
    entry.passes += attempt.pass ? 1 : 0;
    entry.details.push(attempt);
    byId.set(attempt.taskId, entry);
  }
  return [...byId.values()].sort((a, b) => a.taskId.localeCompare(b.taskId));
}

export function renderSummary(run) {
  const s = run.summary;
  const lines = [];
  lines.push("");
  lines.push(`run        ${run.runId}`);
  lines.push(`config     ${run.config.name}`);
  lines.push(`requests   ${run.requestsUsed}/${run.requestBudget}`);
  lines.push(
    `pass       ${s.passed}/${s.attempts} (${(s.passRate * 100).toFixed(0)}%)` +
      (s.errored ? `  errored=${s.errored}` : "")
  );
  lines.push(`duration   median ${seconds(s.medianDurationMs)}   p90 ${seconds(s.p90DurationMs)}`);
  lines.push(
    `tool loop  mean rounds ${s.meanToolRounds.toFixed(1)}   round-cap hits ${s.roundCapHits}` +
      `   verify ${s.verifyFired} fired / ${s.verifyFixed} fixed`
  );
  lines.push("");

  for (const entry of perTask(run.attempts)) {
    const mark = entry.passes === entry.runs ? "PASS" : entry.passes === 0 ? "FAIL" : "FLAKY";
    const count = entry.runs > 1 ? ` ${entry.passes}/${entry.runs}` : "";
    const first = entry.details[0];
    lines.push(
      `  ${mark.padEnd(5)}${count.padEnd(5)} ${entry.taskId.padEnd(28)} ` +
        `${seconds(first.durationMs).padStart(7)}  rounds=${first.metrics.toolRounds}`
    );
    for (const attempt of entry.details) {
      if (attempt.error) {
        lines.push(`         ! ${attempt.error}`);
      }
      for (const result of attempt.graders ?? []) {
        if (!result.ok) {
          lines.push(`         × ${result.type}: ${result.detail.split("\n")[0]}`);
        }
      }
    }
  }

  lines.push("");
  const tools = Object.entries(s.toolCalls).sort((a, b) => b[1] - a[1]);
  if (tools.length > 0) {
    lines.push(`tool calls ${tools.map(([name, count]) => `${name}=${count}`).join("  ")}`);
  }
  if (run.leakedWorkspaces?.length) {
    lines.push(`leaked     ${run.leakedWorkspaces.length} sandbox(es) not removed:`);
    for (const dir of run.leakedWorkspaces) {
      lines.push(`           ${dir}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Two runs side by side. Aggregates move for boring reasons; transitions are
 * where the information is, so they are printed first and in full.
 */
export function renderComparison(a, b) {
  const left = perTask(a.attempts);
  const right = new Map(perTask(b.attempts).map((entry) => [entry.taskId, entry]));
  const lines = [];

  lines.push("");
  lines.push(`A  ${a.config.name.padEnd(24)} ${a.runId}`);
  lines.push(`B  ${b.config.name.padEnd(24)} ${b.runId}`);
  lines.push("");

  const rate = (entry) => (entry.attempts ? (entry.passRate * 100).toFixed(0) : "0");
  lines.push(
    `pass rate   A ${rate(a.summary)}%  →  B ${rate(b.summary)}%   ` +
      `(${a.summary.passed}/${a.summary.attempts} → ${b.summary.passed}/${b.summary.attempts})`
  );
  lines.push(
    `median      A ${seconds(a.summary.medianDurationMs)}  →  B ${seconds(b.summary.medianDurationMs)}`
  );
  lines.push(
    `mean rounds A ${a.summary.meanToolRounds.toFixed(1)}  →  B ${b.summary.meanToolRounds.toFixed(1)}`
  );
  lines.push("");

  const regressions = [];
  const fixes = [];
  const unchanged = [];
  const missing = [];

  for (const entry of left) {
    const other = right.get(entry.taskId);
    if (!other) {
      missing.push(entry.taskId);
      continue;
    }
    const before = entry.passes / entry.runs;
    const after = other.passes / other.runs;
    const label = `${entry.taskId.padEnd(28)} ${entry.passes}/${entry.runs} → ${other.passes}/${other.runs}`;
    if (after < before) {
      regressions.push(label);
    } else if (after > before) {
      fixes.push(label);
    } else {
      unchanged.push(label);
    }
  }

  lines.push(`REGRESSED (${regressions.length})`);
  for (const line of regressions) {
    lines.push(`  pass→fail  ${line}`);
  }
  lines.push(`FIXED (${fixes.length})`);
  for (const line of fixes) {
    lines.push(`  fail→pass  ${line}`);
  }
  lines.push(`UNCHANGED (${unchanged.length})`);
  if (missing.length > 0) {
    lines.push(`NOT IN B (${missing.length}): ${missing.join(", ")}`);
  }

  lines.push("");
  lines.push(
    "Single runs against this backend are noisy. Treat a one-task transition as a" +
      "\nlead to re-run with --repeats, not as a result."
  );
  lines.push("");
  return lines.join("\n");
}
