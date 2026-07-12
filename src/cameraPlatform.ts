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
import { CompositeStreamingDelegate } from "./streaming/compositeDelegate";
import { Go2rtcManager } from "./streaming/go2rtcManager";
import {
  buildCaptureCommand,
  HtmlCameraConfig,
  HtmlRender,
  resolveX11grabFfmpeg,
} from "./streaming/htmlRender";
import { HtmlRenderManager } from "./streaming/htmlRenderManager";
import { MIN_REFRESH_SECONDS, PreviewRefresher } from "./streaming/previewRefresher";
import { SnapshotStore } from "./streaming/snapshotStore";
import { SourceProvider } from "./streaming/sourceProvider";

export type MosaicConfig = {
  name: string;
  cameras?: string[]; // member camera names, in grid order; omit for all
};

export interface CameraPlatformConfig extends PlatformConfig {
  cameras?: CameraConfig[];
  htmlCameras?: HtmlCameraConfig[];
  mosaics?: MosaicConfig[];
  /** When true, never create any mosaic — not even the automatic one for 2+ cameras. */
  disableMosaics?: boolean;
  go2rtcPath?: string;
  surfPath?: string;
  htmlFfmpegPath?: string;
  /** Default idle-preview refresh for HTML cameras, seconds (min 10; 0 = off). */
  previewRefreshSeconds?: number;
}

type Shutdownable = { shutdown(): void };

export class CameraPlatform implements IndependentPlatformPlugin {
  public readonly kDefaultPullInterval = 60000;

  public readonly sourceProvider: SourceProvider;
  public readonly snapshotStore: SnapshotStore;
  public readonly renderManager = new HtmlRenderManager();

  private readonly delegates: Shutdownable[] = [];
  private readonly refreshers: PreviewRefresher[] = [];
  private readonly cameraIds = new Set<string>();
  private readonly idByName = new Map<string, string>();
  private readonly order: string[] = [];

  constructor(
    public readonly log: Logging,
    public readonly config: CameraPlatformConfig,
    public readonly api: API
  ) {
    const workDir = path.join(api.user.storagePath(), "tapo-camera-ng");
    this.sourceProvider = new Go2rtcManager(log, { workDir, binaryPath: this.config.go2rtcPath });
    this.snapshotStore = new SnapshotStore(log, workDir);

    api.on(APIEvent.SHUTDOWN, () => {
      this.refreshers.forEach((r) => r.stop());
      this.delegates.forEach((d) => d.shutdown());
      this.renderManager.stopAll();
      this.sourceProvider.stop();
    });

    void this.discoverDevices();
  }

  public claimCameraId(name: string): string {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "cam";
    let id = base;
    let n = 2;
    while (this.cameraIds.has(id)) id = `${base}-${n++}`;
    this.cameraIds.add(id);
    return id;
  }

  public registerStreamingCamera(name: string, id: string, delegate: Shutdownable): void {
    this.idByName.set(name, id);
    this.order.push(name);
    this.delegates.push(delegate);
  }

  private async discoverDevices(): Promise<void> {
    await Promise.allSettled((this.config.cameras ?? []).map((c) => this.setupTapoCamera(c)));
    for (const html of this.config.htmlCameras ?? []) await this.setupHtmlCamera(html);

    if (this.order.length === 0) return;
    try {
      await this.sourceProvider.start();
    } catch (err) {
      this.log.error(`Buffered video source failed to start: ${(err as Error).message}`);
      return;
    }
    this.setupMosaics();
    this.refreshers.forEach((r) => r.start()); // provider is up now
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
        `HTML camera "${html.name}" skipped: no x11grab-capable ffmpeg found. Set htmlFfmpegPath.`
      );
      return;
    }
    const surfPath = this.config.surfPath ?? "/usr/bin/surf";
    const render = new HtmlRender(this.log, html, surfPath);
    try {
      const display = await render.start(); // Xvfb only; surf is lazy
      const id = this.claimCameraId(html.name);
      this.renderManager.register(id, render);
      this.sourceProvider.registerCamera({
        id,
        kind: "exec",
        command: buildCaptureCommand({ ffmpeg, display, width: render.width, height: render.height, fps: render.fps }),
      });

      const accessory = new this.api.platformAccessory(
        html.name,
        this.api.hap.uuid.generate(`html:${html.name}`),
        this.api.hap.Categories.CAMERA
      );
      const delegate = new CompositeStreamingDelegate(this.log, this.api.hap, {
        name: html.name,
        provider: this.sourceProvider,
        memberIds: [id],
        renderManager: this.renderManager,
        snapshotStore: this.snapshotStore,
      });
      accessory.configureController(delegate.controller);
      this.api.publishExternalAccessories(PLUGIN_ID, [accessory]);
      this.registerStreamingCamera(html.name, id, delegate);

      const refreshSec = html.previewRefreshSeconds ?? this.config.previewRefreshSeconds ?? 0;
      if (refreshSec > 0) {
        const sec = Math.max(MIN_REFRESH_SECONDS, refreshSec);
        this.refreshers.push(
          new PreviewRefresher(this.log, id, sec * 1000, this.renderManager, this.sourceProvider, this.snapshotStore)
        );
        this.log.info(`HTML camera "${html.name}" ready (lazy render, preview refresh ${sec}s)`);
      } else {
        this.log.info(`HTML camera "${html.name}" ready (lazy render)`);
      }
    } catch (err) {
      render.stop();
      this.log.error(`HTML camera "${html.name}" failed: ${(err as Error).message}`);
    }
  }

  private setupMosaics(): void {
    if (this.config.disableMosaics) {
      this.log.info("Mosaics disabled (disableMosaics) — skipping mosaic setup");
      return;
    }
    let mosaics = this.config.mosaics;
    if (!mosaics || mosaics.length === 0) {
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
      const delegate = new CompositeStreamingDelegate(this.log, this.api.hap, {
        name: mosaic.name,
        provider: this.sourceProvider,
        memberIds,
        renderManager: this.renderManager,
        snapshotStore: this.snapshotStore,
      });
      accessory.configureController(delegate.controller);
      this.api.publishExternalAccessories(PLUGIN_ID, [accessory]);
      this.delegates.push(delegate);
      this.log.info(`Mosaic "${mosaic.name}" ready (${memberIds.length} cameras)`);
    }
  }
}
