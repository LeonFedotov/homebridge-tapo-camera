"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  mosaicGeometry,
  buildMosaicArgs,
  buildMosaicSnapshotArgs,
} = require("../dist/streaming/mosaic");

const target = { address: "192.168.1.5", port: 50000, payloadType: 99, ssrc: 42, srtpParams: "a2V5", mtu: 1378 };
const base = { totalSlots: 2, width: 1280, height: 720, fps: 10, maxBitrateKbps: 299, video: target };

test("geometry: square-ish grid, tiles fit the output size", () => {
  assert.deepEqual(mosaicGeometry(1, 1280, 720), { cols: 1, rows: 1, tileW: 1280, tileH: 720 });
  assert.deepEqual(mosaicGeometry(2, 1280, 720), { cols: 2, rows: 1, tileW: 640, tileH: 720 });
  assert.deepEqual(mosaicGeometry(4, 640, 360), { cols: 2, rows: 2, tileW: 320, tileH: 180 });
});

test("nothing ready: streams the loading base alone (instant, no blocking inputs)", () => {
  const args = buildMosaicArgs({ ...base, covers: [], live: [] });
  assert.equal(args.filter((a) => a === "-i").length, 1); // only the lavfi base
  assert.match(args[args.indexOf("-i") + 1], /^color=c=.*:s=1280x720:r=10$/);
  assert.equal(args[args.indexOf("-map") + 1], "0:v");
  assert.equal(args.includes("-filter_complex"), false);
  assert.equal(args[args.indexOf("-maxrate") + 1], "299k");
  assert.match(args[args.length - 1], /^srtp:\/\//);
});

test("cover still is a looped image input, overlaid at its slot (warm-up cover)", () => {
  const args = buildMosaicArgs({ ...base, covers: [{ slot: 1, path: "/x/dash.jpg" }], live: [] });
  // base + one looped image input
  assert.equal(args.filter((a) => a === "-i").length, 2);
  const k = args.indexOf("/x/dash.jpg");
  assert.deepEqual(args.slice(k - 5, k + 1), ["-loop", "1", "-framerate", "10", "-i", "/x/dash.jpg"]);
  const vf = args[args.indexOf("-filter_complex") + 1];
  assert.match(vf, /overlay=640:0:eof_action=pass/); // slot 1 → (640,0) on a 2x1 grid
});

test("covers beneath live: cover input first, live on top, correct slot positions", () => {
  const args = buildMosaicArgs({
    ...base,
    covers: [{ slot: 1, path: "/x/b.jpg" }],
    live: [{ slot: 0, url: "rtsp://127.0.0.1/a_sub" }],
  });
  // base + cover image + live rtsp = 3 inputs
  assert.equal(args.filter((a) => a === "-i").length, 3);
  const vf = args[args.indexOf("-filter_complex") + 1];
  // cover (slot1 → 640,0) overlaid before live (slot0 → 0,0), which ends at [v]
  assert.match(vf, /overlay=640:0:eof_action=pass\[o0\]/);
  assert.match(vf, /overlay=0:0:eof_action=pass\[v\]/);
  assert.equal(args[args.indexOf("-map") + 1], "[v]");
});

test("uncapped bitrate: no bitrate flags", () => {
  const args = buildMosaicArgs({ ...base, maxBitrateKbps: 0, covers: [], live: [{ slot: 0, url: "rtsp://x/a" }] });
  assert.equal(args.includes("-b:v"), false);
  assert.equal(args.includes("-maxrate"), false);
});

test("snapshot: base + covers + live, one frame to stdout", () => {
  const args = buildMosaicSnapshotArgs({ totalSlots: 2, width: 1280, height: 720, covers: [{ slot: 0, path: "/x/a.jpg" }], live: [] });
  assert.equal(args.filter((a) => a === "-i").length, 2);
  assert.equal(args[args.indexOf("-frames:v") + 1], "1");
  assert.equal(args[args.length - 1], "-");
});
