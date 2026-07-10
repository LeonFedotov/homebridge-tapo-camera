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
import {
  buildMosaicArgs,
  buildMosaicSnapshotArgs,
  MOSAIC_CANVAS_H,
  MOSAIC_CANVAS_W,
} from "./mosaic";
import { SourceProvider } from "./sourceProvider";
import { shouldApplyReconfigure } from "./tierPolicy";

const RESPAWN_MAX = 5;
const RESPAWN_DELAY_MS = 3_000;
const RESPAWN_RESET_MS = 60_000;
const SNAPSHOT_CACHE_MS = 5_000;
const SNAPSHOT_TIMEOUT_MS = 12_000;

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
  videoPt: number;
  mtu: number;
  fps: number;
  width: number;
  height: number;
  maxBitrateKbps: number;
  lastChangeAt: number;
  respawns: number;
};

/** Clamp a HomeKit-negotiated video request to the mosaic canvas. */
function negotiate(video: {
  width?: number;
  height?: number;
  fps?: number;
  max_bit_rate?: number;
}): { width: number; height: number; fps: number; maxBitrateKbps: number } {
  const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
  return {
    width: even(Math.min(video.width || MOSAIC_CANVAS_W, MOSAIC_CANVAS_W)),
    height: even(Math.min(video.height || MOSAIC_CANVAS_H, MOSAIC_CANVAS_H)),
    fps: Math.min(video.fps || 15, 15),
    maxBitrateKbps: video.max_bit_rate || 0,
  };
}

export type MosaicDelegateOptions = {
  name: string;
  provider: SourceProvider;
  /** Member camera ids; their sub-tier relay streams are composited. */
  memberIds: string[];
};

/**
 * A synthetic camera that composites the sub-tier streams of every real
 * camera into one grid. Reuses the same session lifecycle as the per-camera
 * delegate (held return sockets, payload_type, respawn-on-death, idle
 * timeout) but with a fixed 720p output, no audio, and no tier/reconfigure
 * logic — the mosaic is a single fixed-quality glance view.
 */
export class MosaicStreamingDelegate implements CameraStreamingDelegate {
  public readonly controller: CameraController;
  private readonly ffmpegPath: string;
  private readonly pendingSessions = new Map<string, SessionInfo>();
  private readonly ongoingSessions = new Map<string, ActiveSession>();
  private stopped = false;
  private lastSnapshot: { data: Buffer; takenAt: number } | null = null;

