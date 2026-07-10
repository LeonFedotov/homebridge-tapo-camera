import { Logging } from "homebridge";
import { SourceProvider } from "./sourceProvider";
import { SnapshotStore } from "./snapshotStore";

const FRESH_MS = 5_000;
const STALE_OK_MS = 60_000;

/**
 * Snapshots served from the relay's frame endpoint: fresh cache for the Home
 * app's aggressive tile polling, stale fallback so a camera blip shows the
 * last good frame instead of an error. Successful frames also feed the
 * persistent SnapshotStore (last-known cover images).
 */
export class SnapshotService {
  private last: { data: Buffer; takenAt: number } | null = null;
  private inflight: Promise<Buffer> | null = null;

  constructor(
    private readonly log: Logging,
    private readonly provider: SourceProvider,
    private readonly cameraId: string,
    private readonly store?: SnapshotStore
  ) {}

  async get(): Promise<Buffer> {
    const now = Date.now();
    if (this.last && now - this.last.takenAt < FRESH_MS) {
      return this.last.data;
    }

    // Collapse concurrent polls into one fetch.
    if (!this.inflight) {
      this.inflight = this.provider
        .getFrame(this.cameraId)
        .then((data) => {
          this.last = { data, takenAt: Date.now() };
          this.store?.put(this.cameraId, data);
          return data;
        })
        .finally(() => {
          this.inflight = null;
        });
    }

    try {
      return await this.inflight;
    } catch (err) {
      if (this.last && now - this.last.takenAt < STALE_OK_MS) {
        this.log.debug(
          `Snapshot fetch failed (${(err as Error).message}), serving stale`
        );
        return this.last.data;
      }
      throw err;
    }
  }
}
