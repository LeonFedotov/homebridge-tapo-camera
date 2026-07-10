"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { decideTier } = require("../dist/streaming/tierPolicy");

const req = (width, height, fps, maxBitrateKbps) => ({
  width,
  height,
  fps,
  maxBitrateKbps,
});

test("local 1080p with generous budget: main tier, zero-CPU copy", () => {
  const d = decideTier(req(1920, 1080, 30, 2000));
  assert.equal(d.source, "main");
  assert.equal(d.mode, "copy");
});

test("720p at a starved budget: main tier but encoded down to budget", () => {
  const d = decideTier(req(1280, 720, 15, 299));
  assert.deepEqual(
    { source: d.source, mode: d.mode, width: d.width, height: d.height, bitrateKbps: d.bitrateKbps },
    { source: "main", mode: "encode", width: 1280, height: 720, bitrateKbps: 299 }
  );
});

test("relay 360p at 300kbps: sub tier, encoded (sub's native ~1Mbps exceeds budget)", () => {
  const d = decideTier(req(640, 360, 15, 300));
  assert.equal(d.source, "sub");
  assert.equal(d.mode, "encode");
  assert.equal(d.bitrateKbps, 300);
});

test("unknown bitrate: copy (never guess the client short)", () => {
  const d = decideTier(req(640, 360, 15, 0));
  assert.equal(d.source, "sub");
  assert.equal(d.mode, "copy");
});

test("forceTier pins the source but copy/encode still follows the budget", () => {
  const d = decideTier(req(1920, 1080, 30, 2000), undefined, undefined, "sub");
  assert.equal(d.source, "sub");
  assert.equal(d.mode, "copy"); // 2000 kbps easily carries sub's ~1 Mbps
});

test("encode dimensions are clamped to the tier and rounded to even", () => {
  const d = decideTier(req(641, 361, 15, 100));
  assert.equal(d.mode, "encode");
  assert.equal(d.width, 640);
  assert.equal(d.height, 360);
});

test("reconfigure damping: no-op changes never respawn", () => {
  const { shouldApplyReconfigure } = require("../dist/streaming/tierPolicy");
  const d = { source: "sub", mode: "encode", width: 640, height: 360, fps: 30, bitrateKbps: 132 };
  assert.equal(shouldApplyReconfigure(d, { ...d }, 1000), false);
  assert.equal(shouldApplyReconfigure(d, { ...d, bitrateKbps: 140 }, 1000), false); // <10% delta
});

test("reconfigure damping: downgrades apply immediately, upgrades wait 15s", () => {
  const { shouldApplyReconfigure } = require("../dist/streaming/tierPolicy");
  const low = { source: "sub", mode: "encode", width: 640, height: 360, fps: 30, bitrateKbps: 132 };
  const high = { source: "main", mode: "encode", width: 1280, height: 720, fps: 30, bitrateKbps: 299 };
  assert.equal(shouldApplyReconfigure(high, low, 1000), true, "downgrade must apply immediately");
  assert.equal(shouldApplyReconfigure(low, high, 5000), false, "upgrade damped inside the window");
  assert.equal(shouldApplyReconfigure(low, high, 16000), true, "upgrade allowed after the window");
});
