import { Worker } from 'worker_threads';
import path from 'path';
import { Candle } from '../../types';

export interface WorkerResult {
  type: 'result' | 'error' | 'log';
  data: any;
}

export interface ScriptWorkerOptions {
  /** Per-script wall-clock timeout in ms. Default 2000. */
  timeoutMs?: number;
  /** Worker heap cap in MB. Default 64. */
  maxOldGenerationSizeMb?: number;
}

/**
 * H-12: ScriptWorkerManager combines per-worker heap caps (worker_threads
 * `resourceLimits`), per-script CPU budget (vm.Script `timeout`), and a
 * forced terminate watchdog so a malicious or buggy script cannot:
 *   (a) escape the sandbox via __proto__ / constructor chain — vm context
 *       with `codeGeneration` disabled handles this in script-worker.ts;
 *   (b) exhaust the host's heap — heap cap is per-worker, parent process
 *       remains responsive even if a worker OOMs;
 *   (c) burn CPU — script timeout + worker.terminate() watchdog.
 */
export class ScriptWorkerManager {
  private workerPath = path.resolve(__dirname, 'script-worker.js'); // Assumes compiled JS location
  private readonly timeoutMs: number;
  private readonly maxOldGenerationSizeMb: number;

  constructor(opts: ScriptWorkerOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 2000;
    this.maxOldGenerationSizeMb = opts.maxOldGenerationSizeMb ?? 64;
  }

  public async runScript(source: string, candles: Candle[], inputs: Record<string, any>): Promise<any> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(this.workerPath, {
        workerData: { source, candles, inputs, timeoutMs: this.timeoutMs },
        resourceLimits: {
          // H-12: per-worker V8 heap cap. A runaway `new Array(1e8)` now
          // crashes the worker, not the parent bot.
          maxOldGenerationSizeMb: this.maxOldGenerationSizeMb,
          maxYoungGenerationSizeMb: 8,
        },
      });
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        fn();
        worker.terminate().catch(() => undefined);
      };

      worker.on('message', (msg: WorkerResult) => {
        if (msg.type === 'result') {
          settle(() => resolve(msg.data));
        } else if (msg.type === 'error') {
          settle(() => reject(new Error(msg.data)));
        } else if (msg.type === 'log') {
          console.log(`[ScriptWorker]`, ...msg.data);
        }
      });

      worker.on('error', (err) => {
        settle(() => reject(err));
      });

      worker.on('exit', (code) => {
        if (!settled && code !== 0) {
          settle(() => reject(new Error(`Worker stopped with exit code ${code}`)));
        }
      });

      // Wall-clock watchdog. vm.Script's timeout option handles single-
      // expression CPU bounds inside the context; this catches misbehaving
      // host-side native calls or workers that ignore the V8 interrupt.
      const watchdog = setTimeout(() => {
        settle(() => reject(new Error('Script execution timed out')));
      }, this.timeoutMs + 500);
    });
  }
}
