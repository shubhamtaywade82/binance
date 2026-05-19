import type { ScriptWorkerRequest, ScriptWorkerResponse } from './worker';
import type { Candle } from '../provider-client';
import type { SerializedScriptOutput } from '@chart-studio/indicator-runtime';

const STORAGE_KEY = 'chart-studio:scripts:v1';
const DEFAULT_SCRIPT = `// NanoPine script — runs in a Web Worker, computed bar-by-bar.
indicator(title="My Script", overlay=true)
ema20 = ema(close, 20)
ema50 = ema(close, 50)
plot(ema20, title="EMA 20", color="#58a6ff")
plot(ema50, title="EMA 50", color="#bc8cff")
`;

export interface SavedScript {
  id: string;
  name: string;
  source: string;
  enabled: boolean;
}

export interface ScriptResult {
  scriptId: string;
  outputs: SerializedScriptOutput[];
}

export const loadScripts = (): SavedScript[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [{ id: 'default', name: 'Hello NanoPine', source: DEFAULT_SCRIPT, enabled: false }];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
};

export const saveScripts = (list: SavedScript[]): void => {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch { /* noop */ }
};

export class ScriptRunner {
  private worker: Worker;
  private pending = new Map<string, (resp: ScriptWorkerResponse) => void>();
  private nextId = 1;

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.addEventListener('message', (ev: MessageEvent<ScriptWorkerResponse>) => {
      const cb = this.pending.get(ev.data.reqId);
      if (!cb) return;
      this.pending.delete(ev.data.reqId);
      cb(ev.data);
    });
  }

  run(script: SavedScript, candles: Candle[]): Promise<ScriptWorkerResponse> {
    const reqId = `r${this.nextId++}`;
    const req: ScriptWorkerRequest = {
      type: 'run',
      reqId,
      source: script.source,
      candles: candles.map((c) => ({ openTime: c.openTime, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })),
    };
    return new Promise<ScriptWorkerResponse>((resolve) => {
      this.pending.set(reqId, resolve);
      this.worker.postMessage(req);
    });
  }

  dispose(): void {
    this.worker.terminate();
    this.pending.clear();
  }
}
