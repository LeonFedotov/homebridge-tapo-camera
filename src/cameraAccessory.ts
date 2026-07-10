import {
  API,
  Logging,
  PlatformAccessory,
  PlatformAccessoryEvent,
  Service,
} from "homebridge";
import { Status, TAPOCamera } from "./tapoCamera";
import { PLUGIN_ID } from "./pkg";
import { CameraPlatform } from "./cameraPlatform";
import { SnapshotService } from "./streaming/snapshotService";
import { TapoStreamingDelegate } from "./streaming/streamingDelegate";
import { DEFAULT_SUB_TIER } from "./streaming/tierPolicy";
import { TAPOBasicInfo } from "./types/tapo";

export type CameraConfig = {
  name: string;
  ipAddress: string;
  username: string;
  password: string;
  streamUser?: string;
  streamPassword?: string;

  pullInterval?: number;
  disableStreaming?: boolean;
  disableEyesToggleAccessory?: boolean;
  disableAlarmToggleAccessory?: boolean;
  disableNotificationsToggleAccessory?: boolean;
  disableMotionDetectionToggleAccessory?: boolean;
  disableLEDToggleAccessory?: boolean;
  enableFloodLightAccessory?: boolean;

  disableMotionSensorAccessory?: boolean;

  /** Disable one-way audio in streams. */
  disableAudio?: boolean;
  /** Pin sessions to a camera stream tier instead of automatic selection. */
  forceTier?: "auto" | "main" | "sub";
  /** Approximate bitrate of the camera's sub stream (kbps), used by the copy-vs-encode decision. */
  subBitrateKbps?: number;

  /** @deprecated ng selects tiers automatically; ignored. */
  lowQuality?: boolean;

  eyesToggleAccessoryName?: string;
  alarmToggleAccessoryName?: string;
  notificationsToggleAccessoryName?: string;
  motionDetectionToggleAccessoryName?: string;
  ledToggleAccessoryName?: string;
  floodLightAccessoryName?: string;
};

export class CameraAccessory {
  private readonly log: Logging;
  private readonly api: API;

  private readonly camera: TAPOCamera;

  private pullIntervalTick: NodeJS.Timeout | undefined;

  private readonly accessory: PlatformAccessory;

  private infoAccessory: Service | undefined;
  private toggleAccessories: Partial<Record<keyof Status, Service>> = {};
  private cachedStatus: Partial<Status> = {};
  private isOffline = false;

  private motionSensorService: Service | undefined;

  private readonly randomSeed = Math.random();

  constructor(
    private readonly platform: CameraPlatform,
    private readonly config: CameraConfig
  ) {
    // @ts-expect-error - private property
    this.log = {
      ...this.platform.log,
      prefix: this.platform.log.prefix + `/${this.config.name}`,
    };

    this.api = this.platform.api;
    this.accessory = new this.api.platformAccessory(
      this.config.name,
      this.api.hap.uuid.generate(this.config.name),
      this.api.hap.Categories.CAMERA
    );
    this.camera = new TAPOCamera(this.log, this.config);
  }

  private hasStreamCredentials() {
    return Boolean(this.config.streamUser && this.config.streamPassword);
  }

  private isMotionSensorEnabled() {
    return (
      !this.config.disableMotionSensorAccessory && this.hasStreamCredentials()
    );
  }

  private setupInfoAccessory(basicInfo: TAPOBasicInfo) {
    this.infoAccessory =
      this.accessory.getService(this.api.hap.Service.AccessoryInformation) ||
      this.accessory.addService(this.api.hap.Service.AccessoryInformation);
    this.infoAccessory
      .setCharacteristic(this.api.hap.Characteristic.Manufacturer, "TAPO")
      .setCharacteristic(
        this.api.hap.Characteristic.Model,
        basicInfo.device_info
      )
      .setCharacteristic(
        this.api.hap.Characteristic.SerialNumber,
        basicInfo.mac
      )
      .setCharacteristic(
        this.api.hap.Characteristic.FirmwareRevision,
        basicInfo.sw_version
      );
  }

