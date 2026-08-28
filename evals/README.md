# rc-vscode eval harness

Measures whether a change to the agent's prompts or settings actually helped,
instead of shipping on judgement.

```bash
npm run eval
```

That runs all 21 tasks under `configs/baseline.json`, with a hard cap of 60 CLI
invocations. Nothing about it is parallel and nothing about it is fast — see
[Cost](#cost).

## Commands

```bash
npm run eval:list                  # the task table, no requests
npm run eval:dry                   # validate tasks, resolve node/cli/git/token, plan the run
npm run eval                       # baseline config, whole suite
npm run eval -- --config no-grounding --max-requests 60
npm run eval -- --only edit-add-clear-method,read-priority-weight --max-requests 8
npm run eval -- --tasks '^verify-' --repeats 3 --max-requests 40
npm run eval -- --run-id nightly --resume            # continue a stopped run
npm run eval -- --compare evals/results/a.json evals/results/b.json
npm run eval:clean                 # remove leftover sandboxes
```

`--help` lists every option.

## What a task looks like

One JSON file per task in `tasks/`. Regenerate the seed set with
`node evals/lib/_seed-tasks.mjs` after changing the fixture.

```json
{
  "id": "edit-add-clear-method",
  "fixture": "ts-app",
  "mode": "write",
  "editorContext": { "file": "src/store.ts", "languageId": "typescript" },
  "prompt": "Add a `clear()` method to the TaskStore class in src/store.ts…",
  "graders": [
    { "type": "tool_used", "tool": "read_file", "pathContains": "store.ts" },
    { "type": "file_matches", "file": "src/store.ts", "pattern": "clear\\s*\\(\\s*\\)" },
    { "type": "compiles" },
    { "type": "edited_files", "files": ["src/store.ts"] }
  ]
}
```

### Graders

All deterministic, none call a model. An LLM judge would run through the same
quota-limited backend as the agent — roughly doubling the cost of a suite — and
would add a second non-deterministic term to a measurement whose entire purpose
is separating signal from noise.

| type | passes when |
| --- | --- |
| `compiles` | the sandbox's detected project check exits 0 |
| `file_contains` | `file` contains literal `text` (`absent: true` inverts) |
| `file_matches` | `file` matches `pattern` (`absent: true` inverts) |
| `tool_used` | `tool` appears in the `RC_EVENT` stream ≥ `minCount` times, optionally with `pathContains` |
| `no_edit` | `git status --porcelain` is empty in the sandbox |
| `edited_files` | exactly `files` changed (`exact: false` allows extras) |
| `answer_matches` | the final stdout answer matches `pattern` |
| `succeeded` | the CLI exited 0 with a non-empty answer |

`tool_used` is the grounding test: it distinguishes "read the file, then
answered" from "produced a confident sentence." `no_edit` is the Chat-mode test.

## Isolation

Tasks mutate a real repository, and the agent can create untracked files and run
arbitrary shell commands, so `git stash` and `git checkout .` cannot be trusted
to undo one. **Each task gets a throwaway git clone, and it is deleted after
grading.**

```
evals/fixtures/ts-app/       plain files, no .git — nothing nested in this repo
     │  copied → git init → one commit, once per run
     ▼
<tmp>/rc-evals/seed/ts-app/  a real git repo; never handed to an agent
     │  git clone --local --no-hardlinks, once per task attempt
     ▼
<tmp>/rc-evals/tasks/<key>/repo/   the agent's cwd; deleted after grading
```

`--no-hardlinks` is deliberate: with hardlinks the clone shares object files
with the seed, so an agent running `git gc` could corrupt the seed for every
later task. The user's working tree is never a task's cwd.

Grading reads changed files from `git status --porcelain --untracked-files=all`
in the pristine clone, not from the `edited` events — so a file written by
`run_command` still counts as an edit.

**If a task leaves a process running:** the harness kills the process tree of
the CLI it spawned on timeout (`taskkill /T /F` on Windows, process-group
`SIGKILL` elsewhere). A grandchild that escapes that — something the agent
daemonised through `run_command` — is *not* killed, and on Windows it can hold a
lock on the sandbox directory. Removal is therefore retried, and a sandbox that
still cannot be deleted is left on disk and named under `leakedWorkspaces` in
the result file rather than failing the run. `npm run eval:clean` removes
whatever is left.

## Configurations

Configuration is injected only through the documented env vars and CLI flags.
The agent code is never forked per configuration.

| file | differs from baseline |
| --- | --- |
| `baseline.json` | — (the extension's shipped defaults) |
| `no-grounding.json` | `RC_GROUNDING=0` |
| `no-editor-context.json` | the editor-context block is not prepended |
| `no-verify.json` | verify loop off |
| `effort-hard.json` | `--thinking-effort hard` |
| `rounds-6.json` | `RC_MAX_TOOL_ROUNDS=6` |

Compare two runs:

```bash
npm run eval -- --config baseline     --run-id base --max-requests 60
npm run eval -- --config no-grounding --run-id nogr --max-requests 60
npm run eval -- --compare evals/results/base.json evals/results/nogr.json
```

The comparison prints per-task `pass→fail` and `fail→pass` transitions first,
because an aggregate that moved 2% tells you nothing about which task broke.

## Non-determinism

The backend is a web chat with no temperature control, so **a single-run delta
is noise, not a result.** The harness does not pretend otherwise:

- Every attempt is graded individually and reported per task, never averaged
  into one number.
- `--repeats N` runs each task N times; the summary shows `2/3`, not `67%`, so a
  disagreement between repeats is visible rather than smoothed away.
- The comparison output ends with an explicit reminder that a one-task
  transition is a lead to re-run, not a finding.

With 21 tasks and one repeat, a change has to move several tasks in the same
direction before it is worth believing. Two or three tasks flipping in opposite
directions is what an unchanged agent looks like.

## Resumability and quota safety

- **Budget.** `--max-requests` (default 60) is a hard cap. Every CLI spawn goes
  through it and there is no path to the network that does not. When it is
  exhausted the run stops, writes its result file, and prints the resume
  command.
- **Ledger.** Each finished attempt is appended to
  `results/<run-id>/ledger.jsonl` immediately. Re-running with the same
  `--run-id --resume` skips what is recorded and spends nothing on it.
- **Raw capture.** Every request and response is written to
  `results/<run-id>/raw/<task>/<phase>.json` — argv, env, prompt, stdout,
  stderr, and the parsed events. A suite can be re-scored offline from these
  without spending quota again.
- **Redaction.** The token is registered as a secret at startup and every
  captured string and environment is passed through `redact()` before it
  reaches disk. Keys matching `token|secret|password|api_key|cookie|auth` are
  dropped wholesale.
- **Serial with backoff.** One task at a time, `taskDelayMs` between tasks, one
  retry with `retryDelayMs` on a transient/rate-limit error.
- **Empty responses are not scored.** `plainPrompt.js` prints the literal
  `"Ai Error!"` when the backend returns no content, and still exits 0. Left
  alone that would score as a normal failing answer and attribute backend
  flakiness to whatever prompt change was under test. The harness detects it,
  retries once, and records it as `error` rather than a grader failure.

## First findings

From the runs used to validate the harness. Both are leads, not conclusions —
n is 1 or 3.

- **The verify loop demonstrably works.** On `verify-first-task-optional` the
  agent wrote `first(): Task` returning `this.tasks[0]`, which is
  `Task | undefined` under `noUncheckedIndexedAccess`. `npm run typecheck`
  failed, the verify round fed the error back, and the agent fixed it:
  `checkBefore.ok=false → checkAfter.ok=true`. Without the loop that task ships
  broken.
- **Grounding off produced zero executed tool calls** on all three grounding
  tasks (`rounds=0`), versus 2–4 rounds with it on. The model still *said* it
  would search — one response contained `**Calling:** search_files` in markdown
  — but `parseToolCalls` did not accept that shape. So the observed effect is a
  tool-call *format* failure, not simply "answered without reading". Whether
  the grounding block is stabilising the call syntax or something else changed
  needs `--repeats 3` before anyone acts on it.

## Cost

Measured, not guessed: across 13 real attempts (16 requests) against this
fixture, **1.23 requests per task** and **7.9 s median per request** (3.8–12.8 s).
Median task 10.3 s; the slowest, a task that triggered a verify round, 23.9 s.

| | requests | wall clock |
| --- | --- | --- |
| 21 tasks, measured rate + 4 s inter-task delay | ~26 | **6–9 min** |
| 21 tasks, worst case (every ceiling hit) | 126 | ~30 min |
| default budget of 60 | 60 | ~13 min |

A baseline-vs-variant comparison is two runs: budget **~55 requests and 15–20
minutes** for one answer to "did this help". With `--repeats 3` — which is what
a result you intend to act on actually needs — call it 160 requests and an hour,
so raise `--max-requests` deliberately when you do that.

These numbers are from a small fixture with short files. A larger fixture would
raise per-request time and, more importantly, the tool-round count.

## What this harness cannot measure

Stated plainly, because these are the things a green result will not protect
you from:

1. **It does not run the extension.** `runAgentTurn()` and `runProjectCheck()`
   import `vscode` and cannot execute outside an extension host, so
   `lib/runner.mjs` and `lib/projectCheck.mjs` are *re-implementations of the
   same policy* against the same env vars and flags. They measure the agent
   loop's design, not the extension's own bytes. If `agentRunner.ts` and
   `lib/runner.mjs` drift apart, the suite goes on passing.
2. **Editor context is reconstructed, not real.** There is no editor, so no
   language-server diagnostics, no open-tab list, no cursor, no live git block.
   The `editorContext` config toggles a *facsimile*. The `no-editor-context`
   comparison prices the facsimile, and the real feature only approximately.
3. **The verify loop is measured with one of its two signals.** Production tries
   language-server diagnostics first and the project check second; only the
   project check exists here. A regression that diagnostics would have caught
   and `tsc` would not is invisible.
4. **Answer quality beyond a regex.** `answer_matches` can tell "said 120" from
   "said 100". It cannot tell a clear explanation from a rambling one, catch a
   correct-but-useless answer, or notice a plausible hallucination phrased in
   words the pattern happens to allow. The `unknown-*` tasks are the weakest in
   the suite for exactly this reason: they check for hedging vocabulary and the
   absence of specific invented terms, which a sufficiently creative wrong
   answer will slip past.
5. **Compiling is not being correct.** `compiles` proves the types line up. No
   task asserts runtime behaviour, because the fixture has no test suite.
6. **One fixture, one language.** Everything here is a small strict-TypeScript
   project. Nothing measures the agent on Python, Rust, Go, a large repo, or a
   codebase with an unusual layout.
7. **Absolute numbers are not portable.** Pass rates depend on the fixture and
   the prompts as much as on the agent. Only the delta between two runs of *this
   suite* means anything, and only when it is larger than the noise.
8. **Not covered at all:** streaming behaviour and the delta event stream,
   webview and UI, the Velocity daemon (deliberately disabled — it would add a
   second source of variance), session-memory quality across many turns, cost or
   token usage (the backend reports neither), and `--search`.
