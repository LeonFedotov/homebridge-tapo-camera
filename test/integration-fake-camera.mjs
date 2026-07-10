#!/usr/bin/env node
// End-to-end integration test with NO camera: a synthetic RTSP source
// (ffmpeg testsrc + alaw sine audio, mimicking a Tapo) is fronted by the real
// go2rtc relay, then exercised exactly like a HomeKit session:
//
//   exec:ffmpeg(testsrc) → go2rtc (GOP cache, restream) → session ffmpeg
//   (buildSessionArgs, copy+audio) → SRTP/UDP sinks (packet counting)
//
// Asserts: relay healthy, frame.jpeg returns a JPEG, and SRTP packets arrive
// on both the video and audio sinks. Run with: npm run test:integration
// (requires `npm install` to have downloaded bin/go2rtc first).

import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { renderGo2rtcConfig } = require(join(root, "dist/streaming/go2rtcManager"));
const { buildSessionArgs } = require(join(root, "dist/streaming/ffmpegArgs"));
const { buildMosaicArgs } = require(join(root, "dist/streaming/mosaic"));

const GO2RTC = process.env.GO2RTC_PATH || join(root, "bin", "go2rtc");
let ffmpegPath = "ffmpeg";
try {
  ffmpegPath = require("ffmpeg-for-homebridge") || "ffmpeg";
} catch {
  /* fall back to PATH ffmpeg */
}

const children = [];
const cleanup = () => {
  for (const c of children) {
    try {
      c.kill("SIGKILL");
    } catch {
      /* gone */
    }
  }
};
process.on("exit", cleanup);

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};
const ok = (msg) => console.log(`ok: ${msg}`);

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

if (!existsSync(GO2RTC)) {
  fail(`go2rtc binary not found at ${GO2RTC} — run npm install (or node scripts/download-go2rtc.mjs) first`);
}

// --- 1. relay with a synthetic camera --------------------------------------
const apiPort = await freePort();
const rtspPort = await freePort();
const fakeSource =
  `exec:${ffmpegPath} -re -f lavfi -i testsrc=size=1280x720:rate=15 ` +
  `-f lavfi -i sine=frequency=440:sample_rate=8000 ` +
  `-c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p -g 30 ` +
  `-c:a pcm_alaw -ar 8000 -ac 1 -f rtsp {output}`;

const workDir = mkdtempSync(join(tmpdir(), "tapo-ng-it-"));
const configPath = join(workDir, "go2rtc.yaml");
writeFileSync(
  configPath,
  renderGo2rtcConfig({
    apiPort,
    rtspPort,
    cameras: [
      { id: "fake", kind: "rtsp", mainUrl: fakeSource, subUrl: fakeSource },
      { id: "fake2", kind: "rtsp", mainUrl: fakeSource, subUrl: fakeSource },
    ],
  })
);

const go2rtc = spawn(GO2RTC, ["-config", configPath], { stdio: ["ignore", "pipe", "pipe"] });
children.push(go2rtc);
go2rtc.stderr.on("data", () => {});
go2rtc.stdout.on("data", () => {});

const deadline = Date.now() + 15000;
let healthy = false;
while (Date.now() < deadline) {
  try {
    const res = await fetch(`http://127.0.0.1:${apiPort}/api`, { signal: AbortSignal.timeout(1000) });
    if (res.ok) {
      healthy = true;
      break;
    }
  } catch {
    /* not yet */
  }
  await new Promise((r) => setTimeout(r, 250));
}
if (!healthy) fail("go2rtc did not become healthy");
ok("go2rtc healthy");

// --- 2. instant snapshot from the relay -------------------------------------
const frameRes = await fetch(`http://127.0.0.1:${apiPort}/api/frame.jpeg?src=fake_sub`, {
  signal: AbortSignal.timeout(15000),
});
if (!frameRes.ok) fail(`frame.jpeg returned ${frameRes.status}`);
const frame = Buffer.from(await frameRes.arrayBuffer());
if (frame[0] !== 0xff || frame[1] !== 0xd8) fail("frame.jpeg did not return a JPEG");
if (frame.length < 5000) fail(`frame suspiciously small (${frame.length} bytes)`);
ok(`frame.jpeg: ${frame.length} byte JPEG`);

