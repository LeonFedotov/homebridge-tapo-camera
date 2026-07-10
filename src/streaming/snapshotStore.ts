import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { Logging } from "homebridge";

// A rendered page / camera frame that's mostly-black compresses tiny; anything
// above this is treated as real content worth keeping and showing as a cover.
export const CONTENT_MIN_BYTES = 6000;
const DISK_THROTTLE_MS = 10_000;

/**
 * Per-camera "last known good frame", cached in memory and persisted to disk
 * so a cover image survives restarts. Used to show the last frame instantly
 * while a lazy source (surf) warms up, instead of a blank/loading tile.
 */
export class SnapshotStore {
  private readonly mem = new Map<string, Buffer>();
  private readonly lastWrite = new Map<string, number>();
  private readonly dir: string;

  constructor(private readonly log: Logging, baseDir: string) {
    this.dir = join(baseDir, "snapshots");
    try {
      mkdirSync(this.dir, { recursive: true });
      for (const f of readdirSync(this.dir)) {
        if (!f.endsWith(".jpg")) continue;
        try {
          this.mem.set(f.slice(0, -4), readFileSync(join(this.dir, f)));
        } catch {
          /* skip unreadable */
        }
      }
    } catch (err) {
      this.log.debug(`snapshot store init: ${(err as Error).message}`);
    }
  }

  get(id: string): Buffer | null {
    return this.mem.get(id) ?? null;
  }

  /** On-disk path for a stored frame (an ffmpeg cover input), or null. */
  path(id: string): string | null {
    const p = join(this.dir, `${id}.jpg`);
    return existsSync(p) ? p : null;
  }

  /** Store a frame if it looks like real content (ignores black/tiny frames). */
  put(id: string, jpeg: Buffer): void {
    if (!jpeg || jpeg.length < CONTENT_MIN_BYTES) return;
    this.mem.set(id, jpeg);
    const p = join(this.dir, `${id}.jpg`);
    const now = Date.now();
    // Always write if there's no file yet (cover must exist on disk); then
    // throttle updates to avoid hammering the SD card.
    if (!existsSync(p) || (this.lastWrite.get(id) ?? 0) + DISK_THROTTLE_MS < now) {
      this.lastWrite.set(id, now);
      try {
        writeFileSync(p, jpeg);
      } catch (err) {
        this.log.debug(`snapshot store write ${id}: ${(err as Error).message}`);
      }
    }
  }
}
