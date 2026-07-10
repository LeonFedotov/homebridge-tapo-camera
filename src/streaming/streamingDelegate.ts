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
import { buildSessionArgs } from "./ffmpegArgs";
import { SnapshotService } from "./snapshotService";
import { SourceProvider, StreamTier } from "./sourceProvider";
import {
  decideTier,
  DEFAULT_MAIN_TIER,
  DEFAULT_SUB_TIER,
  shouldApplyReconfigure,
  TierDecision,
  TierMeta,
} from "./tierPolicy";

const SESSION_RESPAWN_MAX = 5;
const SESSION_RESPAWN_DELAY_MS = 2_000;
const SESSION_STABLE_RESET_MS = 60_000;

type SessionInfo = {
  address: string;
  videoPort: number;
  videoReturnSocket: Socket; // bound at prepare, held so the port can't be stolen
  videoSRTP: Buffer;
  videoSSRC: number;
  audioPort: number;
  audioSRTP: Buffer;
  audioSSRC: number;
};

type ActiveSession = {
  info: SessionInfo;
  ffmpeg: ChildProcess | null;
  timeout: NodeJS.Timeout | null;
  decision: TierDecision;
  videoPt: number;
  audioPt: number;
  mtu: number;
  respawns: number;
  lastChangeAt: number;
};

export type TapoStreamingDelegateOptions = {
  name: string;
  cameraId: string;
  provider: SourceProvider;
  snapshots: SnapshotService;
  disableAudio?: boolean;
  forceTier?: "auto" | StreamTier;
  mainTier?: TierMeta;
  subTier?: TierMeta;
};

export class TapoStreamingDelegate implements CameraStreamingDelegate {
  public readonly controller: CameraController;
  private readonly ffmpegPath: string;
  private readonly pendingSessions = new Map<string, SessionInfo>();
  private readonly ongoingSessions = new Map<string, ActiveSession>();
  private stopped = false;