  private setupToggleAccessory(
    name: string,
    tapoServiceStr: keyof Status,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    serviceType: any = this.api.hap.Service.Switch
  ) {
    try {
      const toggleService = this.accessory.addService(
        serviceType,
        name,
        tapoServiceStr
      );
      this.toggleAccessories[tapoServiceStr] = toggleService;

      toggleService.addOptionalCharacteristic(
        this.api.hap.Characteristic.ConfiguredName
      );
      toggleService.setCharacteristic(
        this.api.hap.Characteristic.ConfiguredName,
        name
      );

      toggleService
        .getCharacteristic(this.api.hap.Characteristic.On)
        .onGet(async () => {
          try {
            this.log.debug(`Getting "${tapoServiceStr}" status...`);

            const cachedValue = this.cachedStatus[tapoServiceStr];
            if (cachedValue !== undefined) {
              return cachedValue;
            }

            const currentValue = toggleService.getCharacteristic(
              this.api.hap.Characteristic.On
            ).value;

            void this.getStatusAndNotify();

            if (typeof currentValue === "boolean") {
              this.log.debug(
                `No cached status for "${tapoServiceStr}", returning Homebridge cached value`
              );
              return currentValue;
            }

            this.log.debug(
              `No cached status for "${tapoServiceStr}", returning fallback value`
            );
            return false;
          } catch (err) {
            this.log.error("Error getting status:", err);
            return false;
          }
        })
        .onSet(async (newValue) => {
          try {
            const value = Boolean(newValue);
            this.log.debug(
              `Setting "${tapoServiceStr}" to ${value ? "on" : "off"}...`
            );
            await this.camera.setStatus(tapoServiceStr, value);
            this.cachedStatus[tapoServiceStr] = value;
            toggleService
              .getCharacteristic(this.api.hap.Characteristic.On)
              .updateValue(value);
          } catch (err) {
            this.log.error("Error setting status:", err);
            throw new this.api.hap.HapStatusError(
              this.api.hap.HAPStatus.RESOURCE_DOES_NOT_EXIST
            );
          }
        });
    } catch (err) {
      this.log.error(
        "Error setting up toggle accessory",
        name,
        tapoServiceStr,
        err
      );
    }
  }

  private async setupCameraStreaming(basicInfo: TAPOBasicInfo) {
    try {
      if (!this.hasStreamCredentials()) {
        this.log.error(
          "Camera streaming requires streamUser and streamPassword. Set disableStreaming to true for controls-only setups."
        );
        return;
      }

      if (this.config.lowQuality !== undefined) {
        this.log.warn(
          "lowQuality is deprecated and ignored: ng selects the stream tier per session automatically."
        );
      }

      const cameraId = this.platform.claimCameraId(this.config.name);
      this.platform.sourceProvider.registerCamera({
        id: cameraId,
        kind: "rtsp",
        mainUrl: this.camera.getAuthenticatedStreamUrl(false),
        subUrl: this.camera.getAuthenticatedStreamUrl(true),
      });

      const snapshots = new SnapshotService(
        this.log,
        this.platform.sourceProvider,
        cameraId,
        this.platform.snapshotStore
      );

      const delegate = new TapoStreamingDelegate(this.log, this.api.hap, {
        name: this.config.name,
        cameraId,
        provider: this.platform.sourceProvider,
        snapshots,
        disableAudio: this.config.disableAudio,
        forceTier: this.config.forceTier,
        subTier: this.config.subBitrateKbps
          ? { ...DEFAULT_SUB_TIER, approxBitrateKbps: this.config.subBitrateKbps }
          : undefined,
      });
      this.accessory.configureController(delegate.controller);
      this.platform.registerStreamingCamera(this.config.name, cameraId, delegate);

      this.log.debug(
        "Camera streaming setup done (buffered source, model:",
        basicInfo.device_info,
        ")"
      );
    } catch (err) {
      this.log.error("Error setting up camera streaming:", err);
    }
  }

  private async setupMotionSensorAccessory() {
    try {
      if (!this.hasStreamCredentials()) {
        this.log.warn(
          "Motion sensor requires streamUser and streamPassword. Skipping motion sensor setup."
        );
        return;
      }

      this.motionSensorService = this.accessory.addService(
        this.platform.api.hap.Service.MotionSensor,
        "Motion Sensor",
        "motion"
      );

      this.motionSensorService.addOptionalCharacteristic(
        this.api.hap.Characteristic.ConfiguredName
      );
      this.motionSensorService.setCharacteristic(
        this.api.hap.Characteristic.ConfiguredName,
        "Motion Sensor"
      );

      const eventEmitter = await this.camera.getEventEmitter();
      eventEmitter.addListener("motion", (motionDetected) => {
        this.log.debug("Motion detected", motionDetected);

        this.motionSensorService?.updateCharacteristic(
          this.api.hap.Characteristic.MotionDetected,
          motionDetected
        );
      });
    } catch (err) {
      this.log.error("Error setting up motion sensor accessory:", err);
    }
  }

