import * as vscode from "vscode";

export type VelocityMode = "off" | "auto" | "on";

export type VelocitySettings = {
  mode: VelocityMode;
  enabled: boolean;
  daemonPort: number;
  servePort: number;
  stream: boolean;
  autoTriggerSeconds: number;
};

function resolveMode(config: vscode.WorkspaceConfiguration): VelocityMode {
  const mode = config.get<string>("mode", "auto");
  if (mode === "off" || mode === "auto" || mode === "on") {
    return mode;
  }
  // Back-compat with the original boolean toggle.
  return config.get<boolean>("enabled", false) ? "on" : "auto";
}

export function getVelocitySettings(): VelocitySettings {
  const config = vscode.workspace.getConfiguration("rc.velocity");
  const mode = resolveMode(config);
  return {
    mode,
    enabled: mode === "on",
    daemonPort: config.get<number>("daemonPort", 8790),
    servePort: config.get<number>("servePort", 3001),
    stream: config.get<boolean>("stream", true),
    autoTriggerSeconds: Math.max(5, config.get<number>("autoTriggerSeconds", 25))
  };
}

export function velocityDaemonUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}
