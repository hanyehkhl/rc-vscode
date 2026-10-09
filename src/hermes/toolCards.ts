/**
 * Turns Hermes tool calls and results into compact chat cards:
 *
 *   ▷ terminal  pytest -q test_new.py                ✓ 7 passed
 *   ✎ write_file  src/utils.ts                         🔧 repaired
 *
 * Hermes tools return JSON (shapes taken from real runs), e.g.
 *   terminal     {"output": "...", "exit_code": 0, "error": null}
 *   write_file   {"bytes_written": 31, ...} | {"error": "Write denied: ..."}
 *   read_file    {"content": "...", "total_lines": 2, ...}
 *   search_files {"total_count": 2, "files": [...]}
 *   patch        {"success": true, "diff": "--- a/...\n+++ b/...\n..."}
 * Anything unrecognised falls back to a plain ✓, so new tools still render.
 */

export type ToolCardState = "running" | "ok" | "fail";

export type ToolCard = {
  id: string;
  icon: string;
  name: string;
  detail: string;
  state: ToolCardState;
  status: string;
  repaired: boolean;
};

const ICONS: Array<[RegExp, string]> = [
  [/^(terminal|shell|run_command|execute|bash|process)/, "▷"],
  [/^(write_file|create_file|edit_file|patch|apply_patch|replace)/, "✎"],
  [/^(read_file|view|open_file|cat)/, "📖"],
  [/^(search|grep|find|list_files|list_dir|glob)/, "⌕"],
  [/^(web|browser|fetch|http|navigate)/, "🌐"],
  [/^(memory|remember|recall)/, "◈"],
  [/^(skill|delegate|agent|spawn)/, "✦"],
  [/^(cron|schedule)/, "◷"]
];

export function toolIcon(name: string): string {
  const n = name.toLowerCase();
  for (const [pattern, icon] of ICONS) if (pattern.test(n)) return icon;
  return "⚙";
}

function shorten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Long absolute paths read better as their last two segments. */
function shortPath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join("/") : p;
}

/** The one argument that best describes the call. */
export function toolDetail(name: string, args: Record<string, unknown>): string {
  const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : "");
  const n = name.toLowerCase();
  if (/terminal|shell|command|execute|bash|process/.test(n) && str("command")) return shorten(str("command"), 64);
  for (const key of ["path", "file_path", "file", "filename", "target_file"]) {
    if (str(key)) return shortPath(str(key));
  }
  for (const key of ["pattern", "query", "url", "command", "name", "goal", "task"]) {
    if (str(key)) return shorten(str(key), 64);
  }
  const first = Object.values(args).find((v) => typeof v === "string") as string | undefined;
  return first ? shorten(first, 48) : "";
}

export function callCard(id: string, name: string, args: Record<string, unknown>, repaired: boolean): ToolCard {
  return { id, icon: toolIcon(name), name, detail: toolDetail(name, args), state: "running", status: "…", repaired };
}

function parseJson(content: string): Record<string, unknown> | undefined {
  const text = content.trim();
  if (!text.startsWith("{")) return undefined;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Test-runner summaries: pytest, jest/vitest, mocha, go test, cargo test. */
export function testSummary(output: string): { ok: boolean; text: string } | undefined {
  const num = (re: RegExp) => {
    const m = output.match(re);
    return m ? Number(m[1]) : 0;
  };
  const passed = num(/(\d+) (?:passed|passing)\b/) || num(/Tests:.*?(\d+) passed/);
  const failed = num(/(\d+) (?:failed|failing)\b/) || num(/(\d+) errors?\b(?= in )/);
  const cargo = output.match(/test result: (ok|FAILED)\. (\d+) passed; (\d+) failed/);
  if (cargo) {
    const [, verdict, p, f] = cargo;
    return verdict === "ok" ? { ok: true, text: `${p} passed` } : { ok: false, text: `${f} failed, ${p} passed` };
  }
  if (!passed && !failed) return undefined;
  if (failed) return { ok: false, text: passed ? `${failed} failed, ${passed} passed` : `${failed} failed` };
  return { ok: true, text: `${passed} passed` };
}

function diffStat(diff: string): string {
  let plus = 0;
  let minus = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) plus++;
    else if (line.startsWith("-") && !line.startsWith("---")) minus++;
  }
  return plus || minus ? `+${plus} −${minus}` : "";
}

/** Decides ✓/✗ and a short label from a tool's raw result. */
export function resultStatus(name: string, content: string): { state: "ok" | "fail"; status: string } {
  const ok = (text = "") => ({ state: "ok" as const, status: text ? `✓ ${text}` : "✓" });
  const fail = (text = "") => ({ state: "fail" as const, status: text ? `✗ ${text}` : "✗" });
  const json = parseJson(content);

  if (!json) {
    const tests = testSummary(content);
    if (tests) return tests.ok ? ok(tests.text) : fail(tests.text);
    return /^\s*(error|traceback|exception|fatal)\b/i.test(content) ? fail(shorten(content, 32)) : ok();
  }

  const output = typeof json.output === "string" ? json.output : "";
  const tests = output ? testSummary(output) : undefined;
  if (typeof json.error === "string" && json.error.trim()) {
    return fail(shorten(json.error.split(/[:.(]/)[0], 32));
  }
  if (json.success === false) return fail();
  const exit = typeof json.exit_code === "number" ? json.exit_code : typeof json.returncode === "number" ? json.returncode : undefined;
  if (tests) return tests.ok && !exit ? ok(tests.text) : fail(tests.text);
  if (exit !== undefined && exit !== 0) return fail(`exit ${exit}`);
  if (typeof json.diff === "string") return ok(diffStat(json.diff));
  if (typeof json.total_lines === "number") return ok(`${json.total_lines} lines`);
  if (typeof json.total_count === "number") return ok(`${json.total_count} found`);
  if (Array.isArray(json.files)) return ok(`${json.files.length} found`);
  if (Array.isArray(json.matches)) return ok(`${json.matches.length} found`);
  return ok();
}

export function applyResult(card: ToolCard, content: string): ToolCard {
  const { state, status } = resultStatus(card.name, content);
  return { ...card, state, status };
}
