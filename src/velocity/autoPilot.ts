import { getVelocitySettings, type VelocityMode } from "./settings";

/**
 * Auto mode trip-wire.
 *
 * The daemon owns diagnosis (context_bloat, wander, retry_loop) — but it only
 * sees traffic that already flows through it, so something has to decide when
 * to route through it in the first place. That decision is all this file does:
 * one wall-clock timer per thread. Everything downstream is the daemon's job.
 */

type ThreadState = {
  armed: boolean;
  reason: string;
  pendingNotice: string;
  slowStreak: number;
};

const threads = new Map<string, ThreadState>();

/** Reported once per session so a missing Python does not nag every turn. */
let daemonUnavailableReported = false;

/** Set from the Velocity chip; overrides the configured mode for this session. */
let modeOverride: VelocityMode | undefined;

export function setVelocityMode(mode: unknown): void {
  if (mode === "off" || mode === "auto" || mode === "on") {
    modeOverride = mode;
  }
}

function activeMode(): VelocityMode {
  return modeOverride ?? getVelocitySettings().mode;
}

function stateFor(threadId: string): ThreadState {
  let state = threads.get(threadId);
  if (!state) {
    state = { armed: false, reason: "", pendingNotice: "", slowStreak: 0 };
    threads.set(threadId, state);
  }
  return state;
}

export function resetAutoPilot(threadId: string): void {
  threads.delete(threadId);
}

/** True when this turn should be routed through the Velocity daemon. */
export function shouldUseVelocity(threadId: string): boolean {
  const mode = activeMode();
  if (mode === "off") {
    return false;
  }
  if (mode === "on") {
    return true;
  }
  return stateFor(threadId).armed;
}

/**
 * Record how long a turn took and decide whether Auto mode should hand the
 * next turn to the daemon.
 */
export function recordTurn(threadId: string, durationMs: number): void {
  const settings = getVelocitySettings();
  if (activeMode() !== "auto") {
    return;
  }

  const state = stateFor(threadId);
  if (state.armed) {
    return;
  }

  const seconds = durationMs / 1000;
  const threshold = settings.autoTriggerSeconds;

  if (seconds >= threshold) {
    state.armed = true;
    state.reason = `a turn took ${Math.round(seconds)}s`;
    state.pendingNotice =
      `Velocity engaged automatically — ${state.reason} ` +
      `(over the ${threshold}s threshold). The daemon now handles this chat.`;
    return;
  }

  // Two merely sluggish turns in a row count as much as one very slow one.
  if (seconds >= threshold * 0.6) {
    state.slowStreak++;
    if (state.slowStreak >= 2) {
      state.armed = true;
      state.reason = `two turns in a row took over ${Math.round(threshold * 0.6)}s`;
      state.pendingNotice =
        `Velocity engaged automatically — ${state.reason}. ` +
        "The daemon now handles this chat.";
    }
    return;
  }

  state.slowStreak = 0;
}

/** Take the "why did this switch on" line, if one is waiting. */
export function takeArmNotice(threadId: string): string {
  const state = stateFor(threadId);
  const notice = state.pendingNotice;
  state.pendingNotice = "";
  return notice;
}

/**
 * Auto mode wanted the daemon but could not reach it. Disarm so the thread does
 * not pay the startup cost on every turn, and surface the reason once.
 */
export function reportDaemonUnavailable(threadId: string): string {
  stateFor(threadId).armed = false;
  if (daemonUnavailableReported) {
    return "";
  }
  daemonUnavailableReported = true;
  return (
    "Velocity could not start — no Python 3.11+ found on this machine. " +
    "Install Python and RC will set up the rest by itself. " +
    "Continuing without it; set rc.velocity.mode to \"off\" to hide this."
  );
}
