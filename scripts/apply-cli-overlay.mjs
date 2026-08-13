import { cpSync, existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extRoot = join(__dirname, "..");
const require = createRequire(join(extRoot, "package.json"));
const vendorRoot = join(extRoot, "vendor", "rp-cli");

function resolvePackageRoot() {
  try {
    return dirname(require.resolve("@rezaparsian/rp-cli/package.json"));
  } catch {
    return undefined;
  }
}

const pkgRoot = resolvePackageRoot();
if (!pkgRoot) {
  console.error("[prepare-cli] Missing @rezaparsian/rp-cli. Run: npm install --legacy-peer-deps");
  process.exit(1);
}

const overlayCli = join(extRoot, "cli-overlay", "cli.js");
const overlayPlain = join(extRoot, "cli-overlay", "actions", "plainPrompt.js");
if (!existsSync(overlayCli) || !existsSync(overlayPlain)) {
  console.error("[prepare-cli] cli-overlay files are missing.");
  process.exit(1);
}

// Apply overlay into installed package (for local F5 / development)
const targetActions = join(pkgRoot, "dist", "source", "actions");
mkdirSync(targetActions, { recursive: true });
cpSync(overlayCli, join(pkgRoot, "dist", "source", "cli.js"));
cpSync(overlayPlain, join(targetActions, "plainPrompt.js"));

// Build a self-contained vendor copy for the VSIX (works on any machine)
rmSync(vendorRoot, { recursive: true, force: true });
mkdirSync(vendorRoot, { recursive: true });

const pkgJson = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
writeFileSync(
  join(vendorRoot, "package.json"),
  JSON.stringify(
    {
      name: pkgJson.name,
      version: pkgJson.version,
      type: pkgJson.type || "module",
      bin: pkgJson.bin,
      dependencies: pkgJson.dependencies || {},
      engines: pkgJson.engines
    },
    null,
    2
  )
);

cpSync(join(pkgRoot, "dist"), join(vendorRoot, "dist"), { recursive: true });
// Ensure overlay is present in vendor too
mkdirSync(join(vendorRoot, "dist", "source", "actions"), { recursive: true });
cpSync(overlayCli, join(vendorRoot, "dist", "source", "cli.js"));
cpSync(overlayPlain, join(vendorRoot, "dist", "source", "actions", "plainPrompt.js"));

console.log("[prepare-cli] Installing production deps into vendor/rp-cli ...");
execSync("npm install --omit=dev --legacy-peer-deps", {
  cwd: vendorRoot,
  stdio: "inherit",
  shell: true
});

console.log(`[prepare-cli] Ready: ${join(vendorRoot, "dist", "source", "cli.js")}`);
