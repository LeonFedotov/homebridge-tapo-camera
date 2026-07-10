import { Logging } from "homebridge";
import { HtmlRenderManager } from "./htmlRenderManager";
import { SnapshotStore } from "./snapshotStore";
import { SourceProvider } from "./sourceProvider";
import { CONTENT_MIN_BYTES } from "./snapshotStore";

export const MIN_REFRESH_SECONDS = 10;
const GRAB_ATTEMPTS = 8;
const GRAB_INTERVAL_MS = 700;

/**
 * Periodically wakes a lazy HTML source just long enough to grab a fresh
 * frame into the SnapshotStore, so the Home app tile (which shows the last
 * stored cover when idle) stays reasonably current without surf running 24/7.
 * The wake goes through HtmlRenderManager.withRender, so surf stops again the
 * moment the capture finishes (unless a real viewer is also watching).
 */
export class PreviewRefresher {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly log: Logging,
    private readonly cameraId: string,
    private readonly intervalMs: number,
    private readonly manager: HtmlRenderManager,
    private readonly provider: SourceProvider,
    private readonly store: SnapshotStore
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running || !this.provider.isReady()) return;
    this.running = true;
    try {
      await this.manager.withRender(this.cameraId, async () => {
        for (let i = 0; i < GRAB_ATTEMPTS; i++) {
          try {
            const frame = await this.provider.getFrame(this.cameraId);
            if (frame.length >= CONTENT_MIN_BYTES) {
              this.store.put(this.cameraId, frame);
              return;
            }
          } catch {
            /* warming up / transient — retry */
          }
          await new Promise((r) => setTimeout(r, GRAB_INTERVAL_MS));
        }
      });
    } catch (err) {
      this.log.debug(`preview refresh ${this.cameraId}: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
