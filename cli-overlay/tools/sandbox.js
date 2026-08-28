/**
 * Optional microVM sandboxing for `run_command`.
 *
 * `run_command` is an unsandboxed shell on the user's machine with the full
 * inherited environment. In `yolo` mode it is auto-approved, and `rc serve`
 * approves every tool call unconditionally, so the command string is model
 * output that reaches a real shell with no human in the loop. `cwd` is
 * confined by paths.js, but a shell command is not confined by its cwd.
 *
 * When Microsandbox is available this module runs the command inside a
 * hardware-isolated microVM with only the workspace bind-mounted. When it is
 * not available, nothing here changes behaviour: the caller falls back to the
 * existing host path and is told, in the tool result, that it did.
 *
 * The dependency is deliberately NOT declared in package.json. It is loaded by
 * dynamic import inside a try/catch, so a user who has not installed it sees a
 * plain "unsupported" verdict rather than a module-resolution error.
 *
 * Everything in this file is verified against microsandbox 0.6.15.
 */

import path, { join } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MAX_OUTPUT_BYTES = 1024 * 1024; // preserves the host path's maxBuffer
const DEFAULT_IMAGE = "alpine";
const BOOT_TIMEOUT_MS = 120_000;

/** off | auto | require — see `rc.sandbox.mode`. */
export function sandboxMode() {
  const raw = String(process.env.RC_SANDBOX || "").trim().toLowerCase();
  if (raw === "off" || raw === "auto" || raw === "require") {
    return raw;
  }
  return "auto";
}

export function sandboxImage() {
  return String(process.env.RC_SANDBOX_IMAGE || "").trim() || DEFAULT_IMAGE;
}

/** Network egress inside the VM. Default is ALLOW — see the README note. */
export function sandboxNetworkAllowed() {
  return String(process.env.RC_SANDBOX_NETWORK || "").trim().toLowerCase() !== "deny";
}

function emitEvent(name, payload) {
  if (process.env.RC_EVENTS !== "1") {
    return;
  }
  try {
    process.stderr.write(`RC_EVENT ${name} ${JSON.stringify(payload ?? {})}\n`);
  } catch {
    // never let telemetry break a run
  }
}

/**
 * Static, zero-cost gates.
 *
 * From microsandbox's own README (0.6.15): "Node.js 22+; Linux with KVM, macOS
 * with Apple Silicon, or Windows 11 with WHP enabled", and its published
 * platform packages are darwin-arm64, linux-x64-gnu, linux-arm64-gnu,
 * win32-x64-msvc and win32-arm64-msvc. macOS on Intel has no platform package
 * at all, so it is ruled out here without touching the disk.
 */
function staticVerdict() {
  if (process.platform === "darwin" && process.arch !== "arm64") {
    return { supported: false, reason: "macOS on Intel is not supported by Microsandbox (Apple Silicon only)" };
  }
  if (process.platform === "win32" && !["x64", "arm64"].includes(process.arch)) {
    return { supported: false, reason: `no Microsandbox platform package for win32-${process.arch}` };
  }
  if (process.platform === "linux" && !["x64", "arm64"].includes(process.arch)) {
    return { supported: false, reason: `no Microsandbox platform package for linux-${process.arch}` };
  }
  if (!["darwin", "linux", "win32"].includes(process.platform)) {
    return { supported: false, reason: `unsupported platform: ${process.platform}` };
  }
  return undefined;
}

/**
 * Detection state, resolved at most once per process and then cached forever.
 *
 * There is no `isSupported()` in the SDK — the only authoritative answer is
 * whether a microVM actually boots (the error codes for the failure modes are
 * `unsupported` and `libkrunfwNotFound`). So detection IS the first boot, which
 * is why it must be lazy: nothing here runs until the first `run_command`, so
 * extension activation is untouched.
 */
let detection;

/**
 * Load the optional SDK.
 *
 * Bare `import("microsandbox")` resolves upward from this file, which inside a
 * packaged extension means `vendor/rp-cli/node_modules` — not somewhere a user
 * would naturally install into. `RC_SANDBOX_MODULE` (settings:
 * `rc.sandbox.modulePath`) accepts an explicit path to the package or its
 * entry point so the install location does not have to be guessed.
 */
