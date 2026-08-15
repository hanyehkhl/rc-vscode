import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
  copyFileSync,
} from "node:fs";
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
    out: "node.exe",
  },
  {
    key: "linux-x64",
    archive: `node-${VERSION}-linux-x64.tar.gz`,
    member: `node-${VERSION}-linux-x64/bin/node`,
    out: "node",
  },
  {
    key: "linux-arm64",
    archive: `node-${VERSION}-linux-arm64.tar.gz`,
    member: `node-${VERSION}-linux-arm64/bin/node`,
    out: "node",
  },
  {
    key: "darwin-x64",
    archive: `node-${VERSION}-darwin-x64.tar.gz`,
    member: `node-${VERSION}-darwin-x64/bin/node`,
    out: "node",
  },
  {
    key: "darwin-arm64",
    archive: `node-${VERSION}-darwin-arm64.tar.gz`,
    member: `node-${VERSION}-darwin-arm64/bin/node`,
    out: "node",
  },
];

async function download(url, dest) {
  const response = await fetch(url);

  if (!response.ok || !response.body) {
    throw new Error(`Download failed ${response.status} ${url}`);
  }

  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(dest)
  );
}

function extractZipWindows(archivePath, work) {
  const command =
    `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' ` +
    `-DestinationPath '${work.replace(/'/g, "''")}' -Force`;

  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      command,
    ],
    {
      stdio: "inherit",
    }
  );
}

function extractTar(archivePath, work, member) {
  // NOTE: "--force-local" is a GNU-tar-only flag. On Windows the built-in
  // "tar.exe" is actually bsdtar (libarchive), which does not understand
  // this flag and fails immediately. Since we only ever extract local
  // archives (never remote host:path specs), it's safe to drop it entirely
  // for both GNU tar and bsdtar.
  execFileSync(
    "tar",
    [
      "-xzf",
      archivePath,
      "-C",
      work,
      member,
    ],
    {
      stdio: "inherit",
    }
  );
}

function extractMember(archivePath, member, destFile) {
  const work = join(
    tmpdir(),
    `rc-node-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );

  mkdirSync(work, { recursive: true });

  try {
    const isWindows = process.platform === "win32";
    const isZip = archivePath.toLowerCase().endsWith(".zip");

    if (isWindows && isZip) {
      console.log("[bundle-node] extracting ZIP with PowerShell");
      extractZipWindows(archivePath, work);
    } else {
      console.log("[bundle-node] extracting TAR.GZ with tar");
      extractTar(archivePath, work, member);
    }

    const extracted = join(
      work,
      ...member.split("/")
    );

    if (!existsSync(extracted)) {
      throw new Error(
        `Missing ${member} in extracted archive ${archivePath}`
      );
    }

    mkdirSync(dirname(destFile), {
      recursive: true,
    });

    copyFileSync(
      extracted,
      destFile
    );

    if (!destFile.endsWith(".exe")) {
      chmodSync(
        destFile,
        0o755
      );
    }

    console.log(
      `[bundle-node] created ${destFile}`
    );
  } finally {
    rmSync(work, {
      recursive: true,
      force: true,
    });
  }
}

const cacheDir = join(
  extRoot,
  "vendor",
  ".node-cache"
);

mkdirSync(cacheDir, {
  recursive: true,
});

for (const target of targets) {
  const dest = join(
    vendorNode,
    target.key,
    target.out
  );

  if (existsSync(dest)) {
    console.log(
      `[bundle-node] exists ${target.key}`
    );
    continue;
  }

  const url =
    `https://nodejs.org/dist/${VERSION}/${target.archive}`;

  const archivePath = join(
    cacheDir,
    target.archive
  );

  if (!existsSync(archivePath)) {
    console.log(
      `[bundle-node] downloading ${target.archive}`
    );

    await download(
      url,
      archivePath
    );
  }

  console.log(
    `[bundle-node] extracting ${target.key}`
  );

  extractMember(
    archivePath,
    target.member,
    dest
  );
}

console.log("[bundle-node] done");