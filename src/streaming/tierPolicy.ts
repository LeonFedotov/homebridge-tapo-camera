import { StreamTier } from "./sourceProvider";

export type NegotiatedVideo = {
  width: number;
  height: number;
  fps: number;
  /** kbps; 0/undefined = unknown. */
  maxBitrateKbps: number;
};

export type TierMeta = {
  width: number;
  height: number;
  /** Approximate bitrate the camera produces on this tier, kbps. */
  approxBitrateKbps: number;
};

export type TierDecision = {
  source: StreamTier;
  mode: "copy" | "encode";
  /** Encode targets (never upscaled beyond the source tier). */
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
};

export const DEFAULT_MAIN_TIER: TierMeta = {
  width: 1920,
  height: 1080,
  approxBitrateKbps: 2048,
};

export const DEFAULT_SUB_TIER: TierMeta = {
  width: 640,
  height: 360,
  approxBitrateKbps: 1024,
};

const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

/** Minimum stability window before an upgrade reconfigure is honored. */
export const UPGRADE_DAMPING_MS = 15_000;

/**
 * Damping for RECONFIGURE storms: every applied reconfigure respawns the
 * session encoder, and the brief gap can read as "link trouble" to the
 * client, which then downgrades — a feedback oscillator. Downgrades apply
 * immediately (protect the link); upgrades are rate-limited; no-op changes
 * are ignored.
 */
export function shouldApplyReconfigure(
  prev: TierDecision,
  next: TierDecision,
  msSinceLastChange: number
): boolean {
  const prevArea = prev.width * prev.height;
  const nextArea = next.width * next.height;
  const sameShape =
    prev.source === next.source &&
    prev.mode === next.mode &&
    prevArea === nextArea;
  const bitrateDelta = Math.abs(next.bitrateKbps - prev.bitrateKbps);
  if (sameShape && bitrateDelta <= prev.bitrateKbps * 0.1) {
    return false; // effectively unchanged — don't interrupt the stream
  }
  const isUpgrade =
    nextArea > prevArea ||
    (nextArea === prevArea && next.bitrateKbps > prev.bitrateKbps);
  if (!isUpgrade) {
    return true; // downgrades always apply immediately
  }
  return msSinceLastChange >= UPGRADE_DAMPING_MS;
}

/**
 * Map what the HomeKit client negotiated to a relay tier and transport mode.
 *
 * copy: zero-CPU passthrough of the tier's native H.264 — chosen whenever the
 * negotiated bitrate budget can carry the tier's native bitrate.
 * encode: scale/re-encode down to the negotiated budget (CFR input, so x264's
 * frame-count-timed ABR is valid here).
 */
export function decideTier(
  req: NegotiatedVideo,
  main: TierMeta = DEFAULT_MAIN_TIER,
  sub: TierMeta = DEFAULT_SUB_TIER,
  force: "auto" | StreamTier = "auto"
): TierDecision {
  const source: StreamTier =
    force !== "auto" ? force : req.width > sub.width * 1.25 ? "main" : "sub";
  const tier = source === "main" ? main : sub;

  const budget = req.maxBitrateKbps > 0 ? req.maxBitrateKbps : 0;
  const copyFits = budget === 0 || budget >= tier.approxBitrateKbps * 0.9;

  if (copyFits) {
    return {
      source,
      mode: "copy",
      width: tier.width,
      height: tier.height,
      fps: req.fps || 15,
      bitrateKbps: tier.approxBitrateKbps,
    };
  }

  return {
    source,
    mode: "encode",
    width: even(Math.min(req.width || tier.width, tier.width)),
    height: even(Math.min(req.height || tier.height, tier.height)),
    fps: Math.min(req.fps || 15, 30),
    bitrateKbps: budget,
  };
}
