import { execFile, execFileSync, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

/**
 * Self-contained Python environment shared by Velocity and CodeGraphContext.
 *
 * Asking the user to run `pip install` before a feature works is not acceptable
 * for an extension, and installing into their system Python would be rude. The
 * first time any feature needs Python we build a private environment under the
 * extension's global storage.
 *
 * `uv` is used when available: it is far faster than pip and can provision a
 * Python interpreter itself. Plain `venv` + `pip` remains the fallback.
 */

const PYTHON_VERSION = "3.12";
const VENV_DIR_NAME = "managed-python-venv";
const VENV_TIMEOUT_MS = 300_000;
const INSTALL_TIMEOUT_MS = 600_000;

let storageDir: string | undefined;
let cachedPython: string | undefined;
let preparing: Promise<string> | undefined;

/** @deprecated Use setManagedPythonStoragePath */
export function setVelocityStoragePath(dir: string): void {
  setManagedPythonStoragePath(dir);
}

export function setManagedPythonStoragePath(dir: string): void {
  storageDir = dir;
}

function exists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function venvDir(): string {
  return path.join(storageDir ?? "", VENV_DIR_NAME);
}

function venvPython(dir: string): string {
  return process.platform === "win32"
    ? path.join(dir, "Scripts", "python.exe")
    : path.join(dir, "bin", "python");
}

/** Path to the `cgc` CLI installed alongside the managed interpreter. */
export function cgcBinaryForPython(pythonPath: string): string {
  const dir = path.dirname(pythonPath);
  return path.join(dir, process.platform === "win32" ? "cgc.exe" : "cgc");
}

/** Locate `uv`, including install locations that are not on a GUI PATH. */
export function resolveUv(): string {
  const binary = process.platform === "win32" ? "uv.exe" : "uv";
  const home = os.homedir();

  const candidates = [
    path.join(home, ".local", "bin", binary),
    path.join(home, ".cargo", "bin", binary),
    "/usr/local/bin/uv",
    "/opt/homebrew/bin/uv"
  ];

  for (const candidate of candidates) {
    if (exists(candidate)) {
      return candidate;
    }
  }

  try {
    const probe = process.platform === "win32" ? "where.exe" : "which";
    const found = execFileSync(probe, ["uv"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (found && exists(found)) {
      return found;
    }
  } catch {
    // uv is not installed
  }

  return "";
}

/** Find a usable system Python. Only needed when uv is unavailable. */
export function resolveSystemPython(): string {
  const candidates =
    process.platform === "win32" ? ["py", "python", "python3"] : ["python3", "python"];

  for (const candidate of candidates) {
    try {
      const args =
        candidate === "py"
          ? ["-3", "-c", "import sys; print(sys.executable)"]
          : ["-c", "import sys; print(sys.executable)"];
      const resolved = execFileSync(candidate, args, {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5000
      })
        .trim()
        .split(/\r?\n/)[0];
      if (resolved && exists(resolved)) {
        return resolved;
      }
    } catch {
      // try the next candidate
    }
  }
  return "";
}

function hasManagedDependencies(pythonPath: string): boolean {
  try {
    execFileSync(
      pythonPath,
      ["-c", "import fastapi, uvicorn, httpx, pydantic, codegraphcontext"],
      { windowsHide: true, timeout: 30_000, stdio: "ignore" }
    );
    return true;
  } catch {
    return false;
  }
}

function run(command: string, args: string[], timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error) => resolve(!error)
    );
  });
}

type Progress = vscode.Progress<{ message?: string }>;

async function prepareWithUv(
  uv: string,
  venvPath: string,
  requirementsPath: string,
  progress: Progress
): Promise<boolean> {
  const python = venvPython(venvPath);

  if (!exists(python)) {
    progress.report({ message: "creating Python environment with uv" });
    const created =
      (await run(uv, ["venv", venvPath, "--python", PYTHON_VERSION], VENV_TIMEOUT_MS)) ||
      (await run(uv, ["venv", venvPath], VENV_TIMEOUT_MS));
    if (!created || !exists(python)) {
      return false;
    }
  }

  progress.report({ message: "installing Python dependencies with uv" });
  return run(
    uv,
    ["pip", "install", "--python", python, "-r", requirementsPath],
    INSTALL_TIMEOUT_MS
  );
}

