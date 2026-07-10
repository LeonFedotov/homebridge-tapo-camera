"use strict";

// Locks the exact ffmpeg argv. Constraints these tests enforce (learned the
// hard way in homekit-html-camera): -payload_type on every RTP output (iOS
// silently discards mismatched packets), options always precede their output,
// the final argument is always an output URL.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { buildSessionArgs } = require("../dist/streaming/ffmpegArgs");

const video = {
  address: "192.168.1.20",
  port: 52000,
  payloadType: 99,
  ssrc: 111,
  srtpParams: "dmlkZW9rZXlhbmRzYWx0",
  mtu: 1378,
};
const audio = {
  address: "192.168.1.20",
  port: 53000,
  payloadType: 110,
  ssrc: 222,
  srtpParams: "YXVkaW9rZXlhbmRzYWx0",
};

test("copy mode with audio: exact argv", () => {
  assert.deepEqual(
    buildSessionArgs({
      sourceUrl: "rtsp://127.0.0.1:8554/cam_main",
      decision: {
        source: "main",
        mode: "copy",
        width: 1920,
        height: 1080,
        fps: 15,
        bitrateKbps: 2048,
      },
      video,
      audio,
    }),
    [
      "-hide_banner",
      "-loglevel", "error",
      "-rtsp_transport", "tcp",
      "-i", "rtsp://127.0.0.1:8554/cam_main",
      "-map", "0:v:0", "-an",
      "-c:v", "copy",
      "-payload_type", "99",
      "-ssrc", "111",
      "-f", "rtp",
      "-srtp_out_suite", "AES_CM_128_HMAC_SHA1_80",
      "-srtp_out_params", "dmlkZW9rZXlhbmRzYWx0",
      "srtp://192.168.1.20:52000?rtcpport=52000&pkt_size=1378",
      "-map", "0:a:0", "-vn",
      "-acodec", "libfdk_aac",
      "-profile:a", "aac_eld",
      "-flags", "+global_header",
      "-af", "aresample=async=16000",
      "-ar", "16000",
      "-b:a", "24k",
      "-ac", "1",
      "-payload_type", "110",
      "-ssrc", "222",
      "-f", "rtp",
      "-srtp_out_suite", "AES_CM_128_HMAC_SHA1_80",
      "-srtp_out_params", "YXVkaW9rZXlhbmRzYWx0",
      "srtp://192.168.1.20:53000?rtcpport=53000&pkt_size=188",
    ]
  );
});

test("encode mode without audio: exact argv", () => {
  assert.deepEqual(
    buildSessionArgs({
      sourceUrl: "rtsp://127.0.0.1:8554/cam_sub",
      decision: {
        source: "sub",
        mode: "encode",
        width: 640,
        height: 360,
        fps: 15,
        bitrateKbps: 300,
      },
      video,
      audio: null,
    }),
    [
      "-hide_banner",
      "-loglevel", "error",
      "-rtsp_transport", "tcp",
      "-i", "rtsp://127.0.0.1:8554/cam_sub",
      "-map", "0:v:0", "-an",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-tune", "zerolatency",
      "-pix_fmt", "yuv420p",
      "-color_range", "mpeg",
      "-vf", "scale=640:360",
      "-r", "15",
      "-g", "30",
      "-keyint_min", "15",
      "-b:v", "300k",
      "-maxrate", "300k",
      "-bufsize", "600k",
      "-payload_type", "99",
      "-ssrc", "111",
      "-f", "rtp",
      "-srtp_out_suite", "AES_CM_128_HMAC_SHA1_80",
      "-srtp_out_params", "dmlkZW9rZXlhbmRzYWx0",
      "srtp://192.168.1.20:52000?rtcpport=52000&pkt_size=1378",
    ]
  );
});

test("final argument is always an output URL (ffmpeg drops trailing options)", () => {
  for (const withAudio of [audio, null]) {
    const args = buildSessionArgs({
      sourceUrl: "rtsp://127.0.0.1:8554/cam_main",
      decision: {
        source: "main",
        mode: "copy",
        width: 1920,
        height: 1080,
        fps: 15,
        bitrateKbps: 0,
      },
      video,
      audio: withAudio,
    });
    assert.match(args[args.length - 1], /^srtp:\/\//);
  }
});
