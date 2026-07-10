import {
  API,
  APIEvent,
  IndependentPlatformPlugin,
  Logging,
  PlatformConfig,
} from "homebridge";
import path from "path";
import { CameraAccessory, CameraConfig } from "./cameraAccessory";
import { Go2rtcManager } from "./streaming/go2rtcManager";
import { SourceProvider } from "./streaming/sourceProvider";
import { TapoStreamingDelegate } from "./streaming/streamingDelegate";

export interface CameraPlatformConfig extends PlatformConfig {
  cameras?: CameraConfig[];
  /** Explicit go2rtc binary path (overrides the downloaded one). */
  go2rtcPath?: string;
}

export class CameraPlatform implements IndependentPlatformPlugin {
  public readonly kDefaultPullInterval = 60000;

  public readonly sourceProvider: SourceProvider;
  private readonly delegates: TapoStreamingDelegate[] = [];
  private readonly cameraIds = new Set<string>();
  private streamingCameras = 0;

  constructor(
    public readonly log: Logging,
    public readonly config: CameraPlatformConfig,
    public readonly api: API
  ) {
    this.sourceProvider = new Go2rtcManager(log, {
      workDir: path.join(api.user.storagePath(), "tapo-camera-ng"),
      binaryPath: this.config.go2rtcPath,
    });

    api.on(APIEvent.SHUTDOWN, () => {
      this.delegates.forEach((d) => d.shutdown());
      this.sourceProvider.stop();
    });

    void this.discoverDevices();
  }

  /** Stable unique slug for relay stream names. */
  public claimCameraId(name: string): string {
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "cam";
    let id = base;
    let n = 2;
    while (this.cameraIds.has(id)) id = `${base}-${n++}`;
    this.cameraIds.add(id);
    return id;
  }

  public registerDelegate(delegate: TapoStreamingDelegate): void {
    this.delegates.push(delegate);
    this.streamingCameras++;
  }

  private async discoverDevices(): Promise<void> {
    const cameras = this.config.cameras ?? [];
    await Promise.allSettled(
      cameras.map((cameraConfig) => this.setupCamera(cameraConfig))
    );

    // Start the buffered source once every camera has had the chance to
    // register its streams. Sessions requested before this completes get a
    // clean "source not ready" error and the Home app retries.
    if (this.streamingCameras > 0) {
      try {
        await this.sourceProvider.start();
      } catch (err) {
        this.log.error(
          `Buffered video source failed to start: ${(err as Error).message}`
        );
      }
    }
  }

  private async setupCamera(
    cameraConfig: CameraConfig,
    retryAfterSuspension = false
  ): Promise<void> {
    try {
      const cameraAccessory = new CameraAccessory(this, cameraConfig);
      await cameraAccessory.setup();
    } catch (err) {
      const suspensionMatch =
        err instanceof Error &&
        err.message.match(/Try again in (\d+) seconds/);

      if (suspensionMatch && !retryAfterSuspension) {
        const seconds = parseInt(suspensionMatch[1], 10);
        this.log.warn(
          `Camera "${cameraConfig.name}" is temporarily suspended. Retrying in ${seconds} seconds...`
        );
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
        return this.setupCamera(cameraConfig, true);
      }

      this.log.error(
        `Error during setup of camera "${cameraConfig.name}"`,
        err,
        err instanceof Error ? err.stack : []
      );
    }
  }
}
