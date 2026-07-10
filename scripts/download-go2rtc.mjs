#!/usr/bin/env node
// Downloads the pinned go2rtc binary for this platform into ./bin/go2rtc.
// Runs on postinstall; safe to re-run. Skip with GO2RTC_SKIP_DOWNLOAD=1
// (then set go2rtcPath in the platform config or GO2RTC_PATH in the env).

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const VERSION = "1.9.14";
const BASE = `https://github.com/AlexxIT/go2rtc/releases/download/v${VERSION}`;

const PLATFORMS = {
  "linux_arm64": {
    asset: "go2rtc_linux_arm64",
    sha256: "359fabade8a7a51e81a55fe6df6b0ef81764a5e1d63179577534eaaa71904b50",
  },
  "linux_x64": {
    asset: "go2rtc_linux_amd64",
    sha256: "32d616af226bd731678ffde328b94cfb94e30339bfefc469cfb76323144615a6",
  },
  "darwin_arm64": {
    asset: "go2rtc_mac_arm64.zip",
    sha256: "919b78adc759d6b3883d1e1b2ac915ac0985bb903ff1897b4d228527bd64690c",
    zip: true,
  },
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const binDir = join(root, "bin");
const binary = join(binDir, "go2rtc");

function currentVersion() {
  try {
    return execFileSync(binary, ["--version"], { encoding: "utf8" });
  } catch {
    return "";
  }
}

if (process.env.GO2RTC_SKIP_DOWNLOAD) {
  console.log("go2rtc download skipped (GO2RTC_SKIP_DOWNLOAD set)");
  process.exit(0);
}

if (existsSync(binary) && currentVersion().includes(VERSION)) {
  console.log(`go2rtc ${VERSION} already present`);
  process.exit(0);
}

const key = `${process.platform}_${process.arch}`;
const target = PLATFORMS[key];
if (!target) {
  console.warn(
    `go2rtc: no pinned binary for ${key}. Install go2rtc yourself and set ` +
      "go2rtcPath in the platform config (or GO2RTC_PATH)."
  );
  process.exit(0);
}

try {
  console.log(`Downloading go2rtc ${VERSION} (${target.asset})...`);
  const res = await fetch(`${BASE}/${target.asset}`);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());

  const digest = createHash("sha256").update(data).digest("hex");
  if (digest !== target.sha256) {
    throw new Error(`sha256 mismatch: got ${digest}, want ${target.sha256}`);
  }

  mkdirSync(binDir, { recursive: true });
  if (target.zip) {
    const zipPath = join(binDir, target.asset);
    writeFileSync(zipPath, data);
    const unzip = spawnSync("unzip", ["-o", "-q", zipPath, "-d", binDir]);
    rmSync(zipPath, { force: true });
    if (unzip.status !== 0) throw new Error("unzip failed");
  } else {
    writeFileSync(binary, data);
  }
  chmodSync(binary, 0o755);

  const version = currentVersion();
  if (!version.includes(VERSION)) {
    throw new Error(`binary verification failed: ${version.trim()}`);
  }
  console.log(`go2rtc ready: ${version.trim()}`);
} catch (err) {
  console.warn(
    `go2rtc download failed (${err.message}). Streaming will not work until ` +
      "you re-run `node scripts/download-go2rtc.mjs` here, or set go2rtcPath " +
      "in the platform config."
  );
  process.exit(0); // soft-fail: don't break npm install on offline machines
}
