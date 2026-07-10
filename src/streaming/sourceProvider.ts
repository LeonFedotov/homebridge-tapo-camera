export type StreamTier = "main" | "sub";

export type CameraSourceConfig = {
  /** Stable slug used to name relay streams (alphanumeric + dashes). */
  id: string;
  /** rtsp:// URL (with credentials) of the camera's high-quality stream. */
  mainUrl: string;
  /** rtsp:// URL (with credentials) of the camera's low-quality stream. */
  subUrl: string;
};

/**
 * A buffered source of camera video: holds persistent connections to the
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

  /** Local relay URL for a camera tier. Throws if not started. */
  getSourceUrl(cameraId: string, tier: StreamTier): string;

  /** Latest JPEG frame for a camera (decoded from the sub tier). */
  getFrame(cameraId: string): Promise<Buffer>;

  stop(): void;
}
