# homebridge-tapo-hub

HomeKit camera plugin for TP-Link **TAPO** (and any RTSP) cameras, built around
a **buffered [go2rtc](https://github.com/AlexxIT/go2rtc) source**. It adds three
things on top of a normal camera bridge:

- **Resilient streaming** — the plugin holds the camera connection through a
  local relay, so HomeKit never touches the flaky Wi‑Fi RTSP path directly.
- **HTML virtual cameras** — render any web page (a dashboard, a status panel)
  as a HomeKit camera.
- **Mosaics** — tile several cameras into one HomeKit camera for an at‑a‑glance
  view.

A hard fork of [kopiro/homebridge-tapo-camera](https://github.com/kopiro/homebridge-tapo-camera)
(all credit for the TAPO API client, ONVIF motion events, and toggle
accessories); this fork replaces the `homebridge-camera-ffmpeg` streaming layer
entirely. The Homebridge platform is still `tapo-camera`, so existing configs
keep working.

## Why a buffered source

With a plain camera bridge, every HomeKit session and snapshot opens its own
RTSP connection to the camera:

| Problem | homebridge-tapo-hub |
|---|---|
| TAPO caps concurrent RTSP clients (~2–4) | The camera sees a fixed, small number of connections regardless of viewers |
| Stream open waits for the camera's next keyframe (~2 s) | Instant start from the relay's GOP cache |
| A Wi‑Fi blip kills the live view (spinner until manual retry) | The relay reconnects behind the scenes; sessions self‑heal |
| `copy` ignores HomeKit negotiation — remote viewers get 1080p/2 Mbps through a ~300 kbps relay | Per‑session resolution + bitrate, matched to what the client asked for |
| Snapshots pull RTSP and wait for a keyframe | Served from the relay's frame endpoint, cached |

## How it works

```
TAPO / RTSP camera ──►┐
HTML page (Xvfb+surf) ─┼─► go2rtc relay (localhost) ──► per‑session ffmpeg ──► SRTP ──► HomeKit
another camera ───────►┘     GOP cache · reconnect · frame.jpeg     copy or encode‑to‑budget
```

- **go2rtc** (bundled, pinned, checksum‑verified; auto‑downloaded on install)
  is the buffered relay. It binds localhost only.
- Each **HomeKit session** spawns an ffmpeg that reads the *relay*, never the
  camera — copying the stream when the negotiated budget allows, or
  re‑encoding down to it.
- **HTML cameras** render on a headless X display (Xvfb + suckless *surf*) and
  are captured into the relay. `surf` runs **only while a client is watching**
  (idle cost ≈ 0); an optional timer keeps the preview fresh.
- **Mosaics** composite the sub‑streams of their members into one grid, tile by
  tile, showing each camera's last‑known frame until its live feed is ready.

## Requirements

- Homebridge 1.11+ or 2.x, Node 18/20/22/24.
- Linux host for HTML cameras (needs `xvfb`, `surf`, `unclutter`, and an
  ffmpeg with `x11grab`). TAPO/RTSP cameras and mosaics work anywhere Node +
  ffmpeg do. go2rtc is fetched automatically for linux‑arm64/arm, linux‑amd64,
  and macOS‑arm64.

```bash
sudo apt install xvfb surf unclutter   # only if you use HTML cameras
```

## Install

```bash
npm install -g homebridge-tapo-hub
```

For a private/git install, use a read‑only deploy key rather than a token in
the URL (see the deployment notes in `docs/`).

## Configuration

Platform `tapo-camera`. Minimal:

```jsonc
{
  "platform": "tapo-camera",
  "cameras": [
    {
      "name": "Front Door",
      "ipAddress": "192.168.0.208",
      "username": "you@example.com",   // TAPO account email
      "password": "•••",                // TAPO account password
      "streamUser": "tapouser",         // RTSP account (TAPO app → Advanced → Camera Account)
      "streamPassword": "•••"
    }
  ]
}
```

Full example with HTML cameras and a mosaic:

```jsonc
{
  "platform": "tapo-camera",
  "cameras": [
    { "name": "Front Door", "ipAddress": "192.168.0.208", "username": "…", "password": "…", "streamUser": "tapouser", "streamPassword": "…" }
  ],
  "htmlCameras": [
    { "name": "Dashboard", "url": "http://localhost:8123/lovelace/0", "width": 1280, "height": 720, "fps": 15, "previewRefreshSeconds": 30 }
  ],
  "mosaics": [
    { "name": "Everything", "cameras": ["Front Door", "Dashboard"] }
  ],
  "go2rtcPath": "",        // optional override; default = bundled
  "surfPath": "/usr/bin/surf",
  "htmlFfmpegPath": ""     // optional; needs x11grab (ffmpeg-for-homebridge lacks it)
}
```

### Camera options (per entry in `cameras`)

Credentials and the toggle/motion accessories are unchanged from upstream
(`streamUser`/`streamPassword`, the `disable*ToggleAccessory` flags,
`pullInterval` in **milliseconds**). Streaming‑specific:

| Option | Default | Meaning |
|---|---|---|
| `disableAudio` | `false` | Drop one‑way audio |
| `forceTier` | `auto` | Pin sessions to the camera's `main` or `sub` stream instead of auto‑selecting |
| `subBitrateKbps` | `1024` | Approx. bitrate of the camera's low stream, used for the copy‑vs‑encode decision |

### HTML cameras (`htmlCameras`)

| Option | Default | Meaning |
|---|---|---|
| `name`, `url` | (required) | Camera name and page to render |
| `width`/`height`/`fps` | 1280/720/15 | Render + capture size and rate |
| `previewRefreshSeconds` | off | Keep the idle Home‑app preview current by briefly rendering every N seconds (min 10; 0 = off). Higher = fresher previews at more CPU, since a preview of a rendered page requires rendering it. |

### Mosaics (`mosaics`)

Each `{ name, cameras: [...] }` tiles the listed cameras (by name; TAPO or HTML)
into one HomeKit camera, in grid order. Omit `mosaics` for one automatic mosaic
of all cameras (only created when there are 2+). Mosaics are capped at 10 fps
and optimise for a smooth, low‑CPU glance rather than sharpness.

### Platform options

| Option | Meaning |
|---|---|
| `go2rtcPath` | Path to a go2rtc binary (default: bundled, auto‑downloaded) |
| `surfPath` | Path to `surf` for HTML cameras (default `/usr/bin/surf`) |
| `htmlFfmpegPath` | Path to an x11grab‑capable ffmpeg (auto‑detected if unset) |
| `previewRefreshSeconds` | Default preview refresh for all HTML cameras |

## Behaviour notes

- **Lazy HTML rendering.** `surf` renders only while a client watches, stopping
  ~15 s after the last viewer leaves. Idle previews show the last captured
  frame (or a "loading" tile the very first time); `previewRefreshSeconds`
  keeps them current. TAPO previews are always live per snapshot poll.
- **Cold start.** An HTML camera's first live frame takes ~2.5 s (surf render);
  the last‑known snapshot is shown instantly meanwhile, then it cuts to live.
- **Everything is lazy.** With nobody watching, no ffmpeg and no `surf` run —
  only the tiny Xvfb display(s) and the go2rtc relay idle in the background.

## Development

```bash
npm install              # also downloads the pinned go2rtc for your platform
npm run lint
npm test                 # unit: exact ffmpeg argv, tier policy, mosaic, store
npm run test:integration # full pipeline with a synthetic camera — no hardware
```

Design + deployment notes live in `docs/`.

## License

ISC. Original plugin © Flavio De Stefano; hub/streaming layer © Leon Fedotov.
