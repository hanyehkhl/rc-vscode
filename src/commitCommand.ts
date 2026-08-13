import { runRcCommit } from "./terminalRunner";

export function generateCommit(all = false): void {
  runRcCommit(all);
}
