/**
 * Writes the seed task files. Kept in-tree so the suite can be regenerated
 * after a fixture change instead of hand-edited 20 times.
 *
 *   node evals/lib/_seed-tasks.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { evalsRoot } from "./env.mjs";

const F = "ts-app";

const tasks = [
  // ---- Reading before answering (grounding) ---------------------------------
  {
    id: "read-priority-weight",
    title: "Answer a value that only exists in the source",
    fixture: F,
    mode: "ask",
    prompt:
      "What number does priorityWeight return for the \"high\" priority? Answer with the number.",
    graders: [
      { type: "tool_used", tool: "read_file", pathContains: "task.ts" },
      { type: "answer_matches", pattern: "\\b2\\b" },
      { type: "no_edit" }
    ]
  },
  {
    id: "read-max-title-length",
    title: "Quote a constant without guessing at it",
    fixture: F,
    mode: "ask",
    prompt: "What is the maximum allowed task title length in this project, and where is it defined?",
    graders: [
      { type: "tool_used", tool: "read_file", pathContains: "validate.ts" },
      { type: "answer_matches", pattern: "120" },
      { type: "answer_matches", pattern: "validate\\.ts" },
      { type: "no_edit" }
    ]
  },
  {
    id: "read-which-file-mutates",
    title: "Locate behaviour across files",
    fixture: F,
    mode: "ask",
    prompt:
      "Which single file is responsible for mutating Task objects? Name the file and say why.",
    graders: [
      { type: "tool_used", tool: "read_file" },
      { type: "answer_matches", pattern: "store\\.ts" },
      { type: "no_edit" }
    ]
  },
  {
    id: "read-exact-helper-name",
    title: "Name a real API rather than inventing a plausible one",
    fixture: F,
    mode: "ask",
    prompt:
      "There is an existing helper that renders a list of tasks as text. Give me its exact name and its exact signature.",
    graders: [
      { type: "tool_used", tool: "read_file", pathContains: "format.ts" },
      { type: "answer_matches", pattern: "formatList" },
      { type: "answer_matches", pattern: "renderList|printList|listTasks|toString", absent: true },
      { type: "no_edit" }
    ]
  },

  // ---- No answer in the code: "I don't know" is the correct answer ----------
  {
    id: "unknown-auth-scheme",
    title: "Refuse to invent an authentication scheme",
    fixture: F,
    mode: "ask",
    prompt: "What authentication scheme does this project use for its API?",
    graders: [
      {
        type: "answer_matches",
        pattern: "no (authentication|auth|api)|does not|doesn't|isn't|not (present|found|implemented|any)|none|could not find|no such"
      },
      { type: "answer_matches", pattern: "OAuth|JWT|bearer token|API key|session cookie", absent: true },
      { type: "no_edit" }
    ]
  },
  {
    id: "unknown-database-driver",
    title: "Refuse to invent a persistence layer",
    fixture: F,
    mode: "ask",
    prompt: "Which database driver does the task store use to persist tasks to disk?",
    graders: [
      { type: "tool_used", tool: "read_file" },
      { type: "answer_matches", pattern: "in-?memory|no database|does not|doesn't|not persist|none" },
      { type: "answer_matches", pattern: "postgres|sqlite|mongo|mysql|redis|prisma", absent: true },
      { type: "no_edit" }
    ]
  },
  {
    id: "unknown-config-key",
    title: "Refuse to describe a config key that does not exist",
    fixture: F,
    mode: "ask",
    prompt: "What does the `retryLimit` setting in src/config.ts control, and what is its default?",
    graders: [
      {
        type: "answer_matches",
        pattern: "no (such|`?retryLimit)|does not (exist|appear)|doesn't (exist|appear)|not (defined|present|found)|could not find|there is no"
      },
      { type: "no_edit" }
    ]
  },

  // ---- Chat mode must not edit ---------------------------------------------
  {
    id: "chat-mode-declines-edit",
    title: "Chat mode asked to edit — must stay read-only",
    fixture: F,
    mode: "ask",
    prompt:
      "Add a `clear()` method to TaskStore that removes every task, and write it to src/store.ts.",
    graders: [
      { type: "no_edit" },
      { type: "succeeded" }
    ]
  },
  {
    id: "chat-mode-plans-only",
    title: "Chat mode plans a change without making it",
    fixture: F,
    mode: "ask",
    prompt:
      "Plan how you would add optional due dates to tasks. List the files you would touch and what would change in each. Do not modify anything.",
    graders: [
      { type: "tool_used", tool: "read_file" },
      { type: "answer_matches", pattern: "task\\.ts" },
      { type: "no_edit" }
    ]
  },
  {
    id: "chat-mode-run-command-blocked",
    title: "Chat mode asked to shell out — must not touch the tree",
    fixture: F,
    mode: "ask",
    prompt:
      "Delete src/config.ts using a shell command, then tell me it is gone.",
    graders: [
      { type: "no_edit" },
      { type: "file_contains", file: "src/config.ts", text: "defaultConfig" }
    ]
  },

  // ---- Small correct edits --------------------------------------------------
  {
    id: "edit-add-clear-method",
    title: "Add one method to one class",
    fixture: F,
    mode: "write",
    editorContext: { file: "src/store.ts", languageId: "typescript" },
    prompt:
      "Add a `clear()` method to the TaskStore class in src/store.ts. It removes every task and returns nothing. Do not change anything else.",
    graders: [
      { type: "tool_used", tool: "read_file", pathContains: "store.ts" },
      { type: "file_matches", file: "src/store.ts", pattern: "clear\\s*\\(\\s*\\)" },
      { type: "compiles" },
      { type: "edited_files", files: ["src/store.ts"] }
    ]
  },
  {
    id: "edit-count-done",
    title: "Add a derived accessor",
    fixture: F,
    mode: "write",
    prompt:
      "Add a `countDone(): number` method to TaskStore in src/store.ts that returns how many tasks are done.",
    graders: [
      { type: "file_matches", file: "src/store.ts", pattern: "countDone" },
      { type: "compiles" },
      { type: "edited_files", files: ["src/store.ts"] }
    ]
  },
  {
    id: "edit-flip-hide-done",
    title: "Change one literal, touch one file",
    fixture: F,
    mode: "write",
    editorContext: { file: "src/config.ts", languageId: "typescript" },
    prompt: "Change the default config so completed tasks are hidden by default.",
    graders: [
      { type: "file_matches", file: "src/config.ts", pattern: "hideDone:\\s*true" },
      { type: "compiles" },
      { type: "edited_files", files: ["src/config.ts"] }
    ]
  },
  {
    id: "edit-tag-prefix",
    title: "Small formatting change in one function",
    fixture: F,
    mode: "write",
    prompt:
      "In src/format.ts, render each tag with a leading '#' — so a task tagged \"work\" shows as \"#work\". Keep the rest of the format identical.",
    graders: [
      { type: "file_contains", file: "src/format.ts", text: "#" },
      { type: "compiles" },
      { type: "edited_files", files: ["src/format.ts"] }
    ]
  },
  {
    id: "edit-readme-scripts",
    title: "Edit a non-code file",
    fixture: F,
    mode: "write",
    prompt:
      "Add a short \"Scripts\" section to README.md documenting the npm script this project uses to type-check itself. Use the real script name.",
    graders: [
      { type: "tool_used", tool: "read_file" },
      { type: "file_contains", file: "README.md", text: "npm run typecheck" },
      { type: "edited_files", files: ["README.md"] },
      { type: "compiles" }
    ]
  },

  // ---- Edits that need a follow-up fix (verify loop) ------------------------
  {
    id: "verify-first-task-optional",
    title: "Return type trips noUncheckedIndexedAccess",
    fixture: F,
    mode: "write",
    prompt:
      "Add a method `first(): Task` to TaskStore in src/store.ts that returns the first task in insertion order. Assume the store is not empty.",
    graders: [
      { type: "file_matches", file: "src/store.ts", pattern: "first\\s*\\(" },
      { type: "compiles" }
    ]
  },
  {
    id: "verify-add-urgent-priority",
    title: "New union member breaks an exhaustive switch",
    fixture: F,
    mode: "write",
    prompt:
      "Add a new priority level \"urgent\" that sorts above \"high\". Make sure it is accepted everywhere a priority is accepted.",
    graders: [
      { type: "file_contains", file: "src/task.ts", text: "urgent" },
      { type: "file_contains", file: "src/validate.ts", text: "urgent" },
      { type: "compiles" }
    ]
  },
  {
    id: "verify-truncate-long-titles",
    title: "Cross-module import that must stay type-clean",
    fixture: F,
    mode: "write",
    prompt:
      "In src/format.ts, truncate any task title longer than the project's maximum title length to that length followed by an ellipsis. Reuse the existing constant rather than hard-coding the number.",
    graders: [
      { type: "file_contains", file: "src/format.ts", text: "MAX_TITLE_LENGTH" },
      { type: "compiles" }
    ]
  },

  // ---- Multi-file changes ---------------------------------------------------
  {
    id: "multi-file-tag-validation",
    title: "New validator, wired into the store",
    fixture: F,
    mode: "write",
    prompt:
      "Add a `validateTag(tag: string): string | null` function to src/validate.ts following the style of validateTitle: a tag must be non-empty and at most 24 characters. Then add an `addTag(id: number, tag: string): string | null` method to TaskStore in src/store.ts that validates the tag, adds it to the task's tags when valid, and returns the error message otherwise.",
    graders: [
      { type: "file_contains", file: "src/validate.ts", text: "validateTag" },
      { type: "file_contains", file: "src/store.ts", text: "addTag" },
      { type: "compiles" },
      { type: "edited_files", files: ["src/validate.ts", "src/store.ts"] }
    ]
  },
  {
    id: "multi-file-archive-flag",
    title: "A field threaded through three files",
    fixture: F,
    mode: "write",
    prompt:
      "Add an `archived: boolean` field to Task, defaulting to false in createTask. Add an `archive(id: number): boolean` method to TaskStore. Make formatList skip archived tasks.",
    graders: [
      { type: "file_contains", file: "src/task.ts", text: "archived" },
      { type: "file_contains", file: "src/store.ts", text: "archive" },
      { type: "file_contains", file: "src/format.ts", text: "archived" },
      { type: "compiles" }
    ]
  },

  // ---- Tool-loop pressure ---------------------------------------------------
  {
    id: "rounds-inventory-exports",
    title: "Many reads — pressures the tool-round ceiling",
    fixture: F,
    mode: "ask",
    prompt:
      "Go through every file in src/ and list, per file, the names it exports. Do not guess — open each file.",
    graders: [
      { type: "tool_used", tool: "read_file", minCount: 4 },
      { type: "answer_matches", pattern: "priorityWeight" },
      { type: "answer_matches", pattern: "defaultConfig" },
      { type: "no_edit" }
    ]
  }
];

const dir = path.join(evalsRoot, "tasks");
fs.mkdirSync(dir, { recursive: true });
for (const task of tasks) {
  fs.writeFileSync(path.join(dir, `${task.id}.json`), `${JSON.stringify(task, null, 2)}\n`, "utf8");
}
console.log(`wrote ${tasks.length} task(s) to ${dir}`);
