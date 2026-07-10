"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, existsSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const { SnapshotStore, CONTENT_MIN_BYTES } = require("../dist/streaming/snapshotStore");

const noopLog = { debug() {}, info() {}, warn() {}, error() {} };
const content = (n) => Buffer.alloc(n, 7);

test("stores content frames in memory and on disk; ignores tiny/black frames", () => {
  const dir = mkdtempSync(join(tmpdir(), "snapstore-"));
  try {
    const store = new SnapshotStore(noopLog, dir);
    assert.equal(store.get("cam"), null);
    assert.equal(store.path("cam"), null);

    store.put("cam", content(500)); // below CONTENT_MIN_BYTES → ignored
    assert.equal(store.get("cam"), null);

    const frame = content(CONTENT_MIN_BYTES + 100);
    store.put("cam", frame);
    assert.equal(store.get("cam").length, frame.length);
    assert.ok(store.path("cam"));
    assert.ok(existsSync(join(dir, "snapshots", "cam.jpg")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reloads persisted frames from disk on construction (survives restart)", () => {
  const dir = mkdtempSync(join(tmpdir(), "snapstore-"));
  try {
    const frame = content(CONTENT_MIN_BYTES + 50);
    new SnapshotStore(noopLog, dir).put("home", frame);
    // a fresh store (as after a restart) should see the on-disk frame
    const reloaded = new SnapshotStore(noopLog, dir);
    assert.equal(reloaded.get("home").length, frame.length);
    assert.ok(reloaded.path("home"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
