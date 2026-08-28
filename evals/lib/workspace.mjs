import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evalsRoot } from "./env.mjs";

/**
 * Isolation.
 *
 * The agent can create untracked files and run arbitrary shell commands, so
 * `git stash` / `git checkout .` cannot be trusted to undo a task. Instead each
 * task gets a throwaway checkout that is deleted afterwards:
 *
 *   evals/fixtures/<name>/       plain files, no .git (nothing nested in the
 *                                extension's own repository)
 *        │  copy + git init + one commit, once per run
 *        ▼
 *   <workdir>/seed/<name>/       a real git repo, never handed to an agent
 *        │  git clone --local --no-hardlinks, once per task attempt
 *        ▼
 *   <workdir>/tasks/<id>/repo/   the agent's cwd; deleted after grading
 *
 * `--no-hardlinks` matters: with hardlinks a clone shares object files with the
 * seed, and an agent running `git gc` or writing into `.git` could corrupt the
 * seed for every later task.
 *
 * The clone is what makes `no_edit` and "files edited" trustworthy — `git
 * status --porcelain` in a pristine checkout reports untracked files too, which
 * is exactly the class of change an `edited` RC_EVENT would miss.
 *
 * If a task leaves a process running: the harness kills the process tree of the
 * CLI it spawned (taskkill /T on Windows, process-group kill elsewhere) on
 * timeout or abort. A grandchild that escapes that — something the agent
 * daemonised via `run_command` — is NOT killed, and on Windows it can hold a
 * lock on the sandbox. Cleanup is therefore best-effort and retried; a sandbox
 * that still cannot be removed is left on disk and named in the result file
 * under `leakedWorkspaces` rather than failing the run. `npm run eval:clean`
 * removes whatever is left over.
 */

const GIT_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "rc-eval",
  GIT_AUTHOR_EMAIL: "rc-eval@localhost",
  GIT_COMMITTER_NAME: "rc-eval",
  GIT_COMMITTER_EMAIL: "rc-eval@localhost"
};

function git(args, cwd) {
  // execFile with an argv array: no shell, so paths with spaces are safe.
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, ...GIT_ENV }
  });
}

export function defaultWorkDir() {
  return path.join(os.tmpdir(), "rc-evals");
}

/** Copy a fixture into a temp dir and make it a one-commit git repository. */
export function ensureSeedRepo(fixtureName, workDir) {
  const source = path.join(evalsRoot, "fixtures", fixtureName);
  if (!fs.existsSync(source)) {
    throw new Error(`Unknown fixture: ${fixtureName} (looked in ${source})`);
  }

  const seed = path.join(workDir, "seed", fixtureName);
  if (fs.existsSync(path.join(seed, ".git"))) {
    return seed;
  }

  fs.rmSync(seed, { recursive: true, force: true });
  fs.mkdirSync(seed, { recursive: true });
  fs.cpSync(source, seed, { recursive: true });

  git(["init", "--quiet", "--initial-branch=main"], seed);
  git(["add", "-A"], seed);
  git(["commit", "--quiet", "-m", "fixture baseline"], seed);
  return seed;
}

/** A pristine clone of the seed. The only directory an agent ever sees. */
export function createSandbox(seedRepo, workDir, taskKey) {
  const dir = path.join(workDir, "tasks", taskKey);
  removeDirSync(dir);
  fs.mkdirSync(dir, { recursive: true });

  const repo = path.join(dir, "repo");
  git(["clone", "--quiet", "--local", "--no-hardlinks", seedRepo, repo], workDir);
  return { dir, repo };
}

/**
 * Paths the agent changed, relative to the sandbox root, including files it
 * created without telling us. Deletions are reported too.
 */
export function changedPaths(repo) {
  const out = git(["status", "--porcelain=v1", "--untracked-files=all"], repo);
  const paths = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    // "XY <path>" — renames arrive as "R  old -> new"; the new name is what matters.
    const rest = line.slice(3).trim();
    const arrow = rest.lastIndexOf(" -> ");
    const file = arrow >= 0 ? rest.slice(arrow + 4) : rest;
    paths.push(file.replace(/^"|"$/g, ""));
  }
  return paths.sort();
}

/**
 * Windows keeps file handles alive briefly after a process exits, so a single
 * rm can fail on a directory that is about to become removable.
 */
export function removeDirSync(dir, attempts = 5) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
      return true;
    } catch {
      if (attempt === attempts - 1) {
        return false;
      }
      // Busy-wait: this is teardown, and the delays are short.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
  return false;
}

/** Kill a spawned CLI and everything it started. */
export function killTree(child) {
  const pid = child?.pid;
  if (!pid) {
    return;
  }
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 8000
      });
      return;
    } catch {
      // fall through
    }
  } else {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // fall through
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // already gone
  }
}

export function wipeWorkDir(workDir) {
  return removeDirSync(workDir);
}

export { execFile };
