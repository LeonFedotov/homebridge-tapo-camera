import { ChildProcess, spawn } from "child_process";
import { createSocket, Socket } from "dgram";
import ffmpegForHomebridge from "ffmpeg-for-homebridge";
import type {
  CameraController,
  CameraControllerOptions,
  CameraStreamingDelegate,
  HAP,
  Logging,
  PrepareStreamCallback,
  PrepareStreamRequest,
  PrepareStreamResponse,
  SnapshotRequest,
  SnapshotRequestCallback,
  StartStreamRequest,
  StreamingRequest,
  StreamRequestCallback,
} from "homebridge";
import { buildMosaicArgs, buildMosaicSnapshotArgs, MosaicTile } from "./mosaic";
import { SourceProvider } from "./sourceProvider";

// A glance view: smooth and cheap beats sharp. Cap fps low.
const MOSAIC_MAX_FPS = 10;
const CANVAS_W = 1280;
const CANVAS_H = 720;
const RESPAWN_DEBOUNCE_MS = 600;
const SNAPSHOT_CACHE_MS = 10_000;
const SNAPSHOT_TIMEOUT_MS = 6_000;
const READY_TTL_MS = 30_000;

type SessionInfo = {
  address: string;
  videoPort: number;
  videoReturnSocket: Socket;
  videoSRTP: Buffer;
  videoSSRC: number;
};

type ActiveSession = {
  info: SessionInfo;
  ffmpeg: ChildProcess | null;
  timeout: NodeJS.Timeout | null;
  respawnTimer: NodeJS.Timeout | null;
  videoPt: number;
  mtu: number;
  fps: number;
  width: number;
  height: number;
  maxBitrateKbps: number;
  readySlots: Set<number>;
};

export type MosaicDelegateOptions = {
  name: string;
  provider: SourceProvider;
  memberIds: string[];
};

export class MosaicStreamingDelegate implements CameraStreamingDelegate {
  public readonly controller: CameraController;
  private readonly ffmpegPath: string;
  private readonly totalSlots: number;
  private readonly pendingSessions = new Map<string, SessionInfo>();
  private readonly ongoingSessions = new Map<string, ActiveSession>();
  private stopped = false;

  // Members known to be producing recently — reused for cheap snapshots.
  private knownReady = new Map<number, number>(); // slot → last-ready timestamp(ms)
  private snapshotCache: { data: Buffer; takenAt: number } | null = null;

