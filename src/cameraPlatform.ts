import {
  API,
  APIEvent,
  IndependentPlatformPlugin,
  Logging,
  PlatformConfig,
} from "homebridge";
import path from "path";
import { CameraAccessory, CameraConfig } from "./cameraAccessory";
import { PLUGIN_ID } from "./pkg";
import { Go2rtcManager } from "./streaming/go2rtcManager";
import {
  buildCaptureCommand,
  HtmlCameraConfig,
  HtmlRender,
  resolveX11grabFfmpeg,
} from "./streaming/htmlRender";
import { MosaicStreamingDelegate } from "./streaming/mosaicDelegate";
import { SnapshotService } from "./streaming/snapshotService";
import { SourceProvider } from "./streaming/sourceProvider";
import { TapoStreamingDelegate } from "./streaming/streamingDelegate";

export type MosaicConfig = {
  name: string;
  /** Camera names (as configured), in grid order. Omit for all cameras. */
  cameras?: string[];
};

export interface CameraPlatformConfig extends PlatformConfig {
  cameras?: CameraConfig[];
  htmlCameras?: HtmlCameraConfig[];
  mosaics?: MosaicConfig[];
  /** Explicit go2rtc binary path (overrides the downloaded one). */
  go2rtcPath?: string;
  /** surf binary path for HTML cameras (default /usr/bin/surf). */
  surfPath?: string;
  /** x11grab-capable ffmpeg for HTML capture (auto-detected if unset). */
  htmlFfmpegPath?: string;
}

type Shutdownable = { shutdown(): void };

export class CameraPlatform implements IndependentPlatformPlugin {
  public readonly kDefaultPullInterval = 60000;

  public readonly sourceProvider: SourceProvider;
  private readonly delegates: Shutdownable[] = [];
  private readonly htmlRenders: HtmlRender[] = [];
  private readonly cameraIds = new Set<string>();
  /** Ordered registry of streaming cameras: config name → relay id. */
  private readonly idByName = new Map<string, string>();
  private readonly order: string[] = []; // camera names, registration order

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
      this.htmlRenders.forEach((r) => r.stop());
      this.sourceProvider.stop();
    });

    void this.discoverDevices();
  }

  /** Stable unique slug for relay stream names. */
  public claimCameraId(name: string): string {
    const base =
      name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "cam";
    let id = base;
    let n = 2;
    while (this.cameraIds.has(id)) id = `${base}-${n++}`;
    this.cameraIds.add(id);
    return id;
  }

  /** Called by camera accessories once they've registered a relay source. */
  public registerStreamingCamera(name: string, id: string, delegate: Shutdownable): void {
    this.idByName.set(name, id);
    this.order.push(name);
    this.delegates.push(delegate);
  }

  private async discoverDevices(): Promise<void> {
    // Tapo cameras (register their RTSP tiers with the relay).
    await Promise.allSettled(
      (this.config.cameras ?? []).map((c) => this.setupTapoCamera(c))
    );

    // HTML cameras (start Xvfb+surf, register an exec capture source).
    for (const html of this.config.htmlCameras ?? []) {
      await this.setupHtmlCamera(html);
    }

    if (this.order.length === 0) return;

    try {
      await this.sourceProvider.start();
    } catch (err) {
      this.log.error(`Buffered video source failed to start: ${(err as Error).message}`);
      return;
    }

    this.setupMosaics();
  }

  private async setupTapoCamera(cameraConfig: CameraConfig, retry = false): Promise<void> {
    try {
      const cameraAccessory = new CameraAccessory(this, cameraConfig);
      await cameraAccessory.setup();
    } catch (err) {
      const m = err instanceof Error && err.message.match(/Try again in (\d+) seconds/);
      if (m && !retry) {
        const seconds = parseInt(m[1], 10);
        this.log.warn(`Camera "${cameraConfig.name}" suspended. Retrying in ${seconds}s...`);
        await new Promise((r) => setTimeout(r, seconds * 1000));
        return this.setupTapoCamera(cameraConfig, true);
      }
      this.log.error(`Error during setup of camera "${cameraConfig.name}"`, err);
    }
  }

  private async setupHtmlCamera(html: HtmlCameraConfig): Promise<void> {
    const ffmpeg = resolveX11grabFfmpeg(this.config.htmlFfmpegPath);
    if (!ffmpeg) {
      this.log.error(
        `HTML camera "${html.name}" skipped: no x11grab-capable ffmpeg found. ` +
          "Set htmlFfmpegPath, or install one (ffmpeg-for-homebridge lacks x11grab)."
      );
      return;
    }
    const surfPath = this.config.surfPath ?? "/usr/bin/surf";
    const render = new HtmlRender(this.log, html, surfPath);
    try {
      const display = await render.start();
      this.htmlRenders.push(render);
      const id = this.claimCameraId(html.name);
      this.sourceProvider.registerCamera({
        id,
        kind: "exec",
        command: buildCaptureCommand({
          ffmpeg,
          display,
          width: render.width,
          height: render.height,
          fps: render.fps,
        }),
      });

      // Standalone HomeKit camera, served from the relay like any camera.
      const accessory = new this.api.platformAccessory(
        html.name,
        this.api.hap.uuid.generate(`html:${html.name}`),
        this.api.hap.Categories.CAMERA
      );
      const tier = { width: render.width, height: render.height, approxBitrateKbps: 2048 };
      const delegate = new TapoStreamingDelegate(this.log, this.api.hap, {
        name: html.name,
        cameraId: id,
        provider: this.sourceProvider,
        snapshots: new SnapshotService(this.log, this.sourceProvider, id),
        disableAudio: true,
        mainTier: tier,
        subTier: tier,
      });
      accessory.configureController(delegate.controller);
      this.api.publishExternalAccessories(PLUGIN_ID, [accessory]);
      this.registerStreamingCamera(html.name, id, delegate);
      this.log.info(`HTML camera "${html.name}" ready`);
    } catch (err) {
      render.stop();
      this.log.error(`HTML camera "${html.name}" failed: ${(err as Error).message}`);
    }
  }

  private setupMosaics(): void {
    let mosaics = this.config.mosaics;
    if (!mosaics || mosaics.length === 0) {
      // Auto: one mosaic of all cameras — but only when there's more than one.
      if (this.order.length < 2) return;
      mosaics = [{ name: "Mosaic", cameras: [...this.order] }];
    }

    for (const mosaic of mosaics) {
      const names = mosaic.cameras && mosaic.cameras.length > 0 ? mosaic.cameras : this.order;
      const memberIds: string[] = [];
      for (const name of names) {
        const id = this.idByName.get(name);
        if (id) memberIds.push(id);
        else this.log.warn(`Mosaic "${mosaic.name}": unknown camera "${name}", skipping`);
      }
      if (memberIds.length < 2) {
        this.log.warn(`Mosaic "${mosaic.name}" needs at least 2 valid cameras, skipping`);
        continue;
      }

      const accessory = new this.api.platformAccessory(
        mosaic.name,
        this.api.hap.uuid.generate(`mosaic:${mosaic.name}`),
        this.api.hap.Categories.CAMERA
      );
      const delegate = new MosaicStreamingDelegate(this.log, this.api.hap, {
        name: mosaic.name,
        provider: this.sourceProvider,
        memberIds,
      });
      accessory.configureController(delegate.controller);
      this.api.publishExternalAccessories(PLUGIN_ID, [accessory]);
      this.delegates.push(delegate);
      this.log.info(`Mosaic "${mosaic.name}" ready (${memberIds.length} cameras)`);
    }
  }
}
