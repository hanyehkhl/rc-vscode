import { chmodSync, createWriteStream, existsSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { pipeline } from "node:stream/promises";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";

const VERSION = "v20.18.2";
const __dirname = dirname(fileURLToPath(import.meta.url));
const extRoot = join(__dirname, "..");
const vendorNode = join(extRoot, "vendor", "node");

const targets = [
  {
    key: "win32-x64",
    archive: `node-${VERSION}-win-x64.zip`,
    member: `node-${VERSION}-win-x64/node.exe`,
    out: "node.exe"
  },
  {
    key: "linux-x64",
    archive: `node-${VERSION}-linux-x64.tar.gz`,
    member: `node-${VERSION}-linux-x64/bin/node`,
    out: "node"
  },
  {
    key: "linux-arm64",
    archive: `node-${VERSION}-linux-arm64.tar.gz`,
    member: `node-${VERSION}-linux-arm64/bin/node`,
    out: "node"
  },
  {
    key: "darwin-x64",
    archive: `node-${VERSION}-darwin-x64.tar.gz`,
    member: `node-${VERSION}-darwin-x64/bin/node`,
    out: "node"
  },
  {
    key: "darwin-arm64",
    archive: `node-${VERSION}-darwin-arm64.tar.gz`,
    member: `node-${VERSION}-darwin-arm64/bin/node`,
    out: "node"
  }
];

async function download(url, dest) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Download failed ${response.status} ${url}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(dest));
}

function extractMember(archivePath, member, destFile) {
  const work = join(tmpdir(), `rc-node-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(work, { recursive: true });
  try {
    execFileSync("tar", ["-xf", archivePath, "-C", work, member], { stdio: "inherit" });
    const extracted = join(work, ...member.split("/"));
    if (!existsSync(extracted)) {
      throw new Error(`Missing ${member} in ${archivePath}`);
    }
    mkdirSync(dirname(destFile), { recursive: true });
    copyFileSync(extracted, destFile);
    if (!destFile.endsWith(".exe")) {
      chmodSync(destFile, 0o755);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const cacheDir = join(extRoot, "vendor", ".node-cache");
mkdirSync(cacheDir, { recursive: true });

for (const target of targets) {
  const dest = join(vendorNode, target.key, target.out);
  if (existsSync(dest)) {
    console.log(`[bundle-node] exists ${target.key}`);
    continue;
  }

  const url = `https://nodejs.org/dist/${VERSION}/${target.archive}`;
  const archivePath = join(cacheDir, target.archive);
  if (!existsSync(archivePath)) {
    console.log(`[bundle-node] downloading ${target.archive}`);
    await download(url, archivePath);
  }

  console.log(`[bundle-node] extracting ${target.key}`);
  extractMember(archivePath, target.member, dest);
}

console.log("[bundle-node] done");
