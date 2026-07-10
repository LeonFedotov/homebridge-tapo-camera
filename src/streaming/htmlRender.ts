import { ChildProcess, execFileSync, spawn } from "child_process";
import { existsSync } from "fs";
import { dirname, join } from "path";
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
 * Tapo audio path) does NOT, so HTML capture needs a separate binary.
 */
export function resolveX11grabFfmpeg(explicit?: string): string | null {
  const explicitPaths = [explicit, process.env.HTML_FFMPEG_PATH].filter(
    (p): p is string => Boolean(p)
  );
  const systemPaths = ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"];
  for (const candidate of [...explicitPaths, ...systemPaths]) {
    if (explicitPaths.includes(candidate) && !existsSync(candidate)) continue;
    try {
      const out = execFileSync(candidate, ["-hide_banner", "-devices"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (/x11grab/.test(out)) return candidate;
    } catch {
      /* not runnable */
    }
  }
  return null;
}

/** go2rtc `exec:` source that captures the X display as H.264 RTSP. */
export function buildCaptureCommand(opts: {
  ffmpeg: string;
  display: string;
  width: number;
  height: number;
  fps: number;
}): string {
  return [
    `exec:${opts.ffmpeg}`,
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
 * Renders one HTML page on a private X display. The Xvfb display stays up for
 * the life of the plugin (idle cost ~0), but surf — which is the real CPU
 * cost (WebKit rendering, esp. animated pages) — runs only while a client is
 * watching. surf is started/stopped on demand via ensureSurf()/stopSurf(),
 * driven by the render manager's refcount.
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
  private surfWanted = false;
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

  /** Start the Xvfb display (NOT surf); resolves with the display number. */
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

  get isRendering(): boolean {
    return this.surf !== null;
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
      // If a viewer was already waiting, (re)start surf now that the display exists.
      if (this.surfWanted) this.launchSurf();
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

  /** Ensure surf is rendering the page (starts it if not already). */
  ensureSurf(): void {
    if (this.stopped) return;
    this.surfWanted = true;
    if (!this.surf && this.display) this.launchSurf();
  }

  /** Stop surf (frees the WebKit CPU); the Xvfb display stays up. */
  stopSurf(): void {
    this.surfWanted = false;
    try {
      this.surf?.kill("SIGTERM");
    } catch {
      /* gone */
    }
    try {
      this.unclutter?.kill("SIGTERM");
    } catch {
      /* gone */
    }
    this.surf = null;
    this.unclutter = null;
    this.log.debug(`[${this.config.name}] surf stopped (idle)`);
  }

  private launchSurf(): void {
    const display = this.display;
    if (this.stopped || !display || !this.surfWanted) return;

    const env: NodeJS.ProcessEnv = { ...process.env, DISPLAY: display };
    const webextDir = dirname(this.surfPath);
    if (existsSync(join(webextDir, "webext-surf.so"))) env.WEBEXTDIR = webextDir;

    try {
      this.unclutter?.kill("SIGTERM");
    } catch {
      /* gone */
    }
    this.unclutter = spawn("unclutter", ["-idle", "0", "-root"], { env, stdio: "ignore" });
    this.unclutter.on("error", () => { /* cosmetic */ });

    try {
      this.surf?.kill("SIGTERM");
    } catch {
      /* gone */
    }
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
      this.surf = null;
      if (!this.surfWanted) return; // intentional stop
      const delay = Math.min(RESTART_BACKOFF_MAX_MS, 1000 * 2 ** this.surfRestarts);
      this.surfRestarts++;
      this.log.warn(`[${this.config.name}] surf exited (${code ?? signal}), relaunching in ${delay / 1000}s`);
      setTimeout(() => {
        if (!this.stopped && this.surfWanted && !this.surf) this.launchSurf();
      }, delay).unref();
    });
  }

  stop(): void {
    this.stopped = true;
    this.surfWanted = false;
    for (const p of [this.surf, this.unclutter, this.xvfb]) {
      try {
        p?.kill("SIGTERM");
      } catch {
        /* gone */
      }
    }
    this.surf = null;
    this.unclutter = null;
    this.xvfb = null;
    this.display = null;
  }
}
