import { HtmlRender } from "./htmlRender";

const IDLE_STOP_GRACE_MS = 15_000;

/**
 * Owns the HTML renders and gates surf on demand. Two kinds of holds:
 *
 * - Viewer holds (acquire/release): a client is streaming. On the last
 *   release, surf stops after a short grace (avoids flapping between quick
 *   reopens).
 * - Capture holds (withRender): a brief wake to grab a preview frame. On the
 *   last release, surf stops IMMEDIATELY — a scheduled capture shouldn't keep
 *   surf lingering, which at a short refresh interval would defeat laziness.
 *
 * surf runs whenever either count is > 0. acquire/withRender are no-ops for
 * non-HTML camera ids, so callers can treat every member uniformly.
 */
export class HtmlRenderManager {
  private readonly renders = new Map<string, HtmlRender>();
  private readonly viewers = new Map<string, number>();
  private readonly captures = new Map<string, number>();
  private readonly stopTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly graceMs = IDLE_STOP_GRACE_MS) {}

  register(cameraId: string, render: HtmlRender): void {
    this.renders.set(cameraId, render);
  }

  has(cameraId: string): boolean {
    return this.renders.has(cameraId);
  }

  busy(cameraId: string): boolean {
    return (this.viewers.get(cameraId) ?? 0) > 0;
  }

  private wanted(id: string): boolean {
    return (this.viewers.get(id) ?? 0) > 0 || (this.captures.get(id) ?? 0) > 0;
  }

  private clearGrace(id: string): void {
    const t = this.stopTimers.get(id);
    if (t) {
      clearTimeout(t);
      this.stopTimers.delete(id);
    }
  }

  acquire(cameraId: string): void {
    const render = this.renders.get(cameraId);
    if (!render) return;
    this.clearGrace(cameraId);
    this.viewers.set(cameraId, (this.viewers.get(cameraId) ?? 0) + 1);
    render.ensureSurf();
  }

  release(cameraId: string): void {
    const render = this.renders.get(cameraId);
    if (!render) return;
    this.viewers.set(cameraId, Math.max(0, (this.viewers.get(cameraId) ?? 0) - 1));
    if (!this.wanted(cameraId) && !this.stopTimers.has(cameraId)) {
      const timer = setTimeout(() => {
        this.stopTimers.delete(cameraId);
        if (!this.wanted(cameraId)) render.stopSurf();
      }, this.graceMs);
      timer.unref();
      this.stopTimers.set(cameraId, timer);
    }
  }

  /**
   * Ensure surf is rendering for the duration of fn (a preview capture), then
   * drop the hold. If no viewer remains, surf stops immediately. No-op wrapper
   * for non-HTML ids.
   */
  async withRender<T>(cameraId: string, fn: () => Promise<T>): Promise<T> {
    const render = this.renders.get(cameraId);
    if (!render) return fn();
    this.clearGrace(cameraId);
    this.captures.set(cameraId, (this.captures.get(cameraId) ?? 0) + 1);
    render.ensureSurf();
    try {
      return await fn();
    } finally {
      this.captures.set(cameraId, Math.max(0, (this.captures.get(cameraId) ?? 0) - 1));
      if (!this.wanted(cameraId)) {
        this.clearGrace(cameraId);
        render.stopSurf();
      }
    }
  }

  stopAll(): void {
    for (const t of this.stopTimers.values()) clearTimeout(t);
    this.stopTimers.clear();
    for (const render of this.renders.values()) render.stop();
  }
}
