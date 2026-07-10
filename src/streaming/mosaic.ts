import { RtpTarget } from "./ffmpegArgs";

// Composites N camera sub-streams into a single grid via ffmpeg xstack, then
// scales/bitrate-caps to what HomeKit negotiated. Pure functions, locked by
// test/mosaic.test.js. Inputs come from the local relay (never the cameras),
// so the mosaic adds no camera-side load and only runs while viewed.
//
// The grid is composed at a fixed 1280x720 canvas (tile geometry), then scaled
// to the negotiated output size. Honoring the negotiated bitrate is essential:
// an uncapped ~1Mbps mosaic pushed through a ~300kbps relay never assembles a
// decodable stream on the client — endless spinner while snapshots still work.

export const MOSAIC_CANVAS_W = 1280;
export const MOSAIC_CANVAS_H = 720;

export type MosaicPlan = {
  cols: number;
  rows: number;
  tileW: number;
  tileH: number;
};

/** Smallest square-ish grid that holds n tiles, tiles sized to a 1280x720 canvas. */
export function planMosaic(n: number): MosaicPlan {
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const tileW = Math.max(2, Math.floor(MOSAIC_CANVAS_W / cols / 2) * 2);
  const tileH = Math.max(2, Math.floor(MOSAIC_CANVAS_H / rows / 2) * 2);
  return { cols, rows, tileW, tileH };
}

/**
 * filter_complex that letterboxes each input into its tile (preserving aspect
 * ratio) and lays them out on a black-filled grid, ending at label `outLabel`.
 */
export function buildMosaicFilter(n: number, plan: MosaicPlan, outLabel = "v"): string {
  const parts: string[] = [];
  const labels: string[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(
      `[${i}:v]scale=${plan.tileW}:${plan.tileH}:force_original_aspect_ratio=decrease,` +
        `pad=${plan.tileW}:${plan.tileH}:(ow-iw)/2:(oh-ih)/2,setsar=1[t${i}]`
    );
    labels.push(`[t${i}]`);
  }
  const layout: string[] = [];
  for (let i = 0; i < n; i++) {
    const col = i % plan.cols;
    const row = Math.floor(i / plan.cols);
    layout.push(`${col * plan.tileW}_${row * plan.tileH}`);
  }
  parts.push(
    `${labels.join("")}xstack=inputs=${n}:layout=${layout.join("|")}:fill=black[${outLabel}]`
  );
  return parts.join(";");
}

export type MosaicArgsOptions = {
  /** Local relay URLs (sub tier) of every member camera. */
  sourceUrls: string[];
  fps: number;
  /** Negotiated output size (scaled down from the 1280x720 canvas). */
  width: number;
  height: number;
  /** Negotiated bitrate in kbps (0 = leave the encoder unconstrained). */
  maxBitrateKbps: number;
  video: RtpTarget & { mtu: number };
};

export function buildMosaicArgs(o: MosaicArgsOptions): string[] {
  const n = o.sourceUrls.length;
  const plan = planMosaic(n);
  const scaled = o.width !== MOSAIC_CANVAS_W || o.height !== MOSAIC_CANVAS_H;

  // Compose the grid, then (if needed) scale the whole canvas to the
  // negotiated output size.
  const filter = scaled
    ? `${buildMosaicFilter(n, plan, "m")};[m]scale=${o.width}:${o.height}[v]`
    : buildMosaicFilter(n, plan, "v");

  const args = ["-hide_banner", "-loglevel", "error"];
  for (const url of o.sourceUrls) {
    args.push("-rtsp_transport", "tcp", "-i", url);
  }
  args.push(
    "-filter_complex", filter,
    "-map", "[v]",
    "-an",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-tune", "zerolatency",
    "-pix_fmt", "yuv420p",
    "-color_range", "mpeg",
    "-r", String(o.fps),
    "-g", String(o.fps * 2),
    "-keyint_min", String(o.fps)
  );
  if (o.maxBitrateKbps > 0) {
    args.push(
      "-b:v", `${o.maxBitrateKbps}k`,
      "-maxrate", `${o.maxBitrateKbps}k`,
      "-bufsize", `${o.maxBitrateKbps * 2}k`
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
  return args;
}

/** Snapshot argv: composite at canvas size, one frame to stdout as JPEG. */
export function buildMosaicSnapshotArgs(sourceUrls: string[]): string[] {
  const n = sourceUrls.length;
  const plan = planMosaic(n);
  const args = ["-hide_banner", "-loglevel", "error"];
  for (const url of sourceUrls) {
    args.push("-rtsp_transport", "tcp", "-i", url);
  }
  args.push(
    "-filter_complex", buildMosaicFilter(n, plan, "v"),
    "-map", "[v]",
    "-frames:v", "1",
    "-f", "image2",
    "-"
  );
  return args;
}
