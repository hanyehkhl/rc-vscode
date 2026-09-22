import { execFile, spawn, type ChildProcess } from "child_process";
import { promises as fs } from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { ToolDefinition } from "./client";

/**
 * Workspace tools exposed to Ashna foundation models as OpenAI client tools.
 *
 * These run in the extension host, scoped to the first workspace folder, and
 * mirror the rc CLI tool set (read/list/search/write/edit/delete/run) so both
 * providers behave the same from the user's point of view.
 */

const MAX_READ_BYTES = 200 * 1024;
const MAX_SEARCH_FILE_BYTES = 256 * 1024;
const MAX_SEARCH_HITS = 60;
const MAX_FIND_RESULTS = 200;
const MAX_TOOL_OUTPUT_CHARS = 30_000;
const SEARCH_EXCLUDE = "**/{node_modules,dist,out,build,.git,.venv,venv,__pycache__,.next,target}/**";

export type ToolContext = {
  root: string;
  signal: AbortSignal;
  commandTimeoutMs: number;
};

export type ToolOutcome = {
  ok: boolean;
  output: string;
  /** Workspace-relative paths changed by this call, for verification/UI. */
  changed?: string[];
};

const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;

/**
 * Kill a shell and everything it started. Killing only the shell leaves
 * `npm test` → node, dev servers or compilers running — on Windows children
 * never die with their parent, and on Unix they get re-parented.
 */
function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => undefined);
    return;
  }
  try {
    process.kill(-pid, "SIGKILL"); // whole process group (spawned detached)
  } catch {
    child.kill("SIGKILL");
  }
}

function runShellCommand(command: string, ctx: ToolContext): Promise<ToolOutcome> {
  return new Promise<ToolOutcome>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, {
        cwd: ctx.root,
        shell: true, // cmd.exe on Windows, /bin/sh elsewhere
        windowsHide: true,
        // Own process group on Unix so the whole tree can be killed.
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, CI: process.env.CI ?? "1" } // discourage interactive prompts
      });
    } catch (error) {
      resolve({ ok: false, output: `Error: could not start command (${error instanceof Error ? error.message : String(error)}).` });
      return;
    }

    const chunks: { out: Buffer[]; err: Buffer[] } = { out: [], err: [] };
    let bytes = 0;
    let overflow = false;
    const collect = (target: Buffer[]) => (data: Buffer) => {
      if (bytes >= MAX_COMMAND_OUTPUT_BYTES) {
        overflow = true;
        return;
      }
      bytes += data.length;
      target.push(data);
    };
    child.stdout?.on("data", collect(chunks.out));
    child.stderr?.on("data", collect(chunks.err));

    let reason = "";
    const stop = (why: string) => {
      if (!reason) reason = why;
      killProcessTree(child);
    };
    const timer = setTimeout(() => stop(`killed after ${Math.round(ctx.commandTimeoutMs / 1000)}s timeout`), ctx.commandTimeoutMs);
    const onAbort = () => stop("cancelled by the user");
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    let settled = false;
    const finish = (code: number | null, spawnError?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      const stdout = Buffer.concat(chunks.out).toString("utf8").trimEnd();
      const stderr = Buffer.concat(chunks.err).toString("utf8").trimEnd();
      const parts: string[] = [];
      if (stdout) parts.push(stdout);
      if (stderr) parts.push(`stderr:\n${stderr}`);
      if (overflow) parts.push("(output truncated at 2 MiB)");
      if (spawnError) parts.push(`(failed to start: ${spawnError.message})`);
      else if (reason) parts.push(`(${reason})`);
      else if (code !== 0) parts.push(`(exit code ${code ?? "unknown"})`);
      resolve({ ok: !spawnError && !reason && code === 0, output: truncate(parts.join("\n\n") || "(no output)") });
    };
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code));
  });
}

type ToolSpec = {
  definition: ToolDefinition;
  mutating: boolean;
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutcome>;
};

class ToolInputError extends Error {}

function str(args: Record<string, unknown>, name: string, fallback?: string): string {
  const value = args[name];
  if (typeof value === "string") return value;
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw new ToolInputError(`Missing required argument "${name}".`);
  }
  return String(value);
}