  private setupPolling() {
    if (this.pullIntervalTick) {
      clearInterval(this.pullIntervalTick);
    }

    this.pullIntervalTick = setInterval(() => {
      this.log.debug("Polling status...");
      this.getStatusAndNotify();
    }, this.config.pullInterval || this.platform.kDefaultPullInterval);
  }

  private async getStatusAndNotify() {
    try {
      const cameraStatus = await this.camera.getStatus();
      
      if (
        this.isOffline ||
        (this.isMotionSensorEnabled() && !this.camera.onvifConnected)
      ) {
        let onvifSuccess = true;
        if (this.isMotionSensorEnabled()) {
          this.log.info(
            "Camera is back online, restarting ONVIF connection..."
          );
          onvifSuccess = await this.camera.restartOnvifConnection();
        }

        if (onvifSuccess) {
          this.isOffline = false;
        } else {
          this.isOffline = true;
          this.log.error(
            "Failed to restart ONVIF connection, will retry next poll."
          );
        }
      }

      this.cachedStatus = {
        ...this.cachedStatus,
        ...cameraStatus,
      };
      this.log.debug("Notifying new values...", cameraStatus);

      for (const [key, value] of Object.entries(cameraStatus)) {
        const toggleService = this.toggleAccessories[key as keyof Status];
        if (toggleService && value !== undefined) {
          toggleService
            .getCharacteristic(this.api.hap.Characteristic.On)
            .updateValue(value);
        }
      }
    } catch (err) {
      this.log.error("Error getting status:", err);
      this.isOffline = true;
    }
  }

  async setup() {
    // The camera's HTTPS control API is flaky at boot (TLS resets). Streaming
    // needs only the RTSP URLs (built from config), so a control-API failure
    // must NOT block registering the camera with the relay / mosaics — degrade
    // the info service and recover it on the next status poll instead.
    let basicInfo: TAPOBasicInfo;
    try {
      basicInfo = await this.camera.getBasicInfo();
      this.log.debug("Basic info", basicInfo);
    } catch (err) {
      // A rate-limit suspension is handled by the platform's retry logic.
      if (err instanceof Error && /Try again in (\d+) seconds/.test(err.message)) {
        throw err;
      }
      this.log.warn(
        `Control API unavailable at startup (${(err as Error).message}). ` +
          "Proceeding with streaming; camera info/toggles recover on the next poll."
      );
      basicInfo = {
        device_info: "TAPO Camera",
        mac: this.config.name,
        sw_version: "unknown",
      } as TAPOBasicInfo;
    }

    this.accessory.on(PlatformAccessoryEvent.IDENTIFY, () => {
      this.log.info("Identify requested", basicInfo);
    });

    this.setupInfoAccessory(basicInfo);

    if (!this.config.disableStreaming) {
      this.setupCameraStreaming(basicInfo);
    }

    if (!this.config.disableEyesToggleAccessory) {
      this.setupToggleAccessory(
        this.config.eyesToggleAccessoryName || "Eyes",
        "eyes"
      );
    }

    if (!this.config.disableAlarmToggleAccessory) {
      this.setupToggleAccessory(
        this.config.alarmToggleAccessoryName || "Alarm",
        "alarm"
      );
    }

    if (!this.config.disableNotificationsToggleAccessory) {
      this.setupToggleAccessory(
        this.config.notificationsToggleAccessoryName || "Notifications",
        "notifications"
      );
    }

    if (!this.config.disableMotionDetectionToggleAccessory) {
      this.setupToggleAccessory(
        this.config.motionDetectionToggleAccessoryName || "Motion Detection",
        "motionDetection"
      );
    }

    if (!this.config.disableLEDToggleAccessory) {
      this.setupToggleAccessory(
        this.config.ledToggleAccessoryName || "LED",
        "led"
      );
    }

    if (this.config.enableFloodLightAccessory) {
      this.setupToggleAccessory(
        this.config.floodLightAccessoryName || "Floodlight",
        "floodLight",
        this.api.hap.Service.Lightbulb
      );
    }

    if (!this.config.disableMotionSensorAccessory) {
      this.setupMotionSensorAccessory();
    }

    // // Publish as external accessory
    this.log.debug("Publishing accessory...");
    this.api.publishExternalAccessories(PLUGIN_ID, [this.accessory]);

    // Setup the polling by giving a random delay
    // to avoid all the cameras starting at the same time
    this.log.debug("Setting up polling...");
    setTimeout(() => {
      this.setupPolling();
    }, this.randomSeed * 3_000);

    this.log.debug("Notifying initial values...");
    await this.getStatusAndNotify();
  }
}
