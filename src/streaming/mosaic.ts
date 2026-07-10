import { RtpTarget } from "./ffmpegArgs";

// Composites camera tiles onto a "loading" base canvas via ffmpeg overlay.
// Pure functions, locked by test/mosaic.test.js.
//
// Design (a glance view — smooth & cheap beats sharp):
// - A lavfi color base drives the timeline, so output starts IMMEDIATELY and
//   never blocks on a slow/cold input (verified: a late input doesn't stall
//   the base).
// - Only READY sources are added as inputs. A dead/not-yet-ready source is
//   simply left as a base "loading" tile — never referenced, so it can't
//   stall or kill the graph (verified: a 404 input aborts ffmpeg).
// - The delegate re-spawns with more tiles as sources warm up.

export const LOADING_BG = "0x14161c"; // base canvas ("loading") color

export type MosaicGeometry = {
  cols: number;
  rows: number;
  tileW: number;
  tileH: number;
};

/** Grid geometry for `slots` tiles at the given output size. */
export function mosaicGeometry(slots: number, width: number, height: number): MosaicGeometry {
  const cols = Math.ceil(Math.sqrt(slots));
  const rows = Math.ceil(slots / cols);
  const tileW = Math.max(2, Math.floor(width / cols / 2) * 2);
  const tileH = Math.max(2, Math.floor(height / rows / 2) * 2);
  return { cols, rows, tileW, tileH };
}

export type MosaicTile = { slot: number; url: string };

/**
 * filter_complex overlaying each ready tile onto the base at its grid slot.
 * Returns null when there are no ready tiles (caller maps the base directly).
 */
export function buildMosaicFilter(
  tiles: MosaicTile[],
  geo: MosaicGeometry
): string | null {
  if (tiles.length === 0) return null;
  const parts: string[] = [];
  let cur = "0:v"; // input 0 is the lavfi base
  tiles.forEach((tile, i) => {
    const inLabel = `${i + 1}:v`;
    parts.push(
      `[${inLabel}]scale=${geo.tileW}:${geo.tileH}:force_original_aspect_ratio=decrease,` +
        `pad=${geo.tileW}:${geo.tileH}:(ow-iw)/2:(oh-ih)/2,setsar=1[t${i}]`
    );
    const col = tile.slot % geo.cols;
    const row = Math.floor(tile.slot / geo.cols);
    const out = i === tiles.length - 1 ? "v" : `o${i}`;
    parts.push(`[${cur}][t${i}]overlay=${col * geo.tileW}:${row * geo.tileH}:eof_action=pass[${out}]`);
    cur = out;
  });
  return parts.join(";");
}

export type MosaicArgsOptions = {
  totalSlots: number;
  tiles: MosaicTile[]; // ready sources only
  width: number;
  height: number;
  fps: number;
  maxBitrateKbps: number; // 0 = unconstrained
  video: RtpTarget & { mtu: number };
};

export function buildMosaicArgs(o: MosaicArgsOptions): string[] {
  const geo = mosaicGeometry(o.totalSlots, o.width, o.height);
  const filter = buildMosaicFilter(o.tiles, geo);

  const args = [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=${LOADING_BG}:s=${o.width}x${o.height}:r=${o.fps}`,
  ];
  for (const tile of o.tiles) {
    args.push("-rtsp_transport", "tcp", "-i", tile.url);
  }
  if (filter) {
    args.push("-filter_complex", filter, "-map", "[v]");
  } else {
    args.push("-map", "0:v");
  }
  args.push(
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

/** Snapshot: composite the base + ready tiles, one frame to stdout. Always
 *  produces something instantly (base) even if no tile is ready. */
export function buildMosaicSnapshotArgs(
  totalSlots: number,
  tiles: MosaicTile[],
  width = 1280,
  height = 720
): string[] {
  const geo = mosaicGeometry(totalSlots, width, height);
  const filter = buildMosaicFilter(tiles, geo);
  const args = [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=${LOADING_BG}:s=${width}x${height}`,
  ];
  for (const tile of tiles) {
    args.push("-rtsp_transport", "tcp", "-i", tile.url);
  }
  if (filter) args.push("-filter_complex", filter, "-map", "[v]");
  else args.push("-map", "0:v");
  args.push("-frames:v", "1", "-f", "image2", "-");
  return args;
}