  constructor(
    private readonly log: Logging,
    private readonly hap: HAP,
    private readonly opts: MosaicDelegateOptions
  ) {
    this.ffmpegPath = ffmpegForHomebridge || "ffmpeg";
    this.totalSlots = opts.memberIds.length;

    const options: CameraControllerOptions = {
      cameraStreamCount: 2,
      delegate: this,
      streamingOptions: {
        supportedCryptoSuites: [hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: {
          resolutions: [
            [320, 180, MOSAIC_MAX_FPS],
            [480, 270, MOSAIC_MAX_FPS],
            [640, 360, MOSAIC_MAX_FPS],
            [1280, 720, MOSAIC_MAX_FPS],
          ],
          codec: {
            profiles: [hap.H264Profile.BASELINE, hap.H264Profile.MAIN, hap.H264Profile.HIGH],
            levels: [hap.H264Level.LEVEL3_1, hap.H264Level.LEVEL3_2, hap.H264Level.LEVEL4_0],
          },
        },
        audio: { twoWayAudio: false, codecs: [] },
      },
    };
    this.controller = new hap.CameraController(options);
  }

  private tilesFor(slots: Set<number>): MosaicTile[] {
    const tiles: MosaicTile[] = [];
    for (let slot = 0; slot < this.totalSlots; slot++) {
      if (slots.has(slot)) {
        tiles.push({ slot, url: this.opts.provider.getSourceUrl(this.opts.memberIds[slot], "sub") });
      }
    }
    return tiles;
  }

  // ---- snapshots (cheap: base + last-known-ready tiles, cached, bounded) ----
  handleSnapshotRequest(_request: SnapshotRequest, callback: SnapshotRequestCallback): void {
    const cached = this.snapshotCache;
    if (cached && Date.now() - cached.takenAt < SNAPSHOT_CACHE_MS) {
      callback(undefined, cached.data);
      return;
    }
    if (!this.opts.provider.isReady()) {
      callback(new Error("Video source not ready"));
      return;
    }

    const now = Date.now();
    const ready = new Set<number>();
    for (const [slot, ts] of this.knownReady) {
      if (now - ts < READY_TTL_MS) ready.add(slot);
    }
    void this.refreshReadiness(); // warm for next time, non-blocking

    const ffmpeg = spawn(
      this.ffmpegPath,
      buildMosaicSnapshotArgs(this.totalSlots, this.tilesFor(ready), CANVAS_W, CANVAS_H)
    );
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (err?: Error, data?: Buffer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (data && data.length > 0) {
        this.snapshotCache = { data, takenAt: Date.now() };
        callback(undefined, data);
      } else {
        callback(err ?? new Error("Mosaic snapshot produced no image"));
      }
    };
    const timer = setTimeout(() => {
      try {
        ffmpeg.kill("SIGKILL");
      } catch {
        /* gone */
      }
      finish(new Error("Mosaic snapshot timed out"));
    }, SNAPSHOT_TIMEOUT_MS);
    ffmpeg.stdout?.on("data", (d: Buffer) => chunks.push(d));
    ffmpeg.stderr?.on("data", (d: Buffer) => this.log.debug(`[${this.opts.name}] snap: ${d.toString().trim()}`));
    ffmpeg.on("error", (err) => finish(err));
    ffmpeg.on("close", () => finish(undefined, Buffer.concat(chunks)));
  }

  // Probe each member (also warms it); mark ready ones. Bounded, best-effort.
  private async refreshReadiness(onReady?: (slot: number) => void): Promise<void> {
    await Promise.allSettled(
      this.opts.memberIds.map(async (id, slot) => {
        try {
          await this.opts.provider.getFrame(id);
          this.knownReady.set(slot, Date.now());
          onReady?.(slot);
        } catch {
          /* not ready / dead — stays a loading tile */
        }
      })
    );
  }

  async prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): Promise<void> {
    const videoReturnSocket = createSocket(request.addressVersion === "ipv6" ? "udp6" : "udp4");
    try {
      const videoReturnPort = await new Promise<number>((resolve, reject) => {
        videoReturnSocket.once("error", reject);
        videoReturnSocket.bind(0, () => {
          videoReturnSocket.removeListener("error", reject);
          resolve(videoReturnSocket.address().port);
        });
      });
      const audioReturnPort = await this.pickPort();
      const videoSSRC = this.hap.CameraController.generateSynchronisationSource();
      const audioSSRC = this.hap.CameraController.generateSynchronisationSource();
      this.pendingSessions.set(request.sessionID, {
        address: request.targetAddress,
        videoPort: request.video.port,
        videoReturnSocket,
        videoSRTP: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]),
        videoSSRC,
      });
      callback(undefined, {
        video: {
          port: videoReturnPort,
          ssrc: videoSSRC,
          srtp_key: request.video.srtp_key,
          srtp_salt: request.video.srtp_salt,
        },
        audio: {
          port: audioReturnPort,
          ssrc: audioSSRC,
          srtp_key: request.audio.srtp_key,
          srtp_salt: request.audio.srtp_salt,
        },
      } as PrepareStreamResponse);
    } catch (err) {
      try {
        videoReturnSocket.close();
      } catch {
        /* never bound */
      }
      callback(err as Error);
    }
  }

  handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
    switch (request.type) {
      case this.hap.StreamRequestTypes.START:
        this.startStream(request, callback);
        break;
      case this.hap.StreamRequestTypes.RECONFIGURE: {
        const session = this.ongoingSessions.get(request.sessionID);
        if (session) {
          const neg = this.negotiate(request.video);
          if (neg.width !== session.width || neg.height !== session.height || neg.maxBitrateKbps !== session.maxBitrateKbps) {
            session.width = neg.width;
            session.height = neg.height;
            session.fps = neg.fps;
            session.maxBitrateKbps = neg.maxBitrateKbps;
            this.respawn(request.sessionID, session);
          }
        }
        callback();
        break;
      }
      case this.hap.StreamRequestTypes.STOP:
        this.stopStream(request.sessionID);
        callback();
        break;
    }
  }

  private negotiate(video: { width?: number; height?: number; fps?: number; max_bit_rate?: number }) {
    const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
    return {
      width: even(Math.min(video.width || CANVAS_W, CANVAS_W)),
      height: even(Math.min(video.height || CANVAS_H, CANVAS_H)),
      fps: Math.min(video.fps || MOSAIC_MAX_FPS, MOSAIC_MAX_FPS),
      maxBitrateKbps: video.max_bit_rate || 0,
    };
  }

  private startStream(request: StartStreamRequest, callback: StreamRequestCallback): void {
    const info = this.pendingSessions.get(request.sessionID);
    if (!info) {
      callback(new Error("Session not found"));
      return;
    }
    if (!this.opts.provider.isReady()) {
      try {
        info.videoReturnSocket.close();
      } catch {
        /* closed */
      }
      this.pendingSessions.delete(request.sessionID);
      callback(new Error("Video source not ready"));
      return;
    }

    const neg = this.negotiate(request.video);
    // Seed from recently-known-ready members so warm tiles show at once.
    const now = Date.now();
    const seeded = new Set<number>();
    for (const [slot, ts] of this.knownReady) if (now - ts < READY_TTL_MS) seeded.add(slot);

    const session: ActiveSession = {
      info,
      ffmpeg: null,
      timeout: null,
      respawnTimer: null,
      videoPt: request.video.pt,
      mtu: request.video.mtu || 1316,
      fps: neg.fps,
      width: neg.width,
      height: neg.height,
      maxBitrateKbps: neg.maxBitrateKbps,
      readySlots: seeded,
    };

    this.log.info(
      `[${this.opts.name}] Starting mosaic: ${this.totalSlots} tiles, ${session.width}x${session.height}@${session.fps} ${session.maxBitrateKbps}kbps, pt=${session.videoPt}`
    );

    const armIdleTimeout = () => {
      if (session.timeout) clearTimeout(session.timeout);
      const timeout = Math.max(30_000, request.video.rtcp_interval * 5 * 1000);
      session.timeout = setTimeout(() => {
        this.controller.forceStopStreamingSession(request.sessionID);
        this.stopStream(request.sessionID);
      }, timeout);
    };
    info.videoReturnSocket.on("error", (err) => {
      this.log.warn(`[${this.opts.name}] return socket error: ${err.message}`);
      this.stopStream(request.sessionID);
    });
    info.videoReturnSocket.on("message", armIdleTimeout);
    armIdleTimeout();

    this.ongoingSessions.set(request.sessionID, session);
    this.pendingSessions.delete(request.sessionID);

    // Stream the base (loading tiles + any warm tiles) immediately, then fill
    // in the rest as each member reports ready.
    this.spawnFfmpeg(request.sessionID, session, callback);
    void this.refreshReadiness((slot) => {
      if (this.stopped || !this.ongoingSessions.has(request.sessionID)) return;
      if (session.readySlots.has(slot)) return;
      session.readySlots.add(slot);
      if (session.respawnTimer) clearTimeout(session.respawnTimer);
      session.respawnTimer = setTimeout(() => {
        session.respawnTimer = null;
        this.respawn(request.sessionID, session);
      }, RESPAWN_DEBOUNCE_MS);
    });
  }

  private respawn(sessionId: string, session: ActiveSession): void {
    if (this.stopped || this.ongoingSessions.get(sessionId) !== session) return;
    const old = session.ffmpeg;
    session.ffmpeg = null;
    try {
      old?.kill("SIGKILL");
    } catch {
      /* gone */
    }
    this.spawnFfmpeg(sessionId, session);
  }

  private spawnFfmpeg(sessionId: string, session: ActiveSession, startCallback?: StreamRequestCallback): void {
    const tiles = this.tilesFor(session.readySlots);
    const args = buildMosaicArgs({
      totalSlots: this.totalSlots,
      tiles,
      width: session.width,
      height: session.height,
      fps: session.fps,
      maxBitrateKbps: session.maxBitrateKbps,
      video: {
        address: session.info.address,
        port: session.info.videoPort,
        payloadType: session.videoPt,
        ssrc: session.info.videoSSRC,
        srtpParams: session.info.videoSRTP.toString("base64"),
        mtu: session.mtu,
      },
    });
    this.log.debug(`[${this.opts.name}] mosaic ${tiles.length}/${this.totalSlots} tiles ready`);

    const ffmpeg = spawn(this.ffmpegPath, args);
    session.ffmpeg = ffmpeg;
    let started = false;

    ffmpeg.stderr?.on("data", (d: Buffer) => this.log.debug(d.toString().trim()));
    ffmpeg.on("error", (err) => {
      if (session.ffmpeg !== ffmpeg) return;
      this.log.error(`[${this.opts.name}] mosaic ffmpeg error: ${err.message}`);
      if (startCallback && !started) {
        started = true;
        startCallback(err);
      }
      this.stopStream(sessionId);
    });
    ffmpeg.on("exit", (code) => {
      if (session.ffmpeg !== ffmpeg) return; // replaced by a respawn — ignore
      if (code === 0 || code === null) return;
      if (this.stopped || !this.ongoingSessions.has(sessionId)) return;
      this.log.warn(`[${this.opts.name}] mosaic ffmpeg exited (code=${code})`);
      this.controller.forceStopStreamingSession(sessionId);
      this.stopStream(sessionId);
    });

    if (startCallback && !started) {
      started = true;
      startCallback();
    }
  }

  stopStream(sessionId: string, immediate = false): void {
    const pending = this.pendingSessions.get(sessionId);
    if (pending) {
      try {
        pending.videoReturnSocket.close();
      } catch {
        /* closed */
      }
      this.pendingSessions.delete(sessionId);
    }
    const session = this.ongoingSessions.get(sessionId);
    if (!session) return;
    this.ongoingSessions.delete(sessionId);
    if (session.timeout) clearTimeout(session.timeout);
    if (session.respawnTimer) clearTimeout(session.respawnTimer);
    try {
      session.info.videoReturnSocket.close();
    } catch {
      /* closed */
    }
    const ffmpeg = session.ffmpeg;
    session.ffmpeg = null;
    if (ffmpeg) {
      if (immediate) {
        try {
          ffmpeg.kill("SIGKILL");
        } catch {
          /* gone */
        }
      } else {
        try {
          ffmpeg.stdin?.write("q\n");
        } catch {
          /* gone */
        }
        setTimeout(() => {
          try {
            ffmpeg.kill("SIGKILL");
          } catch {
            /* gone */
          }
        }, 2000).unref();
      }
    }
    this.log.info(`[${this.opts.name}] Mosaic stopped`);
  }

  shutdown(): void {
    this.stopped = true;
    for (const id of [...this.ongoingSessions.keys()]) this.stopStream(id, true);
    for (const [id, info] of this.pendingSessions) {
      try {
        info.videoReturnSocket.close();
      } catch {
        /* closed */
      }
      this.pendingSessions.delete(id);
    }
  }

  private async pickPort(): Promise<number> {
    return new Promise((resolve) => {
      const socket = createSocket("udp4");
      socket.bind(0, () => {
        const port = socket.address().port;
        socket.close(() => resolve(port));
      });
    });
  }
}
