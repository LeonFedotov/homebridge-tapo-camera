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
import { buildMosaicArgs, buildMosaicSnapshotArgs, CoverTile, LiveTile } from "./mosaic";
import { HtmlRenderManager } from "./htmlRenderManager";
import { SnapshotStore } from "./snapshotStore";
import { SourceProvider } from "./sourceProvider";

// A glance view (and single HTML cameras): smooth + cheap beats sharp.
const MAX_FPS = 10;
const CANVAS_W = 1280;
const CANVAS_H = 720;
const RESPAWN_DEBOUNCE_MS = 500;
const SNAPSHOT_CACHE_MS = 10_000;
const SNAPSHOT_TIMEOUT_MS = 6_000;
const READY_PROBE_ATTEMPTS = 10;
const READY_PROBE_INTERVAL_MS = 900;

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
  liveSlots: Set<number>;
  probing: boolean;
};

export type CompositeDelegateOptions = {
  name: string;
  provider: SourceProvider;
  memberIds: string[];
  renderManager: HtmlRenderManager;
  snapshotStore: SnapshotStore;
};

/**
 * Serves one composited camera: a single full-frame tile (standalone HTML
 * camera) or an N-tile grid (mosaic). Starts instantly on a "loading" base +
 * last-known cover stills, lazily warms HTML members (acquire/release), and
 * fills each tile with live video as its source starts producing content.
 */
export class CompositeStreamingDelegate implements CameraStreamingDelegate {
  public readonly controller: CameraController;
  private readonly ffmpegPath: string;
  private readonly totalSlots: number;
  private readonly pendingSessions = new Map<string, SessionInfo>();
  private readonly ongoingSessions = new Map<string, ActiveSession>();
  private stopped = false;
  private snapshotCache: { data: Buffer; takenAt: number } | null = null;

