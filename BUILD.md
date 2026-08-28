# RC — Building & Features

Everything needed to build the extension from source on Windows or Linux, plus
what each feature in the chat panel actually does.

---

## 1. Prerequisites

| Tool | Version | Needed for |
|---|---|---|
| Node.js | 18+ | building the extension (the VSIX ships its own Node for runtime) |
| npm | 9+ | dependencies |
| Git | any | cloning |
| Python | 3.11+ | **optional** — only for Velocity, and only when `uv` is absent |
| uv | any | **optional** — preferred for Velocity setup; provisions Python by itself |

The published VSIX bundles both Node.js and the `rc` CLI, so **end users do not
need Node installed**. These prerequisites are for building only.

---

## 2. Build — Linux / macOS

```bash
git clone https://github.com/hanyehkhl/rc-vscode.git
cd rc-vscode
npm install --legacy-peer-deps
npm run compile
```

`npm install` triggers `postinstall` → `npm run prepare-cli`, which copies the
CLI overlay into `vendor/rp-cli` and installs its production dependencies.

To produce an installable package:

```bash
npm run package
```

This runs `vscode:prepublish` (bundle Node → apply overlay → compile) and writes
`rc-vscode-<version>.vsix` in the repo root.

Install it:

```bash
code --install-extension ./rc-vscode-0.1.3.vsix
```

## 3. Build — Windows

Identical commands. Use PowerShell or Git Bash:

```powershell
git clone https://github.com/hanyehkhl/rc-vscode.git
cd rc-vscode
npm install --legacy-peer-deps
npm run compile
npm run package
```

```powershell
code --install-extension .\rc-vscode-0.1.3.vsix
```

**Windows-specific notes**

- `prepare-cli` deletes and rebuilds `vendor/rp-cli`. Windows locks those files
  while an Extension Development Host is running, so **close every debug window
  before packaging**. If the directory is locked the script moves it aside as
  `vendor/rp-cli.old-<timestamp>` and carries on — those leftovers are safe to
  delete.
- Paths containing spaces (like `C:\codes\r and d\...`) work, but quote them in
  every shell command.
- Use `py -3` rather than `python` when checking the Python install.

## 4. Development loop

```bash
code .
```

Press **F5** → an *Extension Development Host* window opens with RC loaded.
Open a project folder inside that window, otherwise workspace context is empty
and half the features have nothing to work with.

```bash
npm run watch     # recompile TypeScript on save
```

After editing `src/**` press **Ctrl+R** in the dev host to reload. After editing
`cli-overlay/**` you must re-run `npm run prepare-cli` first — those files are
copied into `vendor/`, not read from source.

### Project layout

| Path | Contents |
|---|---|
| `src/` | extension host: chat panel, agent orchestration, workspace context |
| `media/` | webview UI (`chat.js`, `chat.css`) |
| `cli-overlay/` | patches layered onto the upstream `rp-cli` package |
| `vendor/rp-cli/` | generated — the self-contained CLI shipped in the VSIX |
| `vendor/node/` | generated — bundled Node runtimes per platform |
| `velocity-daemon/` | optional Python daemon (see Velocity below) |

`vendor/` is generated and git-ignored. Never edit it by hand — edit
`cli-overlay/` and re-run `npm run prepare-cli`.

## 5. Troubleshooting the build

| Symptom | Cause and fix |
|---|---|
| `Missing @rezaparsian/rp-cli` | run `npm install --legacy-peer-deps` |
| `prepare-cli` warns "Chat.js patch skipped" | upstream changed; the thinking-effort patch in `scripts/apply-cli-overlay.mjs` needs updating |
| `Bundled rp-cli is missing` at runtime | `npm run prepare-cli` never completed |
| VSIX is very large (~160 MB) | expected — it bundles Node for five platforms |

---

# Features

## Approval modes

Set with the mode chip, or cycle with **Tab**.

| Mode | Reads files | Edits files | Runs commands |
|---|---|---|---|
| **Chat** | yes | no | no |
| **Agent** | yes | yes | yes |
| **Agent (Full Access)** | yes | yes (auto-approved) | yes (auto-approved) |

Chat mode is read-only but **not blind** — it can open and search files, so its
answers are grounded in the real code rather than guesses.

## Editor context

Every prompt carries a `# Editor context` block built locally: the active file
with your selection (or the lines around the cursor), other open tabs, current
errors and warnings, and the git branch with uncommitted changes.

This is what lets "explain this function" or "fix this error" work without you
pasting anything. Costs no extra API call. Disable with `rc.agent.editorContext`.

## `@` file mentions

Type `@` to pick a file or folder. A precise mention beats letting the agent
search — its `search_files` tool matches literal substrings and returns at most
50 lines.

## Thinking intensity

| Level | Behavior |
|---|---|
| Off | fastest, no reasoning pass |
| Low | brief reasoning |
| Medium | standard reasoning |
| **Hard** | maximum reasoning **and switches to the `expert` model** |

**Important:** enabling web search forces the model back to `default`, which
silently cancels the expert upgrade. Use *Think hard* with search **off** for the
strongest coding answers.

## Verify loop

After the agent edits files, the extension checks its work and hands back any
failures so the agent can fix them itself:

1. Language-server diagnostics for the edited files — instant.
2. The project's own type-checker — authoritative.

