import { HtmlRender } from "./htmlRender";

const IDLE_STOP_GRACE_MS = 15_000;

/**
 * Owns the HTML renders and gates surf on demand via refcounting. A delegate
 * calls acquire(cameraId) when it starts consuming a source and release() when
 * it stops; surf renders only while the refcount is > 0 (idle after a grace
 * period). acquire/release are no-ops for non-HTML camera ids, so callers
 * (e.g. the mosaic) can blindly acquire every member.
 */
export class HtmlRenderManager {
  private readonly renders = new Map<string, HtmlRender>();
  private readonly refcounts = new Map<string, number>();
  private readonly stopTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly graceMs = IDLE_STOP_GRACE_MS) {}

  register(cameraId: string, render: HtmlRender): void {
    this.renders.set(cameraId, render);
  }

  has(cameraId: string): boolean {
    return this.renders.has(cameraId);
  }

  acquire(cameraId: string): void {
    const render = this.renders.get(cameraId);
    if (!render) return; // not an HTML source — nothing to render
    const t = this.stopTimers.get(cameraId);
    if (t) {
      clearTimeout(t);
      this.stopTimers.delete(cameraId);
    }
    this.refcounts.set(cameraId, (this.refcounts.get(cameraId) ?? 0) + 1);
    render.ensureSurf();
  }

  release(cameraId: string): void {
    const render = this.renders.get(cameraId);
    if (!render) return;
    const n = Math.max(0, (this.refcounts.get(cameraId) ?? 0) - 1);
    this.refcounts.set(cameraId, n);
    if (n === 0 && !this.stopTimers.has(cameraId)) {
      const timer = setTimeout(() => {
        this.stopTimers.delete(cameraId);
        if ((this.refcounts.get(cameraId) ?? 0) === 0) render.stopSurf();
      }, this.graceMs);
      timer.unref();
      this.stopTimers.set(cameraId, timer);
    }
  }

  stopAll(): void {
    for (const t of this.stopTimers.values()) clearTimeout(t);
    this.stopTimers.clear();
    for (const render of this.renders.values()) render.stop();
  }
}
