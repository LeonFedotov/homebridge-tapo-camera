"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  planMosaic,
  buildMosaicFilter,
  buildMosaicArgs,
  buildMosaicSnapshotArgs,
} = require("../dist/streaming/mosaic");

test("grid plan scales square-ish and tiles fit the 1280x720 canvas", () => {
  assert.deepEqual(planMosaic(2), { cols: 2, rows: 1, tileW: 640, tileH: 720 });
  assert.deepEqual(planMosaic(3), { cols: 2, rows: 2, tileW: 640, tileH: 360 });
  assert.deepEqual(planMosaic(4), { cols: 2, rows: 2, tileW: 640, tileH: 360 });
  assert.deepEqual(planMosaic(9), { cols: 3, rows: 3, tileW: 426, tileH: 240 });
});

test("filter letterboxes each input and lays out a black-filled grid", () => {
  const f = buildMosaicFilter(4, planMosaic(4));
  // one scale+pad per input
  assert.equal((f.match(/force_original_aspect_ratio=decrease/g) || []).length, 4);
  // 2x2 layout positions
  assert.match(f, /xstack=inputs=4:layout=0_0\|640_0\|0_360\|640_360:fill=black\[v\]/);
});

const target = {
  address: "192.168.1.5",
  port: 50000,
  payloadType: 99,
  ssrc: 42,
  srtpParams: "a2V5",
  mtu: 1378,
};

test("mosaic at full canvas + capped bitrate: no scale filter, bitrate flags present", () => {
  const args = buildMosaicArgs({
    sourceUrls: ["rtsp://127.0.0.1:8554/a_sub", "rtsp://127.0.0.1:8554/b_sub"],
    fps: 15,
    width: 1280,
    height: 720,
    maxBitrateKbps: 802,
    video: target,
  });
  assert.equal(args.filter((a) => a === "-i").length, 2);
  assert.equal(args.includes("-an"), true);
  assert.equal(args[args.indexOf("-payload_type") + 1], "99");
  assert.equal(args[args.indexOf("-g") + 1], "30");
  assert.equal(args[args.indexOf("-b:v") + 1], "802k");
  assert.equal(args[args.indexOf("-bufsize") + 1], "1604k");
  // full canvas → the filter maps xstack straight to [v], no scale
  const vf = args[args.indexOf("-filter_complex") + 1];
  assert.match(vf, /xstack=inputs=2:.*\[v\]$/);
  assert.equal(vf.includes("scale=1280:720"), false);
  assert.match(args[args.length - 1], /^srtp:\/\/.*pkt_size=1378$/);
});

test("mosaic honors the negotiated resolution (scales the canvas down)", () => {
  const args = buildMosaicArgs({
    sourceUrls: ["rtsp://127.0.0.1:8554/a_sub", "rtsp://127.0.0.1:8554/b_sub"],
    fps: 15,
    width: 640,
    height: 360,
    maxBitrateKbps: 299,
    video: target,
  });
  const vf = args[args.indexOf("-filter_complex") + 1];
  assert.match(vf, /\[m\];\[m\]scale=640:360\[v\]$/);
  assert.equal(args[args.indexOf("-maxrate") + 1], "299k");
});

test("mosaic with unknown bitrate: no bitrate flags", () => {
  const args = buildMosaicArgs({
    sourceUrls: ["rtsp://127.0.0.1:8554/a_sub", "rtsp://127.0.0.1:8554/b_sub"],
    fps: 15,
    width: 1280,
    height: 720,
    maxBitrateKbps: 0,
    video: target,
  });
  assert.equal(args.includes("-b:v"), false);
  assert.equal(args.includes("-maxrate"), false);
});

test("snapshot args composite one frame to stdout", () => {
  const args = buildMosaicSnapshotArgs([
    "rtsp://127.0.0.1:8554/a_sub",
    "rtsp://127.0.0.1:8554/b_sub",
    "rtsp://127.0.0.1:8554/c_sub",
  ]);
  assert.equal(args.filter((a) => a === "-i").length, 3);
  assert.equal(args[args.indexOf("-frames:v") + 1], "1");
  assert.deepEqual(args.slice(-3), ["-f", "image2", "-"]);
});
