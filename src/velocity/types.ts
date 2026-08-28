export type VelocityFinding = {
  id: string;
  severity: "info" | "amber" | "red";
  evidence: string;
  remedy: string;
};

export type VelocityChatResult = {
  ok: boolean;
  cancelled?: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  findings: VelocityFinding[];
  streamed?: boolean;
};

export type VelocityPromptOptions = {
  mode: "ask" | "write" | "auto";
  search: boolean;
  thinkingEffort: "off" | "low" | "medium" | "hard";
  history: Array<{ role: "user" | "assistant"; content: string }>;
  threadId: string;
  onStatus?: (text: string) => void;
  onChunk?: (text: string) => void;
  signal?: AbortSignal;
};