async function prepareWithPip(
  systemPython: string,
  venvPath: string,
  requirementsPath: string,
  progress: Progress
): Promise<boolean> {
  const python = venvPython(venvPath);

  if (!exists(python)) {
    progress.report({ message: "creating virtual environment" });
    if (!(await run(systemPython, ["-m", "venv", venvPath], VENV_TIMEOUT_MS))) {
      return false;
    }
    if (!exists(python)) {
      return false;
    }
  }

  progress.report({ message: "installing Python dependencies" });
  await run(python, ["-m", "pip", "install", "--upgrade", "pip"], VENV_TIMEOUT_MS);
  return run(
    python,
    ["-m", "pip", "install", "--disable-pip-version-check", "-r", requirementsPath],
    INSTALL_TIMEOUT_MS
  );
}

/**
 * Return a Python interpreter with Velocity + CodeGraphContext installed.
 * Creates the managed venv on first use. Returns "" when Python cannot be set up.
 */
export function ensureManagedPython(
  requirementsPath: string,
  options: { quiet?: boolean } = {}
): Promise<string> {
  if (cachedPython) {
    return Promise.resolve(cachedPython);
  }
  if (preparing) {
    return preparing;
  }

  preparing = (async () => {
    const uv = resolveUv();
    const systemPython = uv ? "" : resolveSystemPython();

    if (!uv && !systemPython) {
      return "";
    }
    if (systemPython && hasManagedDependencies(systemPython)) {
      cachedPython = systemPython;
      return systemPython;
    }
    if (!storageDir) {
      return "";
    }

    const venvPath = venvDir();
    const python = venvPython(venvPath);

    if (exists(python) && hasManagedDependencies(python)) {
      cachedPython = python;
      return python;
    }

    try {
      fs.mkdirSync(storageDir, { recursive: true });
    } catch {
      return "";
    }

    const install = async (progress: Progress) =>
      uv
        ? prepareWithUv(uv, venvPath, requirementsPath, progress)
        : prepareWithPip(systemPython, venvPath, requirementsPath, progress);

    const ready = options.quiet
      ? await install({ report: () => undefined })
      : await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "RC: preparing Python tools (one-time setup)…",
            cancellable: false
          },
          (progress) => install(progress)
        );

    if (!ready || !hasManagedDependencies(python)) {
      return "";
    }

    cachedPython = python;
    return python;
  })();

  preparing.finally(() => {
    preparing = undefined;
  });

  return preparing;
}

/** @deprecated Use ensureManagedPython */
export function ensureVelocityPython(requirementsPath: string): Promise<string> {
  return ensureManagedPython(requirementsPath);
}

/** Forget the cached interpreter, e.g. after a failed run. */
export function resetManagedPython(): void {
  cachedPython = undefined;
}

/** @deprecated Use resetManagedPython */
export function resetVelocityPython(): void {
  resetManagedPython();
}

const INDEX_TIMEOUT_MS = 1_800_000;
const indexJobs = new Map<string, Promise<void>>();

function cgcDatabaseArgs(): string[] {
  return process.platform === "win32" ? ["--database", "kuzudb"] : [];
}

/**
 * Kick off a background `cgc index` for a workspace. Non-blocking; safe to call
 * on every workspace open. Single-flight per root.
 */
export function scheduleCodegraphIndex(workspaceRoot: string, cgcBin: string): void {
  const root = path.resolve(workspaceRoot);
  if (!cgcBin || !exists(cgcBin) || indexJobs.has(root)) {
    return;
  }

  const job = new Promise<void>((resolve) => {
    const child = spawn(cgcBin, [...cgcDatabaseArgs(), "index", root], {
      cwd: root,
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // best effort
      }
      resolve();
    }, INDEX_TIMEOUT_MS);

    child.on("error", () => {
      clearTimeout(timer);
      resolve();
    });
    child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  }).finally(() => {
    indexJobs.delete(root);
  });

  indexJobs.set(root, job);
}
