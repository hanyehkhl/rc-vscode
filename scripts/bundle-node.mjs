import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
  copyFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";

const VERSION = "v20.18.2";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extRoot = join(__dirname, "..");
const vendorNode = join(extRoot, "vendor", "node");
const cacheDir = join(extRoot, "vendor", ".node-cache");

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

function resolveTarBinary() {
  // Git Bash puts GNU tar first on PATH. That tar treats "C:\..." as
  // host:path and fails. Prefer the Windows bsdtar when present.
  if (process.platform === "win32") {
    const systemTar = join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "tar.exe"
    );

    if (existsSync(systemTar)) {
      return systemTar;
    }
  }

  return "tar";
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
  // Keep archive + -C relative to cacheDir so GNU tar (Git Bash) never
  // sees a drive-letter absolute path like C:\Users\...
  const archiveRel = basename(archivePath);
  const workRel = basename(work);

  if (dirname(archivePath) !== cacheDir || dirname(work) !== cacheDir) {
    throw new Error(
      "extractTar expects archive and work directories under vendor/.node-cache"
    );
  }

  const tarBin = resolveTarBinary();

  console.log(`[bundle-node] tar binary: ${tarBin}`);
  console.log(`[bundle-node] tar cwd: ${cacheDir}`);
  console.log(`[bundle-node] tar archive: ${archiveRel}`);
  console.log(`[bundle-node] tar work: ${workRel}`);

  execFileSync(
    tarBin,
    [
      "-xzf",
      archiveRel,
      "-C",
      workRel,
      member,
    ],
    {
      cwd: cacheDir,
      stdio: "inherit",
      // Avoid inheriting MSYS path conversion surprises from Git Bash.
      env: {
        ...process.env,
        MSYS_NO_PATHCONV: "1",
        MSYS2_ARG_CONV_EXCL: "*",
      },
    }
  );
}

function extractMember(archivePath, member, destFile) {
  // Extract under cacheDir (not os.tmpdir) so tar can use relative paths.
  const work = join(
    cacheDir,
    `.extract-${Date.now()}-${Math.random().toString(16).slice(2)}`
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
