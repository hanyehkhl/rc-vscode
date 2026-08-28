import { execFile, execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

/**
 * Self-contained Python environment for the Velocity daemon.
 *
 * Asking the user to run `pip install` before a feature works is not acceptable
 * for an extension, and installing into their system Python would be rude. So
 * the first time Velocity is needed we build a private environment under the
 * extension's global storage.
 *
 * `uv` is used when available: it is far faster than pip and can provision a
 * Python interpreter itself, so Velocity works even on a machine with no Python
 * installed. Plain `venv` + `pip` remains the fallback.
 */

const PYTHON_VERSION = "3.12";
const VENV_TIMEOUT_MS = 300_000;
const INSTALL_TIMEOUT_MS = 600_000;

let storageDir: string | undefined;
let cachedPython: string | undefined;
let preparing: Promise<string> | undefined;

export function setVelocityStoragePath(dir: string): void {
  storageDir = dir;
}

function exists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function venvPython(venvDir: string): string {
  return process.platform === "win32"
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");
}

/** Locate `uv`, including the install locations that are not on a GUI PATH. */
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

  // Fall back to whatever is on PATH.
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

function hasDependencies(pythonPath: string): boolean {
  try {
    execFileSync(pythonPath, ["-c", "import fastapi, uvicorn, httpx, pydantic"], {
      windowsHide: true,
      timeout: 15_000,
      stdio: "ignore"
    });
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

/** uv path: provisions Python if needed, then installs into the venv. */
async function prepareWithUv(
  uv: string,
  venvDir: string,
  requirementsPath: string,
  progress: Progress
): Promise<boolean> {
  const python = venvPython(venvDir);

  if (!exists(python)) {
    progress.report({ message: "creating environment with uv" });
    // uv downloads a matching interpreter when the machine has none.
    const created =
      (await run(uv, ["venv", venvDir, "--python", PYTHON_VERSION], VENV_TIMEOUT_MS)) ||
      (await run(uv, ["venv", venvDir], VENV_TIMEOUT_MS));
    if (!created || !exists(python)) {
      return false;
    }
  }

  progress.report({ message: "installing dependencies with uv" });
  return run(
    uv,
    ["pip", "install", "--python", python, "-r", requirementsPath],
    INSTALL_TIMEOUT_MS
  );
}

/** Fallback path when uv is not installed. */
async function prepareWithPip(
  systemPython: string,
  venvDir: string,
  requirementsPath: string,
  progress: Progress
): Promise<boolean> {
  const python = venvPython(venvDir);

  if (!exists(python)) {
    progress.report({ message: "creating virtual environment" });
    if (!(await run(systemPython, ["-m", "venv", venvDir], VENV_TIMEOUT_MS))) {
      return false;
    }
    if (!exists(python)) {
      return false;
    }
  }

  progress.report({ message: "installing dependencies" });
  // Upgrading pip first avoids resolver failures on older interpreters.
  await run(python, ["-m", "pip", "install", "--upgrade", "pip"], VENV_TIMEOUT_MS);
  return run(
    python,
    ["-m", "pip", "install", "--disable-pip-version-check", "-r", requirementsPath],
    INSTALL_TIMEOUT_MS
  );
}

/**
 * Return a Python interpreter that can run the daemon, creating the environment
 * on first use. Returns "" when neither uv nor a system Python is available.
 */
export function ensureVelocityPython(requirementsPath: string): Promise<string> {
  if (cachedPython) {
    return Promise.resolve(cachedPython);
  }
  if (preparing) {
    return preparing;
  }

  preparing = (async () => {
    const uv = resolveUv();
    const systemPython = uv ? "" : resolveSystemPython();

    // Without uv we need a system Python both to build the venv and as a
    // possible ready-made environment.
    if (!uv && !systemPython) {
      return "";
    }
    if (systemPython && hasDependencies(systemPython)) {
      cachedPython = systemPython;
      return systemPython;
    }
    if (!storageDir) {
      return "";
    }

    const venvDir = path.join(storageDir, "velocity-venv");
    const python = venvPython(venvDir);

    if (exists(python) && hasDependencies(python)) {
      cachedPython = python;
      return python;
    }

    try {
      fs.mkdirSync(storageDir, { recursive: true });
    } catch {
      return "";
    }

    const ready = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "RC: preparing Velocity (one-time setup)…",
        cancellable: false
      },
      (progress) =>
        uv
          ? prepareWithUv(uv, venvDir, requirementsPath, progress)
          : prepareWithPip(systemPython, venvDir, requirementsPath, progress)
    );

    if (!ready || !hasDependencies(python)) {
      return "";
    }

    cachedPython = python;
    return python;
  })();

  // Clear the latch once settled so a failed attempt can be retried later.
  preparing.finally(() => {
    preparing = undefined;
  });

  return preparing;
}

/** Forget the cached interpreter, e.g. after a failed run. */
export function resetVelocityPython(): void {
  cachedPython = undefined;
}