  constructor(
    private readonly log: Logging,
    private readonly hap: HAP,
    private readonly opts: MosaicDelegateOptions
  ) {
    this.ffmpegPath = ffmpegForHomebridge || "ffmpeg";

    const options: CameraControllerOptions = {
      cameraStreamCount: 2,
      delegate: this,
      streamingOptions: {
        supportedCryptoSuites: [hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: {
          resolutions: [
            [320, 180, 15],
            [480, 270, 15],
            [640, 360, 15],
            [1280, 720, 15],
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

  private sourceUrls(): string[] {
    return this.opts.memberIds.map((id) =>
      this.opts.provider.getSourceUrl(id, "sub")
    );
  }

  handleSnapshotRequest(
    _request: SnapshotRequest,
    callback: SnapshotRequestCallback
  ): void {
    const cached = this.lastSnapshot;
    if (cached && Date.now() - cached.takenAt < SNAPSHOT_CACHE_MS) {
      callback(undefined, cached.data);
      return;
    }
    if (!this.opts.provider.isReady()) {
      callback(new Error("Video source not ready"));
      return;
    }

    const ffmpeg = spawn(this.ffmpegPath, buildMosaicSnapshotArgs(this.sourceUrls()));
    const chunks: Buffer[] = [];
    let stderr = "";
    let done = false;
    const finish = (err?: Error, data?: Buffer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (data && data.length > 0) {
        this.lastSnapshot = { data, takenAt: Date.now() };
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
    ffmpeg.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    ffmpeg.on("error", (err) => finish(err));
    ffmpeg.on("close", () => {
      if (chunks.length === 0) {
        this.log.warn(`[${this.opts.name}] snapshot failed: ${stderr.trim().slice(-200)}`);
      }
      finish(undefined, Buffer.concat(chunks));
    });
  }

  async prepareStream(
    request: PrepareStreamRequest,
    callback: PrepareStreamCallback
  ): Promise<void> {
    const videoReturnSocket = createSocket(
      request.addressVersion === "ipv6" ? "udp6" : "udp4"
    );
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

      const response: PrepareStreamResponse = {
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
      };
      callback(undefined, response);
    } catch (err) {
      try {
        videoReturnSocket.close();
      } catch {
        /* never bound */
      }
      callback(err as Error);
    }
  }

  handleStreamRequest(
    request: StreamingRequest,
    callback: StreamRequestCallback
  ): void {
    switch (request.type) {
      case this.hap.StreamRequestTypes.START:
        this.startStream(request, callback);
        break;
      case this.hap.StreamRequestTypes.RECONFIGURE: {
        const session = this.ongoingSessions.get(request.sessionID);
        if (!session) {
          callback();
          break;
        }
        const n = negotiate(request.video);
        const prev = {
          source: "sub" as const, mode: "encode" as const,
          width: session.width, height: session.height, fps: session.fps,
          bitrateKbps: session.maxBitrateKbps,
        };
        const next = { ...prev, width: n.width, height: n.height, fps: n.fps, bitrateKbps: n.maxBitrateKbps };
        if (!shouldApplyReconfigure(prev, next, Date.now() - session.lastChangeAt)) {
          callback();
          break;
        }
        session.width = n.width;
        session.height = n.height;
        session.fps = n.fps;
        session.maxBitrateKbps = n.maxBitrateKbps;
        session.lastChangeAt = Date.now();
        this.log.info(
          `[${this.opts.name}] Reconfiguring mosaic: ${n.width}x${n.height}@${n.fps} ${n.maxBitrateKbps}kbps`
        );
        const old = session.ffmpeg;
        session.ffmpeg = null;
        try {
          old?.kill("SIGKILL");
        } catch {
          /* gone */
        }
        this.spawnFfmpeg(request.sessionID, session);
        callback();
        break;
      }
      case this.hap.StreamRequestTypes.STOP:
        this.log.info(`[${this.opts.name}] client requested STOP`);
        this.stopStream(request.sessionID);
        callback();
        break;
    }
  }

  private startStream(
    request: StartStreamRequest,
    callback: StreamRequestCallback
  ): void {
    const info = this.pendingSessions.get(request.sessionID);
    if (!info) {
      callback(new Error("Session not found"));
      return;
    }
    if (!this.opts.provider.isReady()) {
      try {
        info.videoReturnSocket.close();
      } catch {
        /* already closed */
      }
      this.pendingSessions.delete(request.sessionID);
      callback(new Error("Video source not ready"));
      return;
    }

    const n = negotiate(request.video);
    const session: ActiveSession = {
      info,
      ffmpeg: null,
      timeout: null,
      videoPt: request.video.pt,
      mtu: request.video.mtu || 1316,
      fps: n.fps,
      width: n.width,
      height: n.height,
      maxBitrateKbps: n.maxBitrateKbps,
      lastChangeAt: Date.now(),
      respawns: 0,
    };

    this.log.info(
      `[${this.opts.name}] Starting mosaic: ${this.opts.memberIds.length} cameras, ` +
        `${session.width}x${session.height}@${session.fps} ${session.maxBitrateKbps}kbps, pt=${session.videoPt}`
    );

    const armIdleTimeout = () => {
      if (session.timeout) clearTimeout(session.timeout);
      const timeout = Math.max(30_000, request.video.rtcp_interval * 5 * 1000);
      session.timeout = setTimeout(() => {
        this.log.info(`[${this.opts.name}] Mosaic idle timeout. Stopping.`);
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
    this.spawnFfmpeg(request.sessionID, session, callback);
  }

  private spawnFfmpeg(
    sessionId: string,
    session: ActiveSession,
    startCallback?: StreamRequestCallback
  ): void {
    const args = buildMosaicArgs({
      sourceUrls: this.sourceUrls(),
      fps: session.fps,
      width: session.width,
      height: session.height,
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
    this.log.debug(`ffmpeg ${args.join(" ")}`);

    const ffmpeg = spawn(this.ffmpegPath, args);
    session.ffmpeg = ffmpeg;
    let started = false;

    setTimeout(() => {
      if (session.ffmpeg === ffmpeg) session.respawns = 0;
    }, RESPAWN_RESET_MS).unref();

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
      if (session.ffmpeg !== ffmpeg) return;
      if (code === 0 || code === null) return;
      if (this.stopped || !this.ongoingSessions.has(sessionId)) return;
      if (session.respawns >= RESPAWN_MAX) {
        this.log.warn(`[${this.opts.name}] mosaic ffmpeg kept dying (code=${code}), giving up`);
        this.controller.forceStopStreamingSession(sessionId);
        this.stopStream(sessionId);
        return;
      }
      session.respawns++;
      this.log.warn(
        `[${this.opts.name}] mosaic ffmpeg exited (code=${code}), ` +
          `respawn ${session.respawns}/${RESPAWN_MAX} in ${RESPAWN_DELAY_MS / 1000}s ` +
          `(a member camera may be offline)`
      );
      setTimeout(() => {
        if (!this.stopped && session.ffmpeg === ffmpeg && this.ongoingSessions.has(sessionId)) {
          this.spawnFfmpeg(sessionId, session);
        }
      }, RESPAWN_DELAY_MS).unref();
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
        /* already closed */
      }
      this.pendingSessions.delete(sessionId);
    }
    const session = this.ongoingSessions.get(sessionId);
    if (!session) return;
    this.ongoingSessions.delete(sessionId);
    if (session.timeout) clearTimeout(session.timeout);
    try {
      session.info.videoReturnSocket.close();
    } catch {
      /* already closed */
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
    for (const id of [...this.ongoingSessions.keys()]) {
      this.stopStream(id, true);
    }
    for (const [id, info] of this.pendingSessions) {
      try {
        info.videoReturnSocket.close();
      } catch {
        /* already closed */
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