The check command is auto-detected and always non-mutating: `npm run typecheck`,
`tsc --noEmit`, `cargo check`, or `go vet`. Override with
`rc.agent.checkCommand`; disable with `rc.agent.runChecks`.

## Auto-continue

The agent pauses after a fixed number of tool rounds (default 14). Rather than
handing you a truncated answer, it resumes automatically up to 3 times. If it is
still incomplete, a **Continue** button appears under the reply.

## Grounding rules

Anti-hallucination rules appended to the system prompt: never describe or edit
code without reading it first, never invent APIs or file paths, match the
surrounding style, say "I don't know" instead of guessing. Toggle with
`rc.agent.grounding`.

## AGENTS.md

**Command Palette → `RC: Initialize AGENTS.md`**

Generates a project description that the CLI injects into every system prompt as
project ground truth. This is the single cheapest accuracy improvement available
— run it once per repository.

## Pair mode

Chip: **Pair**. Runs a Writer ↔ Reviewer loop for a fixed number of rounds.

- **Writer** produces or improves a solution.
- **Reviewer** critiques it and returns a prioritized change list.

Both roles can read the repository (but not edit it), so the review checks claims
against the actual code. You can inject a note mid-loop — it is treated as high
priority on the next role's turn. Worth the extra rounds for architectural
decisions; overkill for small edits.

## Velocity

Chip with three states: **Off / Auto / Always on**.

Velocity routes turns through a local Python daemon
(`velocity-daemon/`) that runs detectors over the session — context bloat,
aimless searching, retry loops — and applies optimizations such as session reuse
and mention bounding.

**Auto** is the default: the extension times each turn, and once one exceeds
`rc.velocity.autoTriggerSeconds` (default 25), the rest of that chat is handed to
the daemon. It tells you why in the transcript.

**Requirements.** Nothing to install by hand.

On first use RC builds a private environment under the extension's global
storage. It prefers [`uv`](https://docs.astral.sh/uv/) when present — much
faster, and it provisions a Python interpreter itself, so Velocity works even on
a machine with no Python at all. Without uv it falls back to `venv` + `pip`,
which does require a system Python 3.11+.

You see a one-time "preparing Velocity" notification; after that it is instant.
Your system Python is never modified. If the packages already happen to be
installed system-wide, RC uses those and skips the environment entirely.

If neither uv nor Python is available, RC says so once and falls back to the
standard path. Everything else keeps working.

Verify the daemon by hand:

```bash
curl http://127.0.0.1:8790/health
```

## Chat history

The clock icon in the panel header lists saved chats — click one to restore it,
`x` to delete, or *Clear all*. Threads are stored in the extension's global
state, so they survive reloads and window changes. The 50 most recent are kept.

A restored thread starts a fresh server-side session; the transcript is replayed
into the conversation.

## Copy and edit messages

Hover any message for **Copy**. User messages also show **Edit**, which puts the
text back in the composer and rewinds the conversation to that point, so you can
rephrase and resend without starting over. Code blocks have their own copy button.

## Bidirectional text

Persian, Arabic, and English mix correctly. Each paragraph resolves its own
direction and code blocks are isolated left-to-right, so an English identifier
inside a Persian sentence no longer scrambles the line.

## Web search

Chip: **Search**. Enables DeepSeek web search for the turn. Remember it forces
the `default` model — do not combine it with *Think hard*.

## Commit messages

- `RC: Generate Commit Message` — from staged changes
- `RC: Generate Commit Message (All Changes)` — from `git diff HEAD`

## Slash commands

| Command | Effect |
|---|---|
| `/search` | toggle web search |
| `/thinking` | cycle off → low → medium → hard |
| `/pair` | toggle pair mode |
| `/velocity` | cycle off → auto → on |
| `/token` | re-enter the DeepSeek token |
| `/exit`, `/quit` | close the panel |

---

## Settings reference

| Setting | Default | Purpose |
|---|---|---|
| `rc.token` | `""` | DeepSeek token (or use `~/.config/rp-cli/.env`) |
| `rc.cliPath` | `""` | override the bundled CLI |
| `rc.nodePath` | `""` | override the bundled Node |
| `rc.agent.editorContext` | `true` | send active file, selection, diagnostics, git status |
| `rc.agent.sessionMemory` | `true` | reuse one server session per thread |
| `rc.agent.autoContinue` | `true` | resume past the tool-round ceiling |
| `rc.agent.maxContinues` | `3` | continuation limit per turn |
| `rc.agent.verifyEdits` | `true` | feed post-edit errors back to the agent |
| `rc.agent.runChecks` | `true` | run the project type-checker after edits |
| `rc.agent.checkCommand` | `""` | override the verification command |
| `rc.agent.checkTimeoutMs` | `90000` | verification timeout |
| `rc.agent.maxVerifyRounds` | `2` | self-repair attempts |
| `rc.agent.maxToolRounds` | `14` | tool rounds before pausing |
| `rc.agent.grounding` | `true` | append anti-hallucination rules |
| `rc.velocity.mode` | `auto` | `off` / `auto` / `on` |
| `rc.velocity.autoTriggerSeconds` | `25` | slow-turn threshold for Auto |
| `rc.velocity.daemonPort` | `8790` | daemon port |
| `rc.velocity.servePort` | `3001` | bundled `rc serve` port |
| `rc.velocity.stream` | `true` | stream tokens through Velocity |
