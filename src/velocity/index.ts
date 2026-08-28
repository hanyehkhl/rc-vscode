import { getVelocitySettings } from "./settings";
import { runVelocityPrompt, clearVelocityThread } from "./client";
import { ensureVelocityStack, isVelocityDaemonHealthy } from "./supervisor";
import type { VelocityChatResult, VelocityPromptOptions } from "./types";

export { clearVelocityThread, ensureVelocityStack, isVelocityDaemonHealthy, runVelocityPrompt };
export type { VelocityChatResult, VelocityFinding, VelocityPromptOptions } from "./types";

export function isVelocityEnabled(): boolean {
  return getVelocitySettings().enabled;
}

export function createThreadId(): string {
  return `thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
