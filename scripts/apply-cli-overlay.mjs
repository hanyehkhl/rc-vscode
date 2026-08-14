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

function patchChatJs(chatJsPath) {
  if (!existsSync(chatJsPath)) {
    console.warn(`[prepare-cli] Chat.js not found: ${chatJsPath}`);
    return;
  }

  const src = readFileSync(chatJsPath, "utf8");
  if (src.includes("RC_THINKING_EFFORT")) {
    return;
  }

  const oldSig = `export default async function chat({ token, model_type = 'default', thinking_enabled = false, search_enabled = false, challenge, sessionId, parentMessageId, prompt, onChunk, logFn, signal, }) {
    if (thinking_enabled && model_type === 'vision')
        throw new Error('This feature is not available for vision models');
    if (search_enabled && model_type !== 'default')
        throw new Error('Search is only supported in default model mode');`;

  const newSig = `export default async function chat({ token, model_type = 'default', thinking_enabled = false, search_enabled = false, challenge, sessionId, parentMessageId, prompt, onChunk, logFn, signal, }) {
    const envModel = (process.env.RC_MODEL_TYPE || '').trim();
    if (envModel === 'expert' || envModel === 'default' || envModel === 'vision') {
        model_type = envModel;
    }
    const thinkingEffort = (process.env.RC_THINKING_EFFORT || '').trim();
    if (thinking_enabled && model_type === 'vision')
        throw new Error('This feature is not available for vision models');
    if (search_enabled && model_type !== 'default')
        model_type = 'default';`;

  const oldBody = `                thinking_enabled,
                search_enabled,
                ref_file_ids: [],`;

  const newBody = `                thinking_enabled,
                search_enabled,
                thinking_mode: thinkingEffort || undefined,
                reasoning_effort: thinkingEffort || undefined,
                ref_file_ids: [],`;

  if (!src.includes(oldSig) || !src.includes(oldBody)) {
    console.warn("[prepare-cli] Chat.js patch skipped (upstream Chat.js changed)");
    return;
  }

  writeFileSync(chatJsPath, src.replace(oldSig, newSig).replace(oldBody, newBody));
  console.log(`[prepare-cli] Patched thinking effort into ${chatJsPath}`);
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
patchChatJs(join(pkgRoot, "dist", "core-lib", "Chat.js"));

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
