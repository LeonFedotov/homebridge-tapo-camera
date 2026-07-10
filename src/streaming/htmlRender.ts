import { ChildProcess, execFileSync, spawn } from "child_process";
import { existsSync } from "fs";
import type { Readable } from "stream";
import { Logging } from "homebridge";

const RESTART_BACKOFF_MAX_MS = 30_000;
const RESTART_BACKOFF_RESET_MS = 60_000;

export type HtmlCameraConfig = {
  name: string;
  url: string;
  width?: number;
  height?: number;
  fps?: number;
};

/**
 * Locate an ffmpeg that supports x11grab. ffmpeg-for-homebridge (used for the
 * Tapo audio path) does NOT, so HTML capture needs a separate binary. Checks
 * an explicit path, then common system locations.
 */
export function resolveX11grabFfmpeg(explicit?: string): string | null {
  const candidates = [
    explicit,
    process.env.HTML_FFMPEG_PATH,
    "/usr/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/opt/homebrew/bin/ffmpeg",
  ].filter((p): p is string => Boolean(p));
  for (const candidate of candidates) {
    if (candidate !== "/usr/bin/ffmpeg" &&
        candidate !== "/usr/local/bin/ffmpeg" &&
        candidate !== "/opt/homebrew/bin/ffmpeg" &&
        !existsSync(candidate)) {
      continue;
    }
    try {
      const out = execFileSync(candidate, ["-hide_banner", "-devices"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (/x11grab/.test(out)) return candidate;
    } catch {
      /* not runnable / no such binary */
    }
  }
  return null;
}

/** go2rtc exec source command that captures the X display as H.264 RTSP. */
export function buildCaptureCommand(opts: {
  ffmpeg: string;
  display: string;
  width: number;
  height: number;
  fps: number;
}): string {
  return [
    opts.ffmpeg,
    "-hide_banner", "-loglevel", "error",
    "-f", "x11grab",
    "-video_size", `${opts.width}x${opts.height}`,
    "-framerate", String(opts.fps),
    "-i", `${opts.display}.0`,
    "-an",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-tune", "zerolatency",
    "-pix_fmt", "yuv420p",
    "-g", String(opts.fps * 2),
    "-rtsp_transport", "tcp",
    "-f", "rtsp", "{output}",
  ].join(" ");
}

/**
 * Renders one HTML page on a private X display: Xvfb picks a free display via
 * -displayfd, surf renders the URL, both supervised with backoff. The rendered
 * display is captured by a go2rtc exec source (see buildCaptureCommand), so
 * from go2rtc's perspective an HTML camera is just another stream.
 */
export class HtmlRender {
  readonly width: number;
  readonly height: number;
  readonly fps: number;

  private display: string | null = null;
  private xvfb: ChildProcess | null = null;
  private surf: ChildProcess | null = null;
  private unclutter: ChildProcess | null = null;
  private stopped = false;
  private xvfbRestarts = 0;
  private surfRestarts = 0;

  constructor(
    private readonly log: Logging,
    private readonly config: HtmlCameraConfig,
    private readonly surfPath: string
  ) {
    this.width = config.width ?? 1280;
    this.height = config.height ?? 720;
    this.fps = config.fps ?? 15;
  }

  /** Start Xvfb + surf; resolves with the display number once rendering. */
  start(): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Xvfb for "${this.config.name}" did not start in time`)),
        15_000
      );
      this.startXvfb((display) => {
        clearTimeout(timer);
        resolve(display);
      });
    });
  }

  get displayNumber(): string | null {
    return this.display;
  }

  private startXvfb(onReady: (display: string) => void): void {
    if (this.stopped) return;
    const xvfb = spawn(
      "Xvfb",
      ["-displayfd", "3", "-screen", "0", `${this.width}x${this.height}x24`, "-nocursor"],
      { stdio: ["ignore", "ignore", "pipe", "pipe"] }
    );
    this.xvfb = xvfb;
    this.display = null;

    let announced = false;
    let buf = "";
    const fd = xvfb.stdio[3] as Readable | null | undefined;
    fd?.on("data", (chunk: Buffer) => {
      if (announced) return;
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      announced = true;
      const n = Number.parseInt(buf.slice(0, nl).trim(), 10);
      if (Number.isNaN(n)) {
        this.log.error(`[${this.config.name}] Xvfb reported unparseable display "${buf.trim()}"`);
        return;
      }
      this.display = `:${n}`;
      this.log.info(`[${this.config.name}] Xvfb ready on ${this.display}`);
      setTimeout(() => {
        if (this.xvfb === xvfb) this.xvfbRestarts = 0;
      }, RESTART_BACKOFF_RESET_MS).unref();
      this.launchSurf();
      onReady(this.display);
    });

    xvfb.stderr?.on("data", (d: Buffer) => this.log.debug(`[${this.config.name}] Xvfb: ${d.toString().trim()}`));
    xvfb.on("error", (err) =>
      this.log.error(`[${this.config.name}] Failed to start Xvfb (${err.message}). Is xvfb installed?`)
    );
    xvfb.on("exit", (code, signal) => {
      if (this.stopped || this.xvfb !== xvfb) return;
      this.log.warn(`[${this.config.name}] Xvfb exited (${code ?? signal}), restarting`);
      this.display = null;
      const delay = Math.min(RESTART_BACKOFF_MAX_MS, 1000 * 2 ** this.xvfbRestarts);
      this.xvfbRestarts++;
      setTimeout(() => this.startXvfb(() => undefined), delay).unref();
    });
  }

  private launchSurf(): void {
    const display = this.display;
    if (this.stopped || !display) return;
    const env = { ...process.env, DISPLAY: display };

    try { this.unclutter?.kill("SIGTERM"); } catch { /* gone */ }
    this.unclutter = spawn("unclutter", ["-idle", "0", "-root"], { env, stdio: "ignore" });
    this.unclutter.on("error", () => { /* cosmetic; ignore */ });

    try { this.surf?.kill("SIGTERM"); } catch { /* gone */ }
    const surf = spawn(this.surfPath, [this.config.url], { env, stdio: ["ignore", "ignore", "pipe"] });
    this.surf = surf;
    this.log.info(`[${this.config.name}] surf rendering ${this.config.url}`);

    setTimeout(() => {
      if (this.surf === surf) this.surfRestarts = 0;
    }, RESTART_BACKOFF_RESET_MS).unref();

    surf.stderr?.on("data", (d: Buffer) => this.log.debug(`[${this.config.name}] surf: ${d.toString().trim()}`));
    surf.on("error", (err) => this.log.error(`[${this.config.name}] surf failed: ${err.message}`));
    surf.on("exit", (code, signal) => {
      if (this.stopped || this.surf !== surf) return;
      const delay = Math.min(RESTART_BACKOFF_MAX_MS, 1000 * 2 ** this.surfRestarts);
      this.surfRestarts++;
      this.log.warn(`[${this.config.name}] surf exited (${code ?? signal}), relaunching in ${delay / 1000}s`);
      setTimeout(() => {
        if (!this.stopped && this.surf === surf) this.launchSurf();
      }, delay).unref();
    });
  }

  stop(): void {
    this.stopped = true;
    for (const p of [this.surf, this.unclutter, this.xvfb]) {
      try { p?.kill("SIGTERM"); } catch { /* gone */ }
    }
    this.surf = null;
    this.unclutter = null;
    this.xvfb = null;
    this.display = null;
  }
}
