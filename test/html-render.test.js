"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { buildCaptureCommand } = require("../dist/streaming/htmlRender");

test("capture command: x11grab of the display into H.264 RTSP for go2rtc", () => {
  const cmd = buildCaptureCommand({
    ffmpeg: "/usr/bin/ffmpeg",
    display: ":7",
    width: 1280,
    height: 720,
    fps: 15,
  });
  assert.match(cmd, /^\/usr\/bin\/ffmpeg /);
  assert.match(cmd, /-f x11grab -video_size 1280x720 -framerate 15 -i :7\.0/);
  assert.match(cmd, /-c:v libx264 .*-g 30/);
  // go2rtc receives the stream at the {output} RTSP URL it substitutes; it
  // must be the final token.
  assert.match(cmd, /-f rtsp \{output\}$/);
});
