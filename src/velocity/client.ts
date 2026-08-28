import { buildPromptWithHistory, resolveDeepSeekToken, type ChatTurn } from "../rcProcess";
import { buildWorkspaceContext } from "../workspaceContext";
import { getAgentSettings } from "../agentRunner";
import { ensureVelocityStack } from "./supervisor";
import { getVelocitySettings, velocityDaemonUrl } from "./settings";
import type { VelocityChatResult, VelocityFinding, VelocityPromptOptions } from "./types";

function findingsText(findings: VelocityFinding[]): string {
  if (!findings.length) {
    return "";
  }
  const top = findings[0];
  return `Velocity: ${top.evidence}${top.remedy ? ` — ${top.remedy}` : ""}`;
}

function extractDeltaContent(previous: string, next: string): string {
  if (next.startsWith(previous)) {
    return next.slice(previous.length);
  }
  return next;
}

export async function runVelocityPrompt(
  prompt: string,
  options: VelocityPromptOptions
): Promise<VelocityChatResult> {
  const settings = getVelocitySettings();
  const ready = await ensureVelocityStack();
  if (!ready) {
    return {
      ok: false,
      stdout: "",
      stderr: "Velocity daemon is not available. Falling back to standard RC.",
      code: 1,
      findings: []
    };
  }

  const withHistory = buildPromptWithHistory(prompt, options.history as ChatTurn[]);
  // Velocity takes a different transport but needs the same editor context.
  const contextBlock = getAgentSettings().editorContext ? await buildWorkspaceContext() : "";
  const fullPrompt = contextBlock ? `${contextBlock}

---

${withHistory}` : withHistory;
  const baseUrl = velocityDaemonUrl(settings.daemonPort);
  const body = {
    model: "rc-default",
    messages: [{ role: "user", content: fullPrompt }],
    stream: settings.stream,
    mode: options.mode,
    search: options.search,
    thinking_effort: options.thinkingEffort,
    thread_id: options.threadId,
    velocity: true
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-RC-Thread-Id": options.threadId
  };
  const token = resolveDeepSeekToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  if (settings.stream) {
    const streamed = await streamCompletion(baseUrl, body, headers, options);
    if (streamed.ok || streamed.code !== 1 || streamed.stderr) {
      return streamed;
    }
  }

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: options.signal
  });

  if (!response.ok) {
    const text = await response.text();
    return {
      ok: false,
      stdout: "",
      stderr: text || `Velocity request failed (${response.status}).`,
      code: response.status,
      findings: []
    };
  }

  const data = (await response.json()) as {
    content?: string;
    findings?: VelocityFinding[];
    stderr?: string;
  };
  const findings = data.findings || [];
  if (findings.length) {
    options.onStatus?.(findingsText(findings));
  }
  const content = (data.content || "").trim();
  return {
    ok: Boolean(content),
    stdout: content,
    stderr: data.stderr || "",
    code: content ? 0 : 1,
    findings
  };
}

async function streamCompletion(
  baseUrl: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  options: VelocityPromptOptions
): Promise<VelocityChatResult> {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: options.signal
  });

  if (!response.ok || !response.body) {
    const text = await response.text();
    return {
      ok: false,
      stdout: "",
      stderr: text || `Velocity stream failed (${response.status}).`,
      code: response.status,
      findings: []
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let findings: VelocityFinding[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";

    for (const part of parts) {
      for (const line of part.split("\n")) {
        if (!line.startsWith("data:")) {
          continue;
        }
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") {
          continue;
        }
        try {
          const data = JSON.parse(payload) as {
            velocity_findings?: VelocityFinding[];
            choices?: Array<{ delta?: { content?: string } }>;
          };
          if (data.velocity_findings) {
            findings = data.velocity_findings;
            if (findings.length) {
              options.onStatus?.(findingsText(findings));
            }
            continue;
          }
          const delta = data.choices?.[0]?.delta?.content || "";
          if (delta) {
            const next = content + delta;
            const piece = extractDeltaContent(content, next);
            content = next;
            if (piece) {
              options.onChunk?.(piece);
            }
          }
        } catch {
          // ignore malformed chunks
        }
      }
    }
  }

  return {
    ok: Boolean(content.trim()),
    stdout: content.trim(),
    stderr: "",
    code: content.trim() ? 0 : 1,
    findings,
    streamed: true
  };
}

export async function clearVelocityThread(threadId: string): Promise<void> {
  const settings = getVelocitySettings();
  const baseUrl = velocityDaemonUrl(settings.daemonPort);
  try {
    await fetch(`${baseUrl}/velocity/thread/${encodeURIComponent(threadId)}`, {
      method: "DELETE"
    });
  } catch {
    // ignore
  }
}
