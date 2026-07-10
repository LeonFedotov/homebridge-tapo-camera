export type StreamTier = "main" | "sub";

/** A camera with two RTSP tiers (Tapo, Xiaomi, any ONVIF/RTSP camera). */
export type RtspCameraSource = {
  id: string;
  kind: "rtsp";
  mainUrl: string;
  subUrl: string;
};

/**
 * A single-stream source produced by a command go2rtc runs (an `exec:` source).
 * Used for HTML cameras: the plugin keeps Xvfb+surf rendering the page, and
 * this command captures that X display into H.264 for go2rtc.
 */
export type ExecCameraSource = {
  id: string;
  kind: "exec";
  command: string;
};

export type CameraSourceConfig = RtspCameraSource | ExecCameraSource;

/**
 * A buffered source of camera video: holds persistent connections to each
 * camera, absorbs reconnects, and fans out to any number of local consumers.
 * go2rtc implements this today; a pure-TS buffer could replace it behind the
 * same interface.
 */
export interface SourceProvider {
  /** Must be called for every camera before start(). */
  registerCamera(config: CameraSourceConfig): void;

  /** Resolve the binary, write config, spawn and wait until healthy. */
  start(): Promise<void>;

  isReady(): boolean;

  /**
   * Local relay URL for a camera. rtsp cameras honor the tier; exec cameras
   * have a single stream and ignore it.
   */
  getSourceUrl(cameraId: string, tier: StreamTier): string;

  /** Latest JPEG frame for a camera. */
  getFrame(cameraId: string): Promise<Buffer>;

  stop(): void;
}
