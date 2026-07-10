import { TierDecision } from "./tierPolicy";

// ffmpeg argv construction as pure functions, locked exactly by
// test/ffmpeg-args.test.js. Hard-won constraints encoded here:
// - -payload_type must match the controller's request on every RTP output;
//   iOS silently discards packets with the wrong pt (eternal spinner,
//   healthy-looking logs).
// - ffmpeg drops most options placed after the last output URL, so every
//   output's options precede its URL and the final argument is always an
//   output URL (a test enforces this).
// - encode mode uses ABR + VBV, which is only valid on constant-frame-rate
//   input (x264 rate control is frame-count-timed) — relay streams are CFR.

export type RtpTarget = {
  address: string;
  port: number;
  payloadType: number;
  ssrc: number;
  /** base64 SRTP key+salt */
  srtpParams: string;
};

export type SessionArgsOptions = {
  /** Local relay URL (rtsp://127.0.0.1:.../cam_main). */
  sourceUrl: string;
  decision: TierDecision;
  video: RtpTarget & { mtu: number };
  /** null/undefined → no audio output. */
  audio?: RtpTarget | null;
};

export function buildSessionArgs(o: SessionArgsOptions): string[] {
  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-rtsp_transport", "tcp",
    "-i", o.sourceUrl,
  ];

  // --- video output ---------------------------------------------------------
  args.push("-map", "0:v:0", "-an");
  if (o.decision.mode === "copy") {
    args.push("-c:v", "copy");
  } else {
    args.push(
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-tune", "zerolatency",
      "-pix_fmt", "yuv420p",
      "-color_range", "mpeg",
      "-vf", `scale=${o.decision.width}:${o.decision.height}`,
      "-r", String(o.decision.fps),
      "-g", String(o.decision.fps * 2),
      "-keyint_min", String(o.decision.fps),
      "-b:v", `${o.decision.bitrateKbps}k`,
      "-maxrate", `${o.decision.bitrateKbps}k`,
      "-bufsize", `${o.decision.bitrateKbps * 2}k`
    );
  }
  args.push(
    "-payload_type", String(o.video.payloadType),
    "-ssrc", String(o.video.ssrc),
    "-f", "rtp",
    "-srtp_out_suite", "AES_CM_128_HMAC_SHA1_80",
    "-srtp_out_params", o.video.srtpParams,
    `srtp://${o.video.address}:${o.video.port}?rtcpport=${o.video.port}&pkt_size=${o.video.mtu}`
  );

  // --- audio output (one-way, HomeKit wants AAC-ELD 16 kHz mono) ------------
  if (o.audio) {
    args.push(
      "-map", "0:a:0", "-vn",
      "-acodec", "libfdk_aac",
      "-profile:a", "aac_eld",
      "-flags", "+global_header",
      // async resampling absorbs backward DTS from the camera's pcm_alaw jitter
      "-af", "aresample=async=16000",
      "-ar", "16000",
      "-b:a", "24k",
      "-ac", "1",
      "-payload_type", String(o.audio.payloadType),
      "-ssrc", String(o.audio.ssrc),
      "-f", "rtp",
      "-srtp_out_suite", "AES_CM_128_HMAC_SHA1_80",
      "-srtp_out_params", o.audio.srtpParams,
      `srtp://${o.audio.address}:${o.audio.port}?rtcpport=${o.audio.port}&pkt_size=188`
    );
  }

  return args;
}