function optionalInt(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function truncate(text: string, limit = MAX_TOOL_OUTPUT_CHARS): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… (truncated, ${text.length - limit} more characters)`;
}

function toRelative(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join("/") || ".";
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Resolve an existing path and refuse anything (incl. symlinks) outside the root. */
async function resolveExisting(root: string, requested: string): Promise<string> {
  const resolved = path.resolve(root, requested || ".");
  if (!isInside(root, resolved)) {
    throw new ToolInputError("Path is outside the workspace.");
  }
  const [real, realRoot] = await Promise.all([fs.realpath(resolved), fs.realpath(root)]);
  if (!isInside(realRoot, real)) {
    throw new ToolInputError("Path resolves outside the workspace.");
  }
  return real;
}

/** Resolve a path that may not exist yet (write target). Parent dirs are created. */
async function resolveTarget(root: string, requested: string): Promise<string> {
  if (!requested.trim()) throw new ToolInputError("Path is empty.");
  const resolved = path.resolve(root, requested);
  if (!isInside(root, resolved) || resolved === path.resolve(root)) {
    throw new ToolInputError("Path is outside the workspace.");
  }
  const parent = path.dirname(resolved);
  await fs.mkdir(parent, { recursive: true });
  const [realParent, realRoot] = await Promise.all([fs.realpath(parent), fs.realpath(root)]);
  if (!isInside(realRoot, realParent)) {
    throw new ToolInputError("Path resolves outside the workspace.");
  }
  return path.join(realParent, path.basename(resolved));
}

/** Path equality that ignores drive-letter/case differences on Windows. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => (process.platform === "win32" ? path.normalize(p).toLowerCase() : path.normalize(p));
  return norm(a) === norm(b);
}

function openDocument(file: string): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find((doc) => doc.uri.scheme === "file" && samePath(doc.uri.fsPath, file));
}

/**
 * Read what the user actually sees: an open editor may hold unsaved changes
 * that are newer than the file on disk.
 */
async function readText(file: string): Promise<string> {
  const doc = openDocument(file);
  if (doc) return doc.getText();
  return fs.readFile(file, "utf8");
}

/**
 * Write through the editor when the file is open, so VS Code does not report a
 * "file changed on disk" conflict and undo history keeps working.
 */
async function writeText(file: string, content: string): Promise<void> {
  const doc = openDocument(file);
  if (doc) {
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
    edit.replace(doc.uri, fullRange, content);
    if (await vscode.workspace.applyEdit(edit)) {
      await doc.save();
      return;
    }
  }
  await fs.writeFile(file, content, "utf8");
}

const LINE_NUMBER_PREFIX = /^\s*\d+\| ?/;

/** read_file prefixes lines with "N| "; models sometimes copy that into old_text. */
function stripLineNumbers(text: string): string | undefined {
  const lines = text.split("\n");
  const nonEmpty = lines.filter((line) => line.trim());
  if (!nonEmpty.length || !nonEmpty.every((line) => LINE_NUMBER_PREFIX.test(line))) return undefined;
  return lines.map((line) => line.replace(LINE_NUMBER_PREFIX, "")).join("\n");
}

type Match = { start: number; end: number } | { error: string };

function exactMatch(content: string, needle: string): Match | undefined {
  const first = content.indexOf(needle);
  if (first === -1) return undefined;
  if (content.indexOf(needle, first + 1) !== -1) {
    return { error: "old_text matches more than once. Include more surrounding lines to make it unique." };
  }
  return { start: first, end: first + needle.length };
}

/** Line-block match that ignores trailing whitespace — the most common near-miss. */
function looseLineMatch(content: string, needle: string): Match | undefined {
  const contentLines = content.split("\n");
  const needleLines = needle.replace(/\n+$/, "").split("\n").map((line) => line.trimEnd());
  while (needleLines.length && !needleLines[0].trim()) needleLines.shift();
  if (!needleLines.length) return undefined;

  const hits: number[] = [];
  for (let i = 0; i + needleLines.length <= contentLines.length; i++) {
    let ok = true;
    for (let j = 0; j < needleLines.length; j++) {
      if (contentLines[i + j].trimEnd() !== needleLines[j]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  if (!hits.length) return undefined;
  if (hits.length > 1) {
    return { error: "old_text matches more than once. Include more surrounding lines to make it unique." };
  }
  const offsets: number[] = [0];
  for (const line of contentLines) offsets.push(offsets[offsets.length - 1] + line.length + 1);
  const startLine = hits[0];
  const endLine = startLine + needleLines.length;
  const keepTrailingNewline = needle.endsWith("\n");
  const end = keepTrailingNewline ? offsets[endLine] : offsets[endLine] - 1;
  return { start: offsets[startLine], end: Math.min(end, content.length) };
}

function locate(content: string, needle: string): Match {
  const candidates = [needle, stripLineNumbers(needle)].filter((c): c is string => Boolean(c));
  for (const candidate of candidates) {
    const exact = exactMatch(content, candidate);
    if (exact) return exact;
  }
  for (const candidate of candidates) {
    const loose = looseLineMatch(content, candidate);
    if (loose) return loose;
  }
  return { error: "old_text was not found. Re-read the file (read_file) and copy the lines verbatim, without the line-number prefix." };
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  return sample.includes(0);
}

function fn(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties, required, additionalProperties: false }
    }
  };
}

const TOOL_SPECS: ToolSpec[] = [
  {
    mutating: false,
    definition: fn(
      "list_directory",
      "List files and folders at a workspace-relative path (not recursive).",
      { path: { type: "string", description: "Directory relative to the workspace root. Defaults to '.'." } },
      []
    ),
    async execute(args, ctx) {
      const dir = await resolveExisting(ctx.root, str(args, "path", "."));
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const lines = entries
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
      return { ok: true, output: lines.length ? truncate(lines.join("\n")) : "(empty directory)" };
    }
  },
  {
    mutating: false,
    definition: fn(
      "read_file",
      "Read a UTF-8 text file. Output lines are prefixed with their 1-based line number. Use start_line/end_line for large files.",
      {
        path: { type: "string", description: "File path relative to the workspace root." },
        start_line: { type: "integer", description: "First line to return (1-based, optional)." },
        end_line: { type: "integer", description: "Last line to return (inclusive, optional)." }
      },
      ["path"]
    ),
    async execute(args, ctx) {
      const file = await resolveExisting(ctx.root, str(args, "path"));
      const stats = await fs.stat(file);
      if (!stats.isFile()) throw new ToolInputError("Not a file.");
      const start = optionalInt(args, "start_line");
      const end = optionalInt(args, "end_line");
      if (stats.size > MAX_READ_BYTES && !start && !end) {
        throw new ToolInputError(
          `File is ${Math.round(stats.size / 1024)} KiB; read it in ranges with start_line/end_line.`
        );
      }
      const doc = openDocument(file);
      let text: string;
      if (doc) {
        text = doc.getText();
      } else {
        const buffer = await fs.readFile(file);
        if (looksBinary(buffer)) throw new ToolInputError("File looks binary; refusing to read it as text.");
        text = buffer.toString("utf8");
      }
      const lines = text.split(/\r?\n/);
      const from = Math.max(1, start ?? 1);
      const to = Math.min(lines.length, end ?? lines.length);
      const width = String(to).length;
      const body = lines
        .slice(from - 1, to)
        .map((line, i) => `${String(from + i).padStart(width, " ")}| ${line}`)
        .join("\n");
      const header = from > 1 || to < lines.length ? `(lines ${from}-${to} of ${lines.length})\n` : "";
      return { ok: true, output: truncate(header + body) };
    }
  },
  {
    mutating: false,
    definition: fn(
      "find_files",
      "Find files by glob pattern, e.g. '**/*.ts' or 'src/**/config*'. Ignores node_modules, build output and .git.",
      { pattern: { type: "string", description: "Glob pattern relative to the workspace root." } },
      ["pattern"]
    ),
    async execute(args, ctx) {
      const pattern = str(args, "pattern");
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(ctx.root, pattern),
        SEARCH_EXCLUDE,
        MAX_FIND_RESULTS
      );
      const files = uris.map((uri) => toRelative(ctx.root, uri.fsPath)).sort();
      return { ok: true, output: files.length ? files.join("\n") : "No files matched." };
    }
  },
  {
    mutating: false,
    definition: fn(
      "search_files",
      "Search file contents (grep). Literal text by default, or a JavaScript regular expression with regex=true. Returns path:line: text for up to 60 matches.",
      {
        query: { type: "string", description: "Text (or regex when regex=true) to look for." },
        regex: { type: "boolean", description: "Treat query as a regular expression." },
        glob: { type: "string", description: "Optional glob to narrow the files searched, e.g. 'src/**/*.ts'." },
        ignore_case: { type: "boolean", description: "Case-insensitive match." }
      },
      ["query"]
    ),
    async execute(args, ctx) {
      const query = str(args, "query");
      if (!query) throw new ToolInputError("query is empty.");
      const glob = str(args, "glob", "**/*") || "**/*";
      const ignoreCase = args.ignore_case === true;
      const needle = ignoreCase ? query.toLowerCase() : query;
      let pattern: RegExp | undefined;
      if (args.regex === true) {
        try {
          pattern = new RegExp(query, ignoreCase ? "i" : "");
        } catch (error) {
          throw new ToolInputError(`Invalid regex: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(ctx.root, glob), SEARCH_EXCLUDE, 5000);
      const hits: string[] = [];
      for (const uri of uris) {
        if (ctx.signal.aborted || hits.length >= MAX_SEARCH_HITS) break;
        let buffer: Buffer;
        try {
          const stats = await fs.stat(uri.fsPath);
          if (stats.size > MAX_SEARCH_FILE_BYTES) continue;
          buffer = await fs.readFile(uri.fsPath);
        } catch {
          continue;
        }
        if (looksBinary(buffer)) continue;
        const lines = buffer.toString("utf8").split(/\r?\n/);
        for (let i = 0; i < lines.length && hits.length < MAX_SEARCH_HITS; i++) {
          const matched = pattern
            ? pattern.test(lines[i])
            : (ignoreCase ? lines[i].toLowerCase() : lines[i]).includes(needle);
          if (matched) {
            hits.push(`${toRelative(ctx.root, uri.fsPath)}:${i + 1}: ${lines[i].trim().slice(0, 240)}`);
          }
        }
      }
      return { ok: true, output: hits.length ? hits.join("\n") : "No matches." };
    }
  },
  {
    mutating: true,
    definition: fn(
      "write_file",
      "Create a file or completely overwrite it. Use for new files or deliberate full rewrites; prefer edit_file for changes.",
      {
        path: { type: "string", description: "File path relative to the workspace root." },
        content: { type: "string", description: "Full file content." }
      },
      ["path", "content"]
    ),
    async execute(args, ctx) {
      const target = await resolveTarget(ctx.root, str(args, "path"));
      const content = str(args, "content");
      await writeText(target, content);
      const rel = toRelative(ctx.root, target);
      return { ok: true, output: `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${rel}.`, changed: [rel] };
    }
  },
  {
    mutating: true,
    definition: fn(
      "edit_file",
      "Replace one exact, unique occurrence of old_text with new_text. Copy old_text verbatim from read_file output WITHOUT the line-number prefix; keep it small but unique.",
      {
        path: { type: "string", description: "File path relative to the workspace root." },
        old_text: { type: "string", description: "Exact text currently in the file." },
        new_text: { type: "string", description: "Replacement text." }
      },
      ["path", "old_text", "new_text"]
    ),
    async execute(args, ctx) {
      const file = await resolveExisting(ctx.root, str(args, "path"));
      const oldText = str(args, "old_text");
      const newText = str(args, "new_text");
      if (!oldText) throw new ToolInputError("old_text is empty; use write_file to create a file.");
      const original = await readText(file);

      // Work in LF and restore CRLF afterwards, so LF snippets match CRLF files.
      const usesCrlf = original.includes("\r\n");
      const content = usesCrlf ? original.replace(/\r\n/g, "\n") : original;
      const match = locate(content, oldText.replace(/\r\n/g, "\n"));
      if ("error" in match) throw new ToolInputError(match.error);
      let updated = content.slice(0, match.start) + newText.replace(/\r\n/g, "\n") + content.slice(match.end);
      if (updated === content) {
        return { ok: true, output: "No change: new_text is identical to the matched text." };
      }
      if (usesCrlf) updated = updated.replace(/\n/g, "\r\n");
      await writeText(file, updated);
      const rel = toRelative(ctx.root, file);
      return { ok: true, output: `Edited ${rel}.`, changed: [rel] };
    }
  },
  {
    mutating: true,
    definition: fn(
      "delete_file",
      "Delete a single file in the workspace.",
      { path: { type: "string", description: "File path relative to the workspace root." } },
      ["path"]
    ),
    async execute(args, ctx) {
      const file = await resolveExisting(ctx.root, str(args, "path"));
      const stats = await fs.stat(file);
      if (!stats.isFile()) throw new ToolInputError("Not a file.");
      await fs.unlink(file);
      const rel = toRelative(ctx.root, file);
      return { ok: true, output: `Deleted ${rel}.`, changed: [rel] };
    }
  },
  {
    mutating: true,
    definition: fn(
      "run_command",
      "Run a shell command in the workspace root and return stdout/stderr. Non-interactive only; long-running servers will time out.",
      { command: { type: "string", description: "Shell command to execute." } },
      ["command"]
    ),
    async execute(args, ctx) {
      const command = str(args, "command").trim();
      if (!command) throw new ToolInputError("command is empty.");
      return runShellCommand(command, ctx);
    }
  }
];

const SPEC_BY_NAME = new Map(TOOL_SPECS.map((spec) => [spec.definition.function.name, spec]));

export function toolDefinitions(options: { readOnly: boolean }): ToolDefinition[] {
  return TOOL_SPECS.filter((spec) => !options.readOnly || !spec.mutating).map((spec) => spec.definition);
}

export function isMutatingTool(name: string): boolean {
  return SPEC_BY_NAME.get(name)?.mutating ?? true;
}

export function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ToolInputError("Tool arguments must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

/** Short label for the tool timeline, e.g. "read_file · src/app.ts". */
export function describeToolCall(name: string, args: Record<string, unknown>): string {
  const target =
    (typeof args.path === "string" && args.path) ||
    (typeof args.pattern === "string" && args.pattern) ||
    (typeof args.query === "string" && `"${args.query}"`) ||
    (typeof args.command === "string" && args.command.slice(0, 80)) ||
    "";
  return target ? `${name} · ${target}` : name;
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolOutcome> {
  const spec = SPEC_BY_NAME.get(name);
  if (!spec) return { ok: false, output: `Unknown tool "${name}".` };
  try {
    return await spec.execute(args, ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, output: `Error: ${message}` };
  }
}
