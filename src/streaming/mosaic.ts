import { RtpTarget } from "./ffmpegArgs";

// Composites camera tiles onto a base canvas via ffmpeg overlay. Handles both
// a single full-frame tile (standalone HTML camera) and an N-tile grid
// (mosaic). Pure functions, locked by test/mosaic.test.js.
//
// Three layers, bottom to top:
//   1. a lavfi "loading" color base (drives the timeline → output starts
//      instantly and never blocks on a slow/cold input),
//   2. cover stills — each source's last-known snapshot (looped image), shown
//      while that source warms up,
//   3. live tiles — only sources currently producing content, overlaid on top
//      of their cover.
// A cold/dead source is simply never added as a live input (a 404 aborts
// ffmpeg), so it stays a cover/loading tile.

export const LOADING_BG = "0x14161c";

export type MosaicGeometry = { cols: number; rows: number; tileW: number; tileH: number };

export function mosaicGeometry(slots: number, width: number, height: number): MosaicGeometry {
  const cols = Math.ceil(Math.sqrt(slots));
  const rows = Math.ceil(slots / cols);
  const tileW = Math.max(2, Math.floor(width / cols / 2) * 2);
  const tileH = Math.max(2, Math.floor(height / rows / 2) * 2);
  return { cols, rows, tileW, tileH };
}

export type CoverTile = { slot: number; path: string }; // last-known snapshot (still image)
export type LiveTile = { slot: number; url: string }; // currently-producing source

export type MosaicArgsOptions = {
  totalSlots: number;
  width: number;
  height: number;
  fps: number;
  maxBitrateKbps: number; // 0 = unconstrained
  covers: CoverTile[];
  live: LiveTile[];
  video: RtpTarget & { mtu: number };
};

type Placed = { slot: number; input: number };

function overlayChain(
  placed: Placed[],
  geo: MosaicGeometry,
  finalLabel: string
): { filter: string | null; map: string } {
  if (placed.length === 0) return { filter: null, map: "0:v" };
  const parts: string[] = [];
  let cur = "0:v"; // lavfi base
  placed.forEach((p, i) => {
    const col = p.slot % geo.cols;
    const row = Math.floor(p.slot / geo.cols);
    parts.push(
      `[${p.input}:v]scale=${geo.tileW}:${geo.tileH}:force_original_aspect_ratio=decrease,` +
        `pad=${geo.tileW}:${geo.tileH}:(ow-iw)/2:(oh-ih)/2,setsar=1[s${i}]`
    );
    const out = i === placed.length - 1 ? finalLabel : `o${i}`;
    parts.push(`[${cur}][s${i}]overlay=${col * geo.tileW}:${row * geo.tileH}:eof_action=pass[${out}]`);
    cur = out;
  });
  return { filter: parts.join(";"), map: `[${finalLabel}]` };
}

// Input layout: [0]=lavfi base, then cover images, then live sources. Covers
// are overlaid first (bottom), live on top.
function inputArgs(o: { width: number; height: number; fps: number; covers: CoverTile[]; live: LiveTile[] }): {
  args: string[];
  placed: Placed[];
} {
  const args: string[] = [];
  const placed: Placed[] = [];
  let input = 1;
  for (const c of o.covers) {
    args.push("-loop", "1", "-framerate", String(o.fps), "-i", c.path);
    placed.push({ slot: c.slot, input: input++ });
  }
  for (const t of o.live) {
    args.push("-rtsp_transport", "tcp", "-i", t.url);
    placed.push({ slot: t.slot, input: input++ });
  }
  return { args, placed };
}

export function buildMosaicArgs(o: MosaicArgsOptions): string[] {
  const geo = mosaicGeometry(o.totalSlots, o.width, o.height);
  const { args: ins, placed } = inputArgs(o);
  const { filter, map } = overlayChain(placed, geo, "v");

  const args = [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=${LOADING_BG}:s=${o.width}x${o.height}:r=${o.fps}`,
    ...ins,
  ];
  if (filter) args.push("-filter_complex", filter, "-map", map);
  else args.push("-map", map);
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
    args.push("-b:v", `${o.maxBitrateKbps}k`, "-maxrate", `${o.maxBitrateKbps}k`, "-bufsize", `${o.maxBitrateKbps * 2}k`);
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

/** Snapshot: same composition (base + covers + live), one frame to stdout. */
export function buildMosaicSnapshotArgs(opts: {
  totalSlots: number;
  width: number;
  height: number;
  covers: CoverTile[];
  live: LiveTile[];
}): string[] {
  const geo = mosaicGeometry(opts.totalSlots, opts.width, opts.height);
  const { args: ins, placed } = inputArgs({ ...opts, fps: 1 });
  const { filter, map } = overlayChain(placed, geo, "v");
  const args = [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=${LOADING_BG}:s=${opts.width}x${opts.height}`,
    ...ins,
  ];
  if (filter) args.push("-filter_complex", filter, "-map", map);
  else args.push("-map", map);
  args.push("-frames:v", "1", "-f", "image2", "-");
  return args;
}