  constructor(
    private readonly log: Logging,
    private readonly hap: HAP,
    private readonly opts: CompositeDelegateOptions
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
            [320, 180, MAX_FPS],
            [480, 270, MAX_FPS],
            [640, 360, MAX_FPS],
            [1280, 720, MAX_FPS],
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

  private covers(): CoverTile[] {
    const out: CoverTile[] = [];
    for (let slot = 0; slot < this.totalSlots; slot++) {
      const path = this.opts.snapshotStore.path(this.opts.memberIds[slot]);
      if (path) out.push({ slot, path });
    }
    return out;
  }

  private liveTiles(slots: Set<number>): LiveTile[] {
    const out: LiveTile[] = [];
    for (const slot of slots) {
      out.push({ slot, url: this.opts.provider.getSourceUrl(this.opts.memberIds[slot], "sub") });
    }
    return out;
  }

  // ---- snapshots (base + covers + live; cached; bounded) --------------------
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
    const args = buildMosaicSnapshotArgs({
      totalSlots: this.totalSlots,
      width: CANVAS_W,
      height: CANVAS_H,
      covers: this.covers(),
      live: [],
    });
    const ffmpeg = spawn(this.ffmpegPath, args);
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
        callback(err ?? new Error("snapshot produced no image"));
      }
    };
    const timer = setTimeout(() => {
      try {
        ffmpeg.kill("SIGKILL");
      } catch {
        /* gone */
      }
      finish(new Error("snapshot timed out"));
    }, SNAPSHOT_TIMEOUT_MS);
    ffmpeg.stdout?.on("data", (d: Buffer) => chunks.push(d));
    ffmpeg.stderr?.on("data", (d: Buffer) => this.log.debug(`[${this.opts.name}] snap: ${d.toString().trim()}`));
    ffmpeg.on("error", (err) => finish(err));
    ffmpeg.on("close", () => finish(undefined, Buffer.concat(chunks)));
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
      fps: Math.min(video.fps || MAX_FPS, MAX_FPS),
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

    // Warm every member (no-op for non-HTML); surf starts for HTML members.
    for (const id of this.opts.memberIds) this.opts.renderManager.acquire(id);

    const neg = this.negotiate(request.video);
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
      liveSlots: new Set(),
      probing: false,
    };

    this.log.info(
      `[${this.opts.name}] Starting: ${this.totalSlots} tile(s), ${session.width}x${session.height}@${session.fps} ${session.maxBitrateKbps}kbps, pt=${session.videoPt}`
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

    // Stream base + cover stills immediately; fill live tiles as they warm up.
    this.spawnFfmpeg(request.sessionID, session, callback);
    void this.probeMembers(request.sessionID, session);
  }

  // Poll each member until it produces content; add live tiles progressively.
  private async probeMembers(sessionId: string, session: ActiveSession): Promise<void> {
    if (session.probing) return;
    session.probing = true;
    const pending = new Set(this.opts.memberIds.map((_, i) => i));
    for (let attempt = 0; attempt < READY_PROBE_ATTEMPTS && pending.size > 0; attempt++) {
      await Promise.allSettled(
        [...pending].map(async (slot) => {
          try {
            const frame = await this.opts.provider.getFrame(this.opts.memberIds[slot]);
            this.opts.snapshotStore.put(this.opts.memberIds[slot], frame); // refresh cover
            pending.delete(slot);
            if (this.stopped || this.ongoingSessions.get(sessionId) !== session) return;
            if (!session.liveSlots.has(slot)) {
              session.liveSlots.add(slot);
              this.scheduleRespawn(sessionId, session);
            }
          } catch {
            /* not producing content yet / dead — retry */
          }
        })
      );
      if (this.stopped || this.ongoingSessions.get(sessionId) !== session) return;
      if (pending.size > 0) await new Promise((r) => setTimeout(r, READY_PROBE_INTERVAL_MS));
    }
  }

  private scheduleRespawn(sessionId: string, session: ActiveSession): void {
    if (session.respawnTimer) clearTimeout(session.respawnTimer);
    session.respawnTimer = setTimeout(() => {
      session.respawnTimer = null;
      this.respawn(sessionId, session);
    }, RESPAWN_DEBOUNCE_MS);
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
    const args = buildMosaicArgs({
      totalSlots: this.totalSlots,
      width: session.width,
      height: session.height,
      fps: session.fps,
      maxBitrateKbps: session.maxBitrateKbps,
      covers: this.covers(),
      live: this.liveTiles(session.liveSlots),
      video: {
        address: session.info.address,
        port: session.info.videoPort,
        payloadType: session.videoPt,
        ssrc: session.info.videoSSRC,
        srtpParams: session.info.videoSRTP.toString("base64"),
        mtu: session.mtu,
      },
    });
    this.log.debug(`[${this.opts.name}] ${session.liveSlots.size}/${this.totalSlots} live tiles`);

    const ffmpeg = spawn(this.ffmpegPath, args);
    session.ffmpeg = ffmpeg;
    let started = false;
    ffmpeg.stderr?.on("data", (d: Buffer) => this.log.debug(d.toString().trim()));
    ffmpeg.on("error", (err) => {
      if (session.ffmpeg !== ffmpeg) return;
      this.log.error(`[${this.opts.name}] ffmpeg error: ${err.message}`);
      if (startCallback && !started) {
        started = true;
        startCallback(err);
      }
      this.stopStream(sessionId);
    });
    ffmpeg.on("exit", (code) => {
      if (session.ffmpeg !== ffmpeg) return; // replaced by a respawn
      if (code === 0 || code === null) return;
      if (this.stopped || !this.ongoingSessions.has(sessionId)) return;
      this.log.warn(`[${this.opts.name}] ffmpeg exited (code=${code})`);
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
    for (const id of this.opts.memberIds) this.opts.renderManager.release(id);
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
    this.log.info(`[${this.opts.name}] Stopped`);
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
