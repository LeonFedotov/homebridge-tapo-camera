# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

`homebridge-tapo-hub` — a hard fork of kopiro/homebridge-tapo-camera that
replaces the `homebridge-camera-ffmpeg` streaming layer with a **buffered
go2rtc source**, and adds **HTML virtual cameras** and **mosaics**. The
Homebridge platform name is still `tapo-camera` (config compatibility); the npm
package and `PLUGIN_ID` are `homebridge-tapo-hub`.

Kept from upstream (don't rewrite without reason): `src/tapoCamera.ts` (TAPO
encrypted API client), `src/onvifCamera.ts` (ONVIF motion), the toggle/motion
accessories and status polling in `src/cameraAccessory.ts`.

## Architecture

Everything is a **go2rtc stream** on localhost; HomeKit sessions read the relay,
never the camera.

- `src/streaming/go2rtcManager.ts` — supervises the bundled go2rtc child
  (pinned version + sha256 in `scripts/download-go2rtc.mjs`), generates
  localhost-only config, exposes `getSourceUrl`/`getFrame`. Sources are `rtsp`
  (TAPO/RTSP, two tiers) or `exec` (HTML capture command).
- `src/streaming/tierPolicy.ts` — pure: negotiated w/h/bitrate → `{source, mode:
  copy|encode, ...}`. Copy when the budget carries the tier's native bitrate.
- `src/streaming/ffmpegArgs.ts` — pure argv for the per-session TAPO encoder
  (copy/encode × audio). `src/streaming/mosaic.ts` — pure argv for composites
  (loading base → cover stills → live tiles). Both locked by tests.
- `src/streaming/streamingDelegate.ts` — `TapoStreamingDelegate` (TAPO cameras:
  tiers, audio, RECONFIGURE with damping).
- `src/streaming/compositeDelegate.ts` — `CompositeStreamingDelegate` serves a
  1-tile (standalone HTML camera) OR N-tile (mosaic) composite: instant base +
  cover start, progressive live fill, lazy acquire/release of HTML members.
- `src/streaming/htmlRender.ts` + `htmlRenderManager.ts` — Xvfb (always up,
  ~0 idle CPU) + surf (lazy, refcounted); `previewRefresher.ts` wakes surf
  briefly to refresh idle previews.
- `src/streaming/snapshotStore.ts` — per-camera last-known JPEG, persisted to
  `<storage>/tapo-camera-ng/snapshots/`.
- `src/cameraPlatform.ts` wires it all; `src/cameraAccessory.ts` keeps the TAPO
  path.

## Commands

```bash
npm install              # postinstall downloads the pinned go2rtc for this arch
npm run lint             # eslint, --max-warnings=0
npm test                 # tsc + node --test (pure modules, run against dist/)
npm run test:integration # real go2rtc + synthetic camera → SRTP; no hardware
npm run build            # tsc → dist/
```

`dist/` is committed and shipped (`files` + `prepare` builds on git install).
Rebuild and commit `dist/` with any `src/` change.

## Hard-won constraints (do not regress — each cost a debugging cycle)

- **`-payload_type` from the request on every RTP output.** ffmpeg defaults to
  96; iOS silently discards mismatched packets → eternal spinner, healthy logs.
- **Honor the negotiated bitrate/resolution.** An uncapped stream shoved through
  a ~300 kbps relay never assembles on the client (spinner) while snapshots
  still work — that symptom = bitrate over budget or first-frame latency, NOT
  necessarily payload type.
- **x264 rate control is frame-count-timed.** ABR/VBV are valid only on CFR
  input. All relay/composite streams here are CFR; the html-camera project's
  VFR onchange work needed pure CRF instead.
- **ffmpeg drops options after the last output URL** — output URL stays last
  (tests enforce it).
- **A dead/404 input aborts ffmpeg**; a *slow* input does not stall a lavfi
  base. Composites only ever reference sources confirmed to be producing
  content; not-ready/dead tiles stay cover/loading.
- **go2rtc `exec:` sources need the `exec:` prefix** or nothing runs.
- **HTML capture needs an x11grab ffmpeg** — `ffmpeg-for-homebridge` (used for
  audio) does NOT have it; `resolveX11grabFfmpeg` finds a separate one.
- **Child processes:** drain stderr (debug), `error` handlers everywhere,
  identity-guard respawns (`session.ffmpeg !== child` → ignore), backoff.
- **Lazy surf:** keep Xvfb warm (idle ~0 CPU; cold start is ~2.5 s of surf/
  WebKit regardless). Killing a WebKit process is futile — supervision respawns
  it; control lifetime via the render manager / config instead.
- **Config surface** (`disableAudio`, `forceTier`, `subBitrateKbps`, camera
  fields; `htmlCameras`, `mosaics`, `previewRefreshSeconds`, `go2rtcPath`,
  `surfPath`, `htmlFfmpegPath`) must stay in sync across `src/cameraAccessory.ts`
  / `src/cameraPlatform.ts` / `src/streaming/htmlRender.ts`, `config.schema.json`,
  and the README.

## Testing philosophy

Pure argv/policy/store modules have exact-value unit tests — when you change an
ffmpeg flag deliberately, update the locked test in the same commit and note the
HomeKit testing done (local AND remote/Home-Hub relay). The integration harness
proves the whole relay→session→SRTP path with a synthetic camera, so most
regressions are caught without hardware. HTML rendering (x11grab) is Linux-only;
verify it on the target host.
