export type StopFn = () => Promise<void> | void;

export interface LifecycleLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export interface LifecycleRegisterOpts {
  timeoutMs?: number;
}

export interface LifecycleOptions {
  defaultTimeoutMs?: number;
  forceExitMs?: number;
  log?: LifecycleLogger;
}

interface Entry {
  name: string;
  stop: StopFn;
  timeoutMs: number;
}

const noopLog: LifecycleLogger = { info: () => undefined, warn: () => undefined };

const withTimeout = <T>(p: Promise<T>, ms: number, name: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`lifecycle_stop_timeout:${name}:${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });

export class Lifecycle {
  private entries: Entry[] = [];
  private shuttingDown: Promise<void> | null = null;
  private readonly defaultTimeoutMs: number;
  private readonly forceExitMs: number;
  private readonly log: LifecycleLogger;
  private signalsAttached = false;
  private detachers: Array<() => void> = [];

  constructor(opts: LifecycleOptions = {}) {
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 5000;
    this.forceExitMs = opts.forceExitMs ?? 10_000;
    this.log = opts.log ?? noopLog;
  }

  register(name: string, stop: StopFn, opts: LifecycleRegisterOpts = {}): void {
    this.entries.push({ name, stop, timeoutMs: opts.timeoutMs ?? this.defaultTimeoutMs });
  }

  isShuttingDown(): boolean {
    return this.shuttingDown !== null;
  }

  shutdown(reason: string): Promise<void> {
    if (this.shuttingDown) return this.shuttingDown;
    this.log.info('lifecycle_shutdown_started', { reason, entries: this.entries.length });

    let forceTimer: ReturnType<typeof setTimeout> | null = null;
    if (this.forceExitMs > 0) {
      forceTimer = setTimeout(() => {
        this.log.warn('lifecycle_force_exit', { reason, afterMs: this.forceExitMs });
        process.exit(reason === 'error' ? 1 : 0);
      }, this.forceExitMs);
      if (typeof forceTimer.unref === 'function') forceTimer.unref();
    }

    this.shuttingDown = (async () => {
      const errors: Array<{ name: string; err: string }> = [];
      const ordered = [...this.entries].reverse();
      for (const e of ordered) {
        try {
          const result = e.stop();
          if (result && typeof (result as Promise<void>).then === 'function') {
            await withTimeout(result as Promise<void>, e.timeoutMs, e.name);
          }
        } catch (err) {
          errors.push({ name: e.name, err: (err as Error).message });
          this.log.warn('lifecycle_stop_error', { name: e.name, err: (err as Error).message });
        }
      }
      if (forceTimer) clearTimeout(forceTimer);
      this.log.info('lifecycle_shutdown_completed', { reason, errors: errors.length });
    })();
    return this.shuttingDown;
  }

  attachProcessHandlers(log?: LifecycleLogger): void {
    if (this.signalsAttached) return;
    this.signalsAttached = true;
    if (log) (this as unknown as { log: LifecycleLogger }).log = log;

    const exitAfter = (reason: string) => {
      void this.shutdown(reason).then(() => {
        process.exit(reason === 'error' ? 1 : 0);
      });
    };

    const onSignal = (sig: NodeJS.Signals) => exitAfter(sig);
    const onUncaught = (err: unknown) => {
      this.log.warn('uncaught_exception', { err: (err as Error)?.message ?? String(err) });
      exitAfter('error');
    };
    const onUnhandled = (reason: unknown) => {
      this.log.warn('unhandled_rejection', { err: (reason as Error)?.message ?? String(reason) });
      exitAfter('error');
    };
    const onBeforeExit = () => {
      if (!this.shuttingDown) void this.shutdown('beforeExit');
    };

    const sigs: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    for (const s of sigs) {
      process.on(s, onSignal);
      this.detachers.push(() => process.off(s, onSignal));
    }
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onUnhandled);
    process.on('beforeExit', onBeforeExit);
    this.detachers.push(
      () => process.off('uncaughtException', onUncaught),
      () => process.off('unhandledRejection', onUnhandled),
      () => process.off('beforeExit', onBeforeExit),
    );
  }

  detachProcessHandlers(): void {
    for (const fn of this.detachers) fn();
    this.detachers = [];
    this.signalsAttached = false;
  }
}
