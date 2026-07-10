# homebridge-tapo-camera-ng

Homebridge plugin for TP-Link TAPO cameras with a **buffered video source**:
a supervised [go2rtc](https://github.com/AlexxIT/go2rtc) relay holds
persistent connections to the camera so HomeKit sessions never touch the
flaky WiFi RTSP path directly.

A hard fork of [kopiro/homebridge-tapo-camera](https://github.com/kopiro/homebridge-tapo-camera)
(all credit for the Tapo API client, ONVIF motion events, and toggle
accessories) that replaces the `homebridge-camera-ffmpeg` streaming layer
entirely.

## Why

With the upstream design, every HomeKit session and snapshot opens its own
RTSP connection to the camera:

| Problem | ng |
|---|---|
| Tapo caps concurrent RTSP clients (~2–4) | Camera sees exactly 2 connections, ever, regardless of viewers |
| Stream-open waits for the camera's next keyframe (~2 s) | Instant start from the relay's GOP cache |
| A WiFi blip kills the live session (spinner until manual retry) | Relay reconnects behind the scenes; sessions respawn automatically |
| `copy` mode ignores HomeKit negotiation — remote viewers get 1080p/2 Mbps through a ~300 kbps relay budget | Per-session tier selection + encode-to-budget when needed |
| Snapshots pull RTSP and wait for a keyframe (seconds) | Milliseconds from the relay's frame endpoint, cached |

## How it works

```
Tapo camera ──RTSP (stream1 + stream2, persistent)──► go2rtc relay (localhost only)
                                                        │  GOP cache · auto-reconnect · frame.jpeg
                        per-HomeKit-session ffmpeg ◄────┘
                          tier: main (1080p) or sub (360p), chosen per negotiation
                          mode: -c:v copy when the budget allows (zero CPU),
                                encode-to-budget otherwise
                          audio: pcm_alaw → AAC-ELD 16 kHz (libfdk_aac)
                        ──► SRTP → HomeKit
```

- **TierPolicy**: local viewers typically copy the 1080p stream; Home-Hub
  relay viewers get the 360p stream, re-encoded only if their negotiated
  bitrate can't carry it as-is.
- **RECONFIGURE** is honored: mid-stream quality changes respawn just the
  session encoder; the SRTP session survives.
- go2rtc (pinned, checksum-verified) is downloaded on install for
  linux-arm64/amd64 and macOS arm64; override with `go2rtcPath`.

## Install

```bash
npm install -g homebridge-tapo-camera-ng
```

Configuration matches upstream (`platform: tapo-camera`, camera credentials,
toggles, `pullInterval` in **milliseconds**), minus the `video*` /
`lowQuality` options which are replaced by automatic tiering. New options:
`disableAudio`, `forceTier` (`auto|main|sub`), `subBitrateKbps`, and
platform-level `go2rtcPath`.

## Development

```bash
npm install              # also downloads the pinned go2rtc for your platform
npm run lint
npm test                 # unit: exact ffmpeg argv, tier policy, relay config
npm run test:integration # full pipeline with a synthetic camera — no hardware:
                         # ffmpeg testsrc → go2rtc → session ffmpeg → SRTP sinks
```

Design doc: `docs/superpowers/specs/2026-07-10-buffered-streaming-design.md`.

## License

ISC. Original plugin © Flavio De Stefano; ng streaming layer © Leon Fedotov.
