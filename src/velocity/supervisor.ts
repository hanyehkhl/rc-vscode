import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { resolveCliJsPath, resolveDeepSeekToken, resolveNodePath } from "../rcProcess";
import { getVelocitySettings, velocityDaemonUrl } from "./settings";
import { ensureVelocityPython } from "./pythonEnv";

type ManagedProcess = {
  child: ChildProcess;
  label: string;
};

let serveProcess: ManagedProcess | undefined;
let daemonProcess: ManagedProcess | undefined;
let starting: Promise<boolean> | undefined;

function existsFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function extensionRoot(): string {
  return path.resolve(__dirname, "..", "..");
}

function daemonRoot(): string {
  return path.join(extensionRoot(), "velocity-daemon");
}


function waitForHealth(url: string, timeoutMs = 20_000): Promise<boolean> {
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const request = http.get(`${url}/health`, (response) => {
        response.resume();
        if (response.statusCode === 200) {
          resolve(true);
          return;
        }
        retry();
      });
      request.on("error", retry);
      request.setTimeout(1500, () => {
        request.destroy();
        retry();
      });
    };

    const retry = () => {
      if (Date.now() - started >= timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(tick, 400);
    };

    tick();
  });
}

function spawnManaged(
  label: string,
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv }
): ManagedProcess {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: "ignore"
  });
  return { child, label };
}

function killManaged(managed: ManagedProcess | undefined): void {
  if (!managed?.child.pid) {
    return;
  }
  try {
    if (process.platform === "win32") {
      const { execFileSync } = require("child_process") as typeof import("child_process");
      execFileSync("taskkill", ["/pid", String(managed.child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore"
      });
    } else {
      process.kill(-managed.child.pid, "SIGTERM");
    }
  } catch {
    try {
      managed.child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
}

export async function ensureVelocityStack(): Promise<boolean> {
  if (starting) {
    return starting;
  }

  starting = (async () => {
    const settings = getVelocitySettings();
    const daemonUrl = velocityDaemonUrl(settings.daemonPort);
    if (await waitForHealth(daemonUrl, 1200)) {
      return true;
    }

    const nodePath = resolveNodePath();
    const cliJs = resolveCliJsPath();
    const token = resolveDeepSeekToken();
    if (!nodePath || !cliJs || !token) {
      return false;
    }

    // Builds a private virtualenv on first use, so the user never has to run
    // pip themselves. Returns "" only when Python itself is missing.
    const pythonPath = await ensureVelocityPython(
      path.join(daemonRoot(), "requirements.txt")
    );
    if (!pythonPath) {
      return false;
    }

    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
    const serveUrl = `http://127.0.0.1:${settings.servePort}`;
    if (!(await waitForHealth(serveUrl, 1200))) {
      serveProcess = spawnManaged(
        "rc-serve",
        nodePath,
        [cliJs, "serve", "--host", "127.0.0.1", "--port", String(settings.servePort)],
        {
          cwd,
          env: {
            ...process.env,
            DEEPSEEK_TOKEN: token
          }
        }
      );
      if (!(await waitForHealth(serveUrl, 20_000))) {
        return false;
      }
    }

    const daemonEnv = {
      ...process.env,
      RC_VELOCITY_PORT: String(settings.daemonPort),
      RC_VELOCITY_HOST: "127.0.0.1",
      RC_VELOCITY_RC_SERVE_URL: serveUrl,
      RC_VELOCITY_NODE_PATH: nodePath,
      RC_VELOCITY_CLI_PATH: cliJs,
      RC_VELOCITY_TOKEN: token,
      DEEPSEEK_TOKEN: token,
      RC_VELOCITY_CWD: cwd,
      PYTHONPATH: daemonRoot()
    };

    daemonProcess = spawnManaged(
      "velocity-daemon",
      pythonPath,
      ["-m", "velocity.api.app"],
      {
        cwd: daemonRoot(),
        env: daemonEnv
      }
    );

    return waitForHealth(daemonUrl, 20_000);
  })();

  try {
    return await starting;
  } finally {
    starting = undefined;
  }
}

export async function stopVelocityStack(): Promise<void> {
  killManaged(daemonProcess);
  killManaged(serveProcess);
  daemonProcess = undefined;
  serveProcess = undefined;
}

export async function isVelocityDaemonHealthy(): Promise<boolean> {
  const settings = getVelocitySettings();
  return waitForHealth(velocityDaemonUrl(settings.daemonPort), 1200);
}
