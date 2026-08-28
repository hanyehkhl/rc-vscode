/**
 * Token redaction.
 *
 * Every raw request and response is persisted to disk so a suite can be
 * re-scored offline. That makes redaction load-bearing rather than cosmetic:
 * the DeepSeek token is passed to the CLI through the environment, and a
 * captured environment or an error message that echoes it would put a live
 * credential into a JSON file that is meant to be diffed and shared.
 */

const secrets = new Set();

/** Register a value that must never reach disk. Safe to call repeatedly. */
export function registerSecret(value) {
  const trimmed = String(value ?? "").trim();
  // Very short values would redact half the corpus; a real token is long.
  if (trimmed.length >= 8) {
    secrets.add(trimmed);
  }
}

/** Env var names whose values are dropped wholesale from captured envs. */
const SECRET_KEY = /token|secret|password|passwd|api[_-]?key|cookie|auth/i;

export function redact(text) {
  let out = String(text ?? "");
  for (const secret of secrets) {
    // No regex: the token may contain characters that mean something in one.
    out = out.split(secret).join("[REDACTED]");
  }
  return out;
}

/** Deep-redact a JSON-serializable value, dropping secret-looking keys. */
export function redactValue(value) {
  if (typeof value === "string") {
    return redact(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redactValue(item);
    }
    return out;
  }
  return value;
}

/** The environment as captured into a result file. Values are never trusted. */
export function redactEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    out[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redact(value);
  }
  return out;
}
