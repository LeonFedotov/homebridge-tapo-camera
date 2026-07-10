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

test("mosaic args: N rtsp inputs, single SRTP video output, no audio, url terminal", () => {
  const args = buildMosaicArgs({
    sourceUrls: [
      "rtsp://127.0.0.1:8554/a_sub",
      "rtsp://127.0.0.1:8554/b_sub",
    ],
    fps: 15,
    video: {
      address: "192.168.1.5",
      port: 50000,
      payloadType: 99,
      ssrc: 42,
      srtpParams: "a2V5",
      mtu: 1378,
    },
  });
  assert.equal(args.filter((a) => a === "-i").length, 2);
  assert.equal(args.includes("-an"), true);
  assert.equal(args[args.indexOf("-payload_type") + 1], "99");
  assert.equal(args[args.indexOf("-g") + 1], "30");
  assert.match(args[args.length - 1], /^srtp:\/\/.*pkt_size=1378$/);
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
