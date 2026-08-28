#!/usr/bin/env node
/** Remove leftover sandboxes. Safe to run at any time; seeds are rebuilt. */
import fs from "node:fs";
import { defaultWorkDir, wipeWorkDir } from "./lib/workspace.mjs";

const dir = process.argv[2] ? process.argv[2] : defaultWorkDir();
if (!fs.existsSync(dir)) {
  console.log(`nothing to clean at ${dir}`);
} else if (wipeWorkDir(dir)) {
  console.log(`removed ${dir}`);
} else {
  console.log(`could not fully remove ${dir} — a process may still hold a file open`);
  process.exitCode = 1;
}
