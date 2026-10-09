import { execFile, spawn } from "child_process";
import { randomBytes } from "crypto";
import * as path from "path";

/**
 * Running Hermes Agent inside a Docker container (e.g. the official
 * nousresearch/hermes-agent image from a compose stack) instead of a local CLI.
 *
 * - The turn runs through `docker exec -i`, with secrets passed as `-e NAME`
 *   (value taken from our environment) so they never appear in argv.
 * - Loopback URLs are rewritten to host.docker.internal; Docker Desktop
 *   forwards that to the host's 127.0.0.1, so the gateway can stay loopback-only.
 * - The host workspace path is translated with user path mappings; with no
 *   mapping Hermes works in its own container workspace.
 * - Killing `docker exec` does not stop the process inside the container, so
 *   the wrapper records its PID and cancellation kills it explicitly.
 */

export const HERMES_IMAGE = "nousresearch/hermes-agent";

function run(command: string, args: string[], timeoutMs = 8_000): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: timeoutMs }, (error, stdout) => {
      resolve(error ? undefined : stdout.toString());
    });
  });
}

/** Name of a running container built from the Hermes Agent image, if any. */
export async function detectHermesContainer(): Promise<string | undefined> {
  const out = await run("docker", ["ps", "--format", "{{.Names}}\t{{.Image}}"]);
  if (!out) return undefined;
  for (const line of out.split(/\r?\n/)) {
    const [name, image] = line.trim().split("\t");
    if (name && image && image.split(":")[0].endsWith(HERMES_IMAGE)) return name;
  }
  return undefined;
}

export async function isContainerRunning(name: string): Promise<boolean> {
  const out = await run("docker", ["inspect", "-f", "{{.State.Running}}", name]);
  return out?.trim() === "true";
}

export function isLoopbackUrl(url: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?=[:/]|$)/i.test(url);
}

/** Rewrites loopback hosts so a URL on the host is reachable from a container. */
export function toContainerUrl(url: string, host = "host.docker.internal"): string {
  return url.replace(/^(https?:\/\/)(127\.0\.0\.1|localhost|\[::1\])(?=[:/]|$)/i, `$1${host}`);
}

/**
 * How a container reaches a service that listens on this machine.
 *
 * - Docker Desktop (Windows, macOS, and Docker Desktop for Linux) forwards
 *   host.docker.internal to the host's loopback, so a 127.0.0.1 listener works.
 * - Docker Engine on Linux has no such forwarding: the container reaches the
 *   host through its network's bridge gateway (e.g. 172.18.0.1), so the
 *   service must also listen on that address (`bindHost`).
 * - A container on the host network shares the host's loopback.
 */
export type HostRoute = { host: string; bindHost?: string };

type Runner = (command: string, args: string[]) => Promise<string | undefined>;

export async function containerHostRoute(container: string, platform: string = process.platform, exec: Runner = run): Promise<HostRoute> {
  if (platform === "win32" || platform === "darwin") return { host: "host.docker.internal" };
  const info = await exec("docker", ["info", "--format", "{{.OperatingSystem}}"]);
  if (info && /docker desktop/i.test(info)) return { host: "host.docker.internal" };
  const mode = (await exec("docker", ["inspect", "-f", "{{.HostConfig.NetworkMode}}", container]))?.trim();
  if (mode === "host") return { host: "127.0.0.1" };
  const gateways = await exec("docker", ["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.Gateway}} {{end}}", container]);
  const ip = gateways?.split(/\s+/).find((g) => /^\d+\.\d+\.\d+\.\d+$/.test(g));
  return ip ? { host: ip, bindHost: ip } : { host: "host.docker.internal" };
}

function normalizeHostPath(p: string, caseInsensitive: boolean): string {
  const normal = path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
  return caseInsensitive ? normal.toLowerCase() : normal;
}

/**
 * Maps a host path into the container using `{ hostPrefix: containerPrefix }`
 * entries; the longest matching prefix wins. Returns undefined when unmapped.
 * Matching ignores case only where the host file system does (Windows).
 */
export function mapPathIntoContainer(
  hostPath: string,
  mappings: Record<string, string>,
  caseInsensitive = process.platform === "win32"
): string | undefined {
  const target = normalizeHostPath(hostPath, caseInsensitive);
  let best: { host: string; container: string } | undefined;
  for (const [host, container] of Object.entries(mappings)) {
    if (!host.trim() || typeof container !== "string" || !container.trim()) continue;
    const prefix = normalizeHostPath(host, caseInsensitive);
    if ((target === prefix || target.startsWith(`${prefix}/`)) && (!best || prefix.length > best.host.length)) {
      best = { host: prefix, container: container.trim().replace(/\/+$/, "") };
    }
  }
  if (!best) return undefined;
  // Keep the original casing of the remainder (Linux paths are case-sensitive).
  const original = path.resolve(hostPath).replace(/\\/g, "/").replace(/\/+$/, "");
  const rest = original.slice(best.host.length);
  return `${best.container}${rest}` || "/";
}

export type DockerInvocation = { command: string; args: string[]; turnId: string };

/**
 * Builds `docker exec` for one Hermes turn. `envNames` are forwarded by name
 * (`-e NAME`), so their values must be set in the spawn environment.
 */
export function dockerExecInvocation(container: string, hermesArgs: string[], envNames: string[]): DockerInvocation {
  const turnId = randomBytes(6).toString("hex");
  const args = ["exec", "-i"];
  for (const name of envNames) args.push("-e", name);
  // `exec "$@"` keeps the recorded PID equal to Hermes' own PID.
  args.push(container, "sh", "-c", `echo $$ > /tmp/rc-hermes-${turnId}.pid; exec "$@"`, "sh", "hermes", ...hermesArgs);
  return { command: "docker", args, turnId };
}

/** Kills the in-container Hermes process of a turn (best effort). */
export function killContainerTurn(container: string, turnId: string): void {
  const file = `/tmp/rc-hermes-${turnId}.pid`;
  spawn(
    "docker",
    ["exec", container, "sh", "-c", `p=$(cat ${file} 2>/dev/null) && kill -TERM $p 2>/dev/null; sleep 2; [ -n "$p" ] && kill -KILL $p 2>/dev/null; rm -f ${file}`],
    { windowsHide: true, stdio: "ignore" }
  ).on("error", () => undefined);
}

export function cleanupContainerTurn(container: string, turnId: string): void {
  spawn("docker", ["exec", container, "rm", "-f", `/tmp/rc-hermes-${turnId}.pid`], { windowsHide: true, stdio: "ignore" }).on(
    "error",
    () => undefined
  );
}