async function loadSdk() {
  const override = String(process.env.RC_SANDBOX_MODULE || "").trim();
  const candidates = [];
  if (override) {
    // pathToFileURL keeps Windows paths — and paths with spaces — importable.
    const asPath = path.resolve(override);
    candidates.push(pathToFileURL(existsSync(join(asPath, "package.json")) ? join(asPath, "dist", "index.js") : asPath).href);
  }
  candidates.push("microsandbox");

  let lastError = "";
  for (const candidate of candidates) {
    try {
      return await import(candidate);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { __error: lastError };
}

const NAME_PREFIX = "rc-";

function sandboxName() {
  // One sandbox per CLI process. The pid keeps concurrent `rc` processes —
  // an editor turn and an `rc serve` request — from sharing a microVM, and it
  // is what lets `reapStale()` tell an abandoned VM from a live one.
  return `${NAME_PREFIX}${process.pid}`;
}

function pidAlive(pid) {
  try {
    // Signal 0 tests for existence without touching the process.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else — still alive.
    return error?.code === "EPERM";
  }
}

/**
 * Remove microVMs left behind by `rc` processes that are no longer running.
 *
 * Teardown on exit is not reliable: `process.on("exit")` cannot await async
 * work, and cli.js calls `process.exit()` explicitly, so a hard exit or a crash
 * strands the VM. Rather than pretend the exit hook is enough, every boot first
 * sweeps up the ones whose owning pid is gone.
 */
async function reapStale(sdk) {
  try {
    // 0.6.15 returns `{ sandboxes, nextCursor }`; the array form is accepted
    // too so a future shape change degrades to reaping nothing, not throwing.
    const listed = await sdk.Sandbox.list();
    const entries = Array.isArray(listed) ? listed : (listed?.sandboxes ?? []);
    for (const entry of entries) {
      const name = typeof entry?.name === "string" ? entry.name : "";
      if (!name.startsWith(NAME_PREFIX)) {
        continue;
      }
      const pid = Number.parseInt(name.slice(NAME_PREFIX.length), 10);
      if (!Number.isFinite(pid) || pid === process.pid || pidAlive(pid)) {
        continue;
      }
      try {
        const handle = await sdk.Sandbox.get(name);
        if (handle) {
          await (await handle.connect()).kill().catch(() => undefined);
        }
      } catch {
        // already down
      }
      await sdk.Sandbox.remove(name).catch(() => undefined);
    }
  } catch {
    // Reaping is housekeeping; never let it block a command.
  }
}

/**
 * Boot the session's sandbox, or explain why it cannot be booted.
 * Cached: success and failure are both final for the life of the process.
 */
async function ensureSandbox(rootDirectory) {
  if (detection) {
    return detection;
  }

  const gate = staticVerdict();
  if (gate) {
    detection = Promise.resolve(gate);
    return detection;
  }

  detection = (async () => {
    const sdk = await loadSdk();
    if (sdk.__error) {
      return {
        supported: false,
        reason: "the optional `microsandbox` package is not installed (npm i microsandbox)"
      };
    }

    await reapStale(sdk);

    try {
      const timer = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("boot timed out")), BOOT_TIMEOUT_MS)
      );

      const build = sdk.Sandbox.builder(sandboxName())
        .image(sandboxImage())
        // The workspace, writable, and nothing else. Edits must land on the
        // host because changing the repo is the agent's whole job.
        .volume("/workspace", (mount) => mount.bind(rootDirectory))
        .network((network) =>
          sandboxNetworkAllowed() ? network : network.policy(sdk.NetworkPolicy.none())
        )
        .replace()
        .create();

      const sandbox = await Promise.race([build, timer]);
      return { supported: true, sandbox, sdk };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { supported: false, reason: `Microsandbox could not start a microVM: ${message}` };
    }
  })();

  return detection;
}

function truncate(text) {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= MAX_OUTPUT_BYTES) {
    return text;
  }
  return `${buffer.subarray(0, MAX_OUTPUT_BYTES).toString("utf8")}\n… [output truncated at ${MAX_OUTPUT_BYTES} bytes]`;
}

/**
 * Run one command inside the session sandbox.
 *
 * The command string is model output, so it is never interpolated into a host
 * shell string. It is passed as a single argv element to `sh -c` *inside the
 * guest*, which is the isolation boundary: `argv = ["-c", command]`.
 */
export async function runSandboxed(command, rootDirectory, signal, timeoutMs) {
  const state = await ensureSandbox(rootDirectory);
  if (!state.supported) {
    return state;
  }

  const { sandbox } = state;
  let handle;
  const onAbort = () => {
    handle?.kill().catch(() => undefined);
  };

  try {
    handle = await sandbox.execStreamWith("sh", (exec) => {
      let builder = exec.args(["-c", command]).cwd("/workspace");
      if (timeoutMs > 0) {
        builder = builder.timeout(timeoutMs);
      }
      return builder;
    });

    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener?.("abort", onAbort, { once: true });
    }

    const output = await handle.collect();
    return {
      supported: true,
      ok: true,
      code: output.code,
      stdout: truncate(output.stdout()),
      stderr: truncate(output.stderr())
    };
  } finally {
    signal?.removeEventListener?.("abort", onAbort);
  }
}

/**
 * Tear the sandbox down. Called on process exit and on cancellation, so an
 * aborted turn does not leave a microVM running.
 */
export async function shutdownSandbox() {
  if (!detection) {
    return;
  }
  let state;
  try {
    state = await detection;
  } catch {
    return;
  }
  if (!state?.supported || !state.sandbox) {
    return;
  }
  try {
    await state.sandbox.kill();
  } catch {
    // best effort
  }
  try {
    await state.sdk.Sandbox.remove(sandboxName());
  } catch {
    // best effort
  }
}

let exitHooked = false;
export function hookShutdown() {
  if (exitHooked) {
    return;
  }
  exitHooked = true;
  const bail = () => {
    void shutdownSandbox();
  };
  process.once("exit", bail);
  process.once("SIGINT", bail);
  process.once("SIGTERM", bail);
}

export { emitEvent };
