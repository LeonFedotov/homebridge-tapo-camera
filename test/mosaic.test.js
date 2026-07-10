"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  mosaicGeometry,
  buildMosaicArgs,
  buildMosaicSnapshotArgs,
} = require("../dist/streaming/mosaic");

const target = {
  address: "192.168.1.5",
  port: 50000,
  payloadType: 99,
  ssrc: 42,
  srtpParams: "a2V5",
  mtu: 1378,
};
const url = (n) => `rtsp://127.0.0.1:8554/${n}_sub`;

test("geometry: square-ish grid, tiles fit the output size", () => {
  assert.deepEqual(mosaicGeometry(2, 1280, 720), { cols: 2, rows: 1, tileW: 640, tileH: 720 });
  assert.deepEqual(mosaicGeometry(3, 1280, 720), { cols: 2, rows: 2, tileW: 640, tileH: 360 });
  assert.deepEqual(mosaicGeometry(4, 640, 360), { cols: 2, rows: 2, tileW: 320, tileH: 180 });
});

test("no ready tiles: streams the loading base alone (instant start, no blocking inputs)", () => {
  const args = buildMosaicArgs({
    totalSlots: 3,
    tiles: [],
    width: 640,
    height: 360,
    fps: 10,
    maxBitrateKbps: 299,
    video: target,
  });
  // only the lavfi base input, mapped directly — no camera inputs to stall on
  assert.equal(args.filter((a) => a === "-i").length, 1);
  assert.match(args[args.indexOf("-i") + 1], /^color=c=.*:s=640x360:r=10$/);
  assert.equal(args[args.indexOf("-map") + 1], "0:v");
  assert.equal(args.includes("-filter_complex"), false);
  assert.equal(args[args.indexOf("-maxrate") + 1], "299k");
  assert.match(args[args.length - 1], /^srtp:\/\//);
});

test("partial tiles: only ready sources are inputs; each overlaid at its slot", () => {
  const args = buildMosaicArgs({
    totalSlots: 3,
    tiles: [
      { slot: 0, url: url("home") },
      { slot: 2, url: url("dash") },
    ],
    width: 1280,
    height: 720,
    fps: 10,
    maxBitrateKbps: 0,
    video: target,
  });
  // base + exactly the 2 ready inputs (the cold slot 1 is NOT referenced)
  assert.equal(args.filter((a) => a === "-i").length, 3);
  const vf = args[args.indexOf("-filter_complex") + 1];
  // slot 0 at (0,0), slot 2 at (0,360) on a 2x2 grid of 640x360 tiles
  assert.match(vf, /overlay=0:0:eof_action=pass/);
  assert.match(vf, /overlay=0:360:eof_action=pass/);
  assert.equal(args[args.indexOf("-map") + 1], "[v]");
  assert.equal(args.includes("-b:v"), false); // uncapped
});

test("snapshot: base + ready tiles, one frame to stdout, never needs a camera input", () => {
  const empty = buildMosaicSnapshotArgs(3, []);
  assert.equal(empty.filter((a) => a === "-i").length, 1);
  assert.equal(empty[empty.length - 1], "-");
  assert.equal(empty[empty.indexOf("-frames:v") + 1], "1");

  const one = buildMosaicSnapshotArgs(3, [{ slot: 1, url: url("home") }]);
  assert.equal(one.filter((a) => a === "-i").length, 2);
});
