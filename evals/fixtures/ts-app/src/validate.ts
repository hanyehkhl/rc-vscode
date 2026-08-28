import type { Priority } from "./task.js";

export const MAX_TITLE_LENGTH = 120;

export function isPriority(value: string): value is Priority {
  return value === "low" || value === "normal" || value === "high";
}

/** Returns an error message, or null when the title is acceptable. */
export function validateTitle(title: string): string | null {
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    return "Title must not be empty.";
  }
  if (trimmed.length > MAX_TITLE_LENGTH) {
    return `Title must be at most ${MAX_TITLE_LENGTH} characters.`;
  }
  return null;
}
