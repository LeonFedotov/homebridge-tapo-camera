# Handoff — homebridge-tapo-hub

Snapshot of state as of 2026-07-10 (v3.0.0-alpha.8). Written for whoever picks
this up next.

## What this fork is

`homebridge-tapo-hub` (npm) / platform `tapo-camera` — kopiro's TAPO plugin with
its streaming layer replaced by a buffered go2rtc source, plus HTML virtual
cameras and mosaics. See `README.md` for features/usage and `CLAUDE.md` for the
architecture map and hard-won constraints. Design rationale:
`docs/superpowers/specs/2026-07-10-buffered-streaming-design.md`.

## Status: working, field-tested

Verified on real hardware (a Raspberry Pi 4 Homebridge host) with a TAPO camera
and an HTML dashboard, local and over the Home-Hub relay:

- Buffered TAPO streaming — local (1080p copy) and remote (sub-tier
  encode-to-budget); RECONFIGURE adapts mid-stream, damped against oscillation.
- HTML virtual camera (Xvfb + surf → x11grab → go2rtc), rendered lazily.
- Mosaic — instant "loading" base, per-tile last-known cover, progressive live
  fill; honors negotiated size/bitrate; capped 10 fps.
- Lazy surf — idle CPU ≈ 0 (measured load ~8 → ~3 after switching off the old
  always-on rendering); `previewRefreshSeconds` keeps idle previews current at a
  chosen duty cycle (min 10 s).
- Disk-persisted last-known snapshots (survive restarts).

## How it's deployed on the Pi (see also the deployment memory)

Not from npm — built locally and installed as a tarball, because a git install
needs the `prepare` build and the host is 32-bit arm:

```bash
npm pack                                   # in this repo
scp homebridge-tapo-hub-*.tgz pi@host:/tmp/<unique>.tgz
# on host, as the homebridge user, from /var/lib/homebridge:
npm install ./that.tgz && sudo systemctl restart homebridge
```

Notes: the Pi is 32-bit userland (`process.arch === "arm"`) — the go2rtc pin
includes `linux_arm`. go2rtc uses dynamic ports each boot (parse them from the
`go2rtc ready (api :N, rtsp :N)` log line). The renamed package (was
`homebridge-tapo-camera-ng`) means the **first install under the new name
re-publishes external accessories** — the camera tiles will need re-adding in
the Home app once, PIN unchanged.

## Open items

1. **Xiaomi cameras** (studio, 192.168.8.x) — powered off when last checked; not
   yet fingerprinted. Once on and flashed for RTSP (Dafang/yi-hack per model),
   they drop into `cameras[]` as plain RTSP and into any mosaic by name.
2. **Upstream** — the `videoMaxBitrate` typo fix is PR kopiro#219 (branch
   `fix-video-max-bitrate-typo`), independent of this fork.
3. **Publishing** — still `3.0.0-alpha.8`, unpublished. Before npm publish:
   decide on the name, drop the alpha tag, and consider whether HTML rendering's
   Linux-only deps belong as optional.
4. **Possible follow-ups** — seed an HTML cover at startup (so the very first
   view isn't the loading base); make Xvfb lazy too (negligible CPU gain, was
   deemed not worth the orphan risk); HomeKit Secure Video from the buffer.

## Testing

`npm test` (pure modules) + `npm run test:integration` (real go2rtc + synthetic
camera → SRTP, no hardware). HTML/x11grab paths are Linux-only — verify on host.
