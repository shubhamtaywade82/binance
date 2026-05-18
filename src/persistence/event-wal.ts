import * as fs from 'node:fs';
import * as path from 'node:path';

export interface WalEvent {
  id: string;
  type: string;
  ts: number;
  source: string;
  symbol?: string;
  payload: unknown;
}

/**
 * EventWal — append-only write-ahead log for the Postgres event stream.
 *
 * Each call to `append()` writes one NDJSON line and fsyncs the file. On
 * startup, `replayAll()` re-reads every line so the PgWriter can re-enqueue
 * events that were durable on disk but had not yet been flushed to Postgres
 * when the process died (OOM, SIGKILL, host reboot, container eviction).
 *
 * Compaction (`compact(keepPredicate)`) rewrites the file atomically via
 * `tmp + rename` to retain only the events whose IDs the caller still cares
 * about — typically those that have NOT been successfully flushed to Postgres.
 * The PgWriter calls compact after every successful batch flush so the WAL
 * never grows unboundedly during a healthy run.
 *
 * The format is deliberately the simplest thing that survives a kernel crash:
 * NDJSON, one event per line, terminated with `\n`. A partially-written final
 * line (kill -9 between write() and fsync()) is detected and skipped during
 * replay; the file is then truncated to drop the corrupt tail.
 */
export class EventWal {
  private fd: number | null = null;
  private readonly walPath: string;

  constructor(walPath: string) {
    this.walPath = walPath;
    const dir = path.dirname(walPath);
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /** Open the WAL file. Idempotent. */
  open(): void {
    if (this.fd !== null) return;
    this.fd = fs.openSync(this.walPath, 'a');
  }

  close(): void {
    if (this.fd !== null) {
      try { fs.closeSync(this.fd); } catch { /* ignore */ }
      this.fd = null;
    }
  }

  /**
   * Append a single event. Returns synchronously after fsync — the event is
   * durable on disk before this call returns. Throws on I/O failure so the
   * caller can decide what to do (typically: refuse to acknowledge the event
   * upstream).
   */
  append(event: WalEvent): void {
    if (this.fd === null) this.open();
    const line = JSON.stringify(event) + '\n';
    fs.writeSync(this.fd!, line);
    fs.fsyncSync(this.fd!);
  }

  /**
   * Read the entire WAL into memory. Skips any malformed / partial lines so a
   * crash mid-write doesn't poison startup. Logs the skipped count via the
   * optional `onCorrupt` callback so an operator can see what was dropped.
   */
  replayAll(onCorrupt?: (line: string, err: Error) => void): WalEvent[] {
    if (!fs.existsSync(this.walPath)) return [];
    const raw = fs.readFileSync(this.walPath, 'utf8');
    const lines = raw.split('\n');
    const out: WalEvent[] = [];
    for (const line of lines) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as WalEvent);
      } catch (err) {
        onCorrupt?.(line, err as Error);
      }
    }
    return out;
  }

  /**
   * Rewrite the WAL atomically to retain only events for which keepPredicate
   * returns true. The caller closes the file briefly during the rename so the
   * fd remains valid for subsequent appends. Used by the PgWriter after a
   * successful batch flush to drop ACK'd events.
   */
  compact(keepPredicate: (e: WalEvent) => boolean): { kept: number; dropped: number } {
    const events = this.replayAll();
    const kept = events.filter(keepPredicate);
    const dropped = events.length - kept.length;
    if (dropped === 0) return { kept: kept.length, dropped: 0 };

    // Atomic replace: write a tmp file, then rename.
    const tmpPath = `${this.walPath}.tmp`;
    const body = kept.length === 0 ? '' : kept.map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(tmpPath, body);

    // Close current fd before rename so Windows + some Linux configurations
    // don't fight over the inode. open() lazily on next append.
    this.close();
    fs.renameSync(tmpPath, this.walPath);
    return { kept: kept.length, dropped };
  }

  /** Best-effort size in bytes; 0 if the file doesn't exist yet. */
  sizeBytes(): number {
    if (!fs.existsSync(this.walPath)) return 0;
    return fs.statSync(this.walPath).size;
  }
}