  constructor(
    private readonly log: Logging,
    private readonly hap: HAP,
    private readonly opts: TapoStreamingDelegateOptions
  ) {
    this.ffmpegPath = ffmpegForHomebridge || "ffmpeg";

    const main = opts.mainTier ?? DEFAULT_MAIN_TIER;
    const options: CameraControllerOptions = {
      cameraStreamCount: 4,
      delegate: this,
      streamingOptions: {
        supportedCryptoSuites: [hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: {
          // 16:9 only (the camera is 16:9) and never above the main tier.
          resolutions: (
            [
              [320, 180, 30],
              [480, 270, 30],
              [640, 360, 30],
              [1280, 720, 30],
              [1920, 1080, 30],
            ] as [number, number, number][]
          ).filter(([w, h]) => w <= main.width && h <= main.height),
          codec: {
            profiles: [
              hap.H264Profile.BASELINE,
              hap.H264Profile.MAIN,
              hap.H264Profile.HIGH,
            ],
            levels: [
              hap.H264Level.LEVEL3_1,
              hap.H264Level.LEVEL3_2,
              hap.H264Level.LEVEL4_0,
            ],
          },
        },
        audio: {
          twoWayAudio: false,
          codecs: opts.disableAudio
            ? []
            : [
                {
                  type: hap.AudioStreamingCodecType.AAC_ELD,
                  samplerate: hap.AudioStreamingSamplerate.KHZ_16,
                },
              ],
        },
      },
    };
    this.controller = new hap.CameraController(options);
  }

  handleSnapshotRequest(
    _request: SnapshotRequest,
    callback: SnapshotRequestCallback
  ): void {
    this.opts.snapshots
      .get()
      .then((data) => callback(undefined, data))
      .catch((err: Error) => {
        this.log.warn(`[${this.opts.name}] Snapshot failed: ${err.message}`);
        callback(err);
      });
  }

  async prepareStream(
    request: PrepareStreamRequest,
    callback: PrepareStreamCallback
  ): Promise<void> {
    this.log.debug(
      `[${this.opts.name}] prepareStream: ${request.targetAddress}`
    );
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
        videoSRTP: Buffer.concat([
          request.video.srtp_key,
          request.video.srtp_salt,
        ]),
        videoSSRC,
        audioPort: request.audio.port,
        audioSRTP: Buffer.concat([
          request.audio.srtp_key,
          request.audio.srtp_salt,
        ]),
        audioSSRC,
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
      this.log.error(
        `[${this.opts.name}] prepareStream failed: ${(err as Error).message}`
      );
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
        const video = request.video;
        const next = decideTier(
          {
            width: video.width || session.decision.width,
            height: video.height || session.decision.height,
            fps: video.fps || session.decision.fps,
            maxBitrateKbps:
              video.max_bit_rate || session.decision.bitrateKbps,
          },
          this.opts.mainTier ?? DEFAULT_MAIN_TIER,
          this.opts.subTier ?? DEFAULT_SUB_TIER,
          this.opts.forceTier ?? "auto"
        );
        if (
          !shouldApplyReconfigure(
            session.decision,
            next,
            Date.now() - session.lastChangeAt
          )
        ) {
          this.log.debug(
            `[${this.opts.name}] Reconfigure damped: ${next.source}/${next.mode} ` +
              `${next.width}x${next.height} ${next.bitrateKbps}kbps`
          );
          callback();
          break;
        }
        session.decision = next;
        session.lastChangeAt = Date.now();
        this.log.info(
          `[${this.opts.name}] Reconfiguring: ${next.source}/${next.mode} ` +
            `${next.width}x${next.height}@${next.fps} ${next.bitrateKbps}kbps`
        );
        const old = session.ffmpeg;
        session.ffmpeg = null;
        try {
          old?.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        this.spawnSessionFfmpeg(request.sessionID, session);
        callback();
        break;
      }
      case this.hap.StreamRequestTypes.STOP:
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

    const decision = decideTier(
      {
        width: request.video.width,
        height: request.video.height,
        fps: request.video.fps,
        maxBitrateKbps: request.video.max_bit_rate,
      },
      this.opts.mainTier ?? DEFAULT_MAIN_TIER,
      this.opts.subTier ?? DEFAULT_SUB_TIER,
      this.opts.forceTier ?? "auto"
    );

    this.log.info(
      `[${this.opts.name}] Starting stream: ${decision.source}/${decision.mode} ` +
        `${decision.width}x${decision.height}@${decision.fps} ${decision.bitrateKbps}kbps, ` +
        `pt=${request.video.pt}, mtu=${request.video.mtu || 1316}`
    );

    const session: ActiveSession = {
      info,
      ffmpeg: null,
      timeout: null,
      decision,
      videoPt: request.video.pt,
      audioPt: request.audio.pt,
      mtu: request.video.mtu || 1316,
      respawns: 0,
      lastChangeAt: Date.now(),
    };

    const armIdleTimeout = () => {
      if (session.timeout) clearTimeout(session.timeout);
      const timeout = Math.max(30_000, request.video.rtcp_interval * 5 * 1000);
      session.timeout = setTimeout(() => {
        this.log.info(`[${this.opts.name}] Stream idle timeout. Stopping.`);
        this.controller.forceStopStreamingSession(request.sessionID);
        this.stopStream(request.sessionID);
      }, timeout);
    };
    info.videoReturnSocket.on("error", (err) => {
      this.log.error(`[${this.opts.name}] Socket error: ${err.message}`);
      this.stopStream(request.sessionID);
    });
    info.videoReturnSocket.on("message", armIdleTimeout);
    armIdleTimeout();

    this.ongoingSessions.set(request.sessionID, session);
    this.pendingSessions.delete(request.sessionID);
    this.spawnSessionFfmpeg(request.sessionID, session, callback);
  }

  // Spawns (or respawns) the per-session encoder against the local relay.
  // Identity guards make a replaced process's events inert; unexpected death
  // (e.g. relay restarting after a camera drop) respawns with backoff so the
  // viewer's session survives WiFi blips without user action.
  private spawnSessionFfmpeg(
    sessionId: string,
    session: ActiveSession,
    startCallback?: StreamRequestCallback
  ): void {
    const args = buildSessionArgs({
      sourceUrl: this.opts.provider.getSourceUrl(
        this.opts.cameraId,
        session.decision.source
      ),
      decision: session.decision,
      video: {
        address: session.info.address,
        port: session.info.videoPort,
        payloadType: session.videoPt,
        ssrc: session.info.videoSSRC,
        srtpParams: session.info.videoSRTP.toString("base64"),
        mtu: session.mtu,
      },
      audio: this.opts.disableAudio
        ? null
        : {
            address: session.info.address,
            port: session.info.audioPort,
            payloadType: session.audioPt,
            ssrc: session.info.audioSSRC,
            srtpParams: session.info.audioSRTP.toString("base64"),
          },
    });
    this.log.debug(`ffmpeg ${args.join(" ")}`);

    const ffmpeg = spawn(this.ffmpegPath, args);
    session.ffmpeg = ffmpeg;
    let started = false;

    setTimeout(() => {
      if (session.ffmpeg === ffmpeg) session.respawns = 0;
    }, SESSION_STABLE_RESET_MS).unref();

    ffmpeg.stderr?.on("data", (d: Buffer) =>
      this.log.debug(d.toString().trim())
    );
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
      if (session.ffmpeg !== ffmpeg) return;
      if (code === 0 || code === null) {
        this.log.debug(`[${this.opts.name}] session ffmpeg exited cleanly`);
        return;
      }
      if (this.stopped || !this.ongoingSessions.has(sessionId)) return;
      if (session.respawns >= SESSION_RESPAWN_MAX) {
        this.log.warn(
          `[${this.opts.name}] session ffmpeg kept dying (code=${code}), giving up`
        );
        this.controller.forceStopStreamingSession(sessionId);
        this.stopStream(sessionId);
        return;
      }
      session.respawns++;
      this.log.warn(
        `[${this.opts.name}] session ffmpeg exited (code=${code}), ` +
          `respawn ${session.respawns}/${SESSION_RESPAWN_MAX} in ${SESSION_RESPAWN_DELAY_MS / 1000}s`
      );
      setTimeout(() => {
        if (
          !this.stopped &&
          session.ffmpeg === ffmpeg &&
          this.ongoingSessions.has(sessionId)
        ) {
          this.spawnSessionFfmpeg(sessionId, session);
        }
      }, SESSION_RESPAWN_DELAY_MS).unref();
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
          /* already gone */
        }
      } else {
        try {
          ffmpeg.stdin?.write("q\n");
        } catch {
          /* already gone */
        }
        setTimeout(() => {
          try {
            ffmpeg.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }, 2000).unref();
      }
    }
    this.log.info(`[${this.opts.name}] Stream stopped`);
  }

  shutdown(): void {
    this.stopped = true;
    for (const sessionId of [...this.ongoingSessions.keys()]) {
      this.stopStream(sessionId, true);
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