// --- 3. HomeKit-shaped session against the relay ----------------------------
const videoSinkPort = await freePort();
const audioSinkPort = await freePort();
let videoPackets = 0;
let audioPackets = 0;
const videoSink = createSocket("udp4");
videoSink.on("message", () => videoPackets++);
videoSink.bind(videoSinkPort);
const audioSink = createSocket("udp4");
audioSink.on("message", () => audioPackets++);
audioSink.bind(audioSinkPort);

const args = buildSessionArgs({
  sourceUrl: `rtsp://127.0.0.1:${rtspPort}/fake_main`,
  decision: { source: "main", mode: "copy", width: 1280, height: 720, fps: 15, bitrateKbps: 0 },
  video: {
    address: "127.0.0.1",
    port: videoSinkPort,
    payloadType: 99,
    ssrc: 1111,
    srtpParams: Buffer.alloc(30, 7).toString("base64"),
    mtu: 1378,
  },
  audio: {
    address: "127.0.0.1",
    port: audioSinkPort,
    payloadType: 110,
    ssrc: 2222,
    srtpParams: Buffer.alloc(30, 9).toString("base64"),
  },
});

const session = spawn(ffmpegPath, args, { stdio: ["pipe", "ignore", "pipe"] });
children.push(session);
let sessionErr = "";
session.stderr.on("data", (d) => (sessionErr += d.toString()));

await new Promise((r) => setTimeout(r, 8000));
try {
  session.kill("SIGKILL");
} catch {
  /* gone */
}

if (videoPackets < 100) {
  fail(`expected >100 SRTP video packets, got ${videoPackets}. ffmpeg stderr: ${sessionErr.slice(-500)}`);
}
if (audioPackets < 20) {
  fail(`expected >20 SRTP audio packets, got ${audioPackets}. ffmpeg stderr: ${sessionErr.slice(-500)}`);
}
ok(`session copy+audio: ${videoPackets} video / ${audioPackets} audio SRTP packets in 8s`);

// --- 4. mosaic: composite both relay streams into one grid ------------------
const mosaicSinkPort = await freePort();
let mosaicPackets = 0;
const mosaicSink = createSocket("udp4");
mosaicSink.on("message", () => mosaicPackets++);
mosaicSink.bind(mosaicSinkPort);

const mosaicArgs = buildMosaicArgs({
  totalSlots: 2,
  tiles: [
    { slot: 0, url: `rtsp://127.0.0.1:${rtspPort}/fake_sub` },
    { slot: 1, url: `rtsp://127.0.0.1:${rtspPort}/fake2_sub` },
  ],
  fps: 10,
  width: 640,
  height: 360,
  maxBitrateKbps: 400,
  video: {
    address: "127.0.0.1",
    port: mosaicSinkPort,
    payloadType: 99,
    ssrc: 3333,
    srtpParams: Buffer.alloc(30, 5).toString("base64"),
    mtu: 1378,
  },
});
const mosaic = spawn(ffmpegPath, mosaicArgs, { stdio: ["pipe", "ignore", "pipe"] });
children.push(mosaic);
let mosaicErr = "";
mosaic.stderr.on("data", (d) => (mosaicErr += d.toString()));
await new Promise((r) => setTimeout(r, 8000));
try {
  mosaic.kill("SIGKILL");
} catch {
  /* gone */
}
if (mosaicPackets < 50) {
  fail(`expected >50 mosaic SRTP packets, got ${mosaicPackets}. ffmpeg stderr: ${mosaicErr.slice(-500)}`);
}
ok(`mosaic (2-cam xstack): ${mosaicPackets} SRTP packets in 8s`);
mosaicSink.close();

videoSink.close();
audioSink.close();
cleanup();
rmSync(workDir, { recursive: true, force: true });
console.log("PASS: relay + snapshot + session + mosaic pipeline verified without a camera");
process.exit(0);
