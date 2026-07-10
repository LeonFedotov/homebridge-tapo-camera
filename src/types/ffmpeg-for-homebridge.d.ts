declare module "ffmpeg-for-homebridge" {
  /** Absolute path to the bundled ffmpeg, or undefined if unavailable. */
  const ffmpegPath: string | undefined;
  export default ffmpegPath;
}
