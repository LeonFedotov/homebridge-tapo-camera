# homebridge-tapo-camera-ng: buffered streaming design

Date: 2026-07-10. Status: approved.

## Problem

The upstream plugin delegates streaming to homebridge-camera-ffmpeg with
`vcodec: copy`: every HomeKit session and snapshot opens its own RTSP
connection straight to the camera. Consequences, all observed in production:

- Tapo cameras cap concurrent RTSP clients (~2–4); sessions + snapshots + any
  NVR compete for slots.
- Stream-open latency is bounded by the camera's GOP (~2.1 s measured): the
  session must wait for the next keyframe.
- A WiFi blip kills the session's ffmpeg; the viewer gets a spinner until they
  manually retry.
- `copy` ignores everything HomeKit negotiates: remote (Home-Hub relay)
  viewers receive the full 1080p/1–2 Mbps main stream through a ~300 kbps
  budget.
- Snapshots pull RTSP + wait for a keyframe: seconds, per request.

## Approach (approved: "A")

One supervised **go2rtc** child (v1.9.14, pinned, checksum-verified) holds
exactly two persistent RTSP connections per camera — `stream1` (1080p) and
`stream2` (360p) — with auto-reconnect and GOP cache, restreamed on
`127.0.0.1` (RTSP + JPEG frame API). A custom `CameraStreamingDelegate`
(replacing homebridge-camera-ffmpeg) serves HomeKit **from the relay, never
the camera**:

- Per-session ffmpeg reads `rtsp://127.0.0.1/…` — instant IDR from the GOP
  cache, camera connection count constant regardless of viewers.
- **TierPolicy** (pure function) maps the negotiated width/height/bitrate to
  `{source: main|sub, mode: copy|encode}`: local viewers copy 1080p, relay
  viewers get 360p; `copy` whenever the tier's native bitrate fits the
  negotiated budget, `encode` (our locked x264 baseline, ABR — CFR input so
  x264's frame-count-timed rate control is valid) only when the wire demands
  less than the tier produces.
- Audio: one-way, per-session transcode `pcm_alaw → AAC-ELD 16 kHz` via
  `libfdk_aac` (ffmpeg-for-homebridge), carrying upstream's
  `aresample=async=16000` DTS-jitter fix. `disableAudio` opt-out.
- Snapshots: go2rtc `api/frame.jpeg?src=<sub>` + 5 s cache + 8 s timeout +
  stale-on-error.
- RECONFIGURE: re-run TierPolicy, respawn only the session ffmpeg (identity
  guards); SRTP session/sockets persist. Return sockets are bound at
  prepareStream and held (port-steal fix).
- Kept from upstream (with attribution): Tapo encrypted API client, ONVIF
  motion events, toggle accessories, status polling.

Rejected alternatives: pure-TS RTSP/GOP buffer (weeks of protocol work; kept
possible behind the `SourceProvider` interface), supervision-only without a
relay (fails the connection-limit / instant-start / blip-absorption goals).

## Components

| Module | Responsibility |
|---|---|
| `src/streaming/sourceProvider.ts` | Interface: register cameras, resolve local source URLs, fetch frames, lifecycle |
| `src/streaming/go2rtcManager.ts` | SourceProvider impl: binary resolution, YAML config generation (localhost-only), spawn/supervise with exponential backoff + identity guards, health poll, port allocation |
| `src/streaming/tierPolicy.ts` | Pure negotiation → `{source, mode, encode params}` |
| `src/streaming/ffmpegArgs.ts` | Pure argv builders (copy/encode × audio on/off); output URLs always terminal |
| `src/streaming/snapshotService.ts` | Frame fetch, cache, timeout, stale fallback |
| `src/streaming/streamingDelegate.ts` | HAP glue: prepare/start/reconfigure/stop, session registry, idle timeout via RTCP return socket |
| `scripts/download-go2rtc.mjs` | postinstall: pinned v1.9.14 per-platform download + sha256 verify (`GO2RTC_PATH`/config override, soft-fail with clear runtime error) |

Pinned binaries (sha256):
- `go2rtc_linux_arm64` `359fabade8a7a51e81a55fe6df6b0ef81764a5e1d63179577534eaaa71904b50`
- `go2rtc_linux_amd64` `32d616af226bd731678ffde328b94cfb94e30339bfefc469cfb76323144615a6`
- `go2rtc_mac_arm64.zip` `919b78adc759d6b3883d1e1b2ac915ac0985bb903ff1897b4d228527bd64690c`

## Hard-won constraints baked in (from homekit-html-camera)

- `-payload_type` from the request on every RTP output — iOS silently
  discards mismatched packets.
- ffmpeg drops most options after the last output URL: outputs terminal,
  enforced by tests.
- x264 rate control is frame-count-timed: ABR/VBV only on CFR streams (all
  streams here are CFR — encode mode is safe; the html-camera VFR lesson
  documented for future onchange-style work).
- Child processes: always drain stderr (debug level), `error` handlers
  everywhere, intentional-replacement identity guards, backoff with stability
  reset.
- Logging: lifecycle + one line per session at info; mechanics at debug.

## Config (schema)

Kept: name/ipAddress/password/streamUser/streamPassword, toggles, pullInterval.
New: `disableAudio` (bool), `forceTier` (`auto|main|sub`), `go2rtcPath`
(string), `subBitrateKbps` (int, default 1024 — copy-vs-encode threshold).
Removed vs upstream: `videoConfig` passthrough, `videoMax*`, `videoCodec`,
`lowQuality` (deprecated no-op with warning — tiering is automatic).

## Testing

1. **Unit** (`node --test`, against `dist/`): exact argv for
   copy/encode/audio variants incl. terminal-output guard; TierPolicy decision
   table; go2rtc YAML generation; snapshot cache/stale behavior.
2. **Integration without a camera** (`npm run test:integration`, macOS/Linux):
   launch the real go2rtc with an `exec:ffmpeg -f lavfi testsrc → rtsp {output}`
   fake camera; assert `/api/frame.jpeg` returns a JPEG and the localhost RTSP
   restream is probeable; exercise buildSessionArgs against the restream to a
   local SRTP sink.
3. **On-Pi acceptance**: the validated checklist — local view (1080p copy),
   relay view (sub tier), RECONFIGURE mid-stream, WiFi-pull resilience drill
   (camera off/on: sessions recover without user action), snapshot latency,
   camera RTSP client count.

## v2 doors (explicitly out of scope)

HomeKit Secure Video (fMP4 from the relay), WebRTC (go2rtc native), PTZ,
pure-TS SourceProvider.
