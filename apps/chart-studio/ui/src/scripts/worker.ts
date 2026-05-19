/// <reference lib="webworker" />
import { createContext, prepare, runBar, tokenize, parse, type CandleLike, type SerializedScriptOutput } from '@chart-studio/indicator-runtime';

export interface ScriptWorkerRequest {
  type: 'run';
  reqId: string;
  source: string;
  candles: CandleLike[];
  inputs?: Record<string, unknown>;
}

export interface ScriptWorkerResponse {
  reqId: string;
  ok: boolean;
  error?: string;
  outputs?: SerializedScriptOutput[];
}

self.addEventListener('message', (ev: MessageEvent<ScriptWorkerRequest>) => {
  const req = ev.data;
  if (!req || req.type !== 'run') return;
  try {
    const tokens = tokenize(req.source);
    const program = parse(tokens);
    const ctx = createContext({ seriesCapacity: req.candles.length + 4 });
    if (req.inputs) for (const [k, v] of Object.entries(req.inputs)) ctx.setInput(k, v);
    prepare(program, ctx);
    for (let i = 0; i < req.candles.length; i += 1) {
      const c = req.candles[i]!;
      ctx.pushBar(c);
      ctx.resetForBar(i);
      runBar(program, ctx, i);
    }
    const outputs = ctx.snapshotOutputs();
    const resp: ScriptWorkerResponse = { reqId: req.reqId, ok: true, outputs };
    (self as unknown as Worker).postMessage(resp);
  } catch (err) {
    const resp: ScriptWorkerResponse = { reqId: req.reqId, ok: false, error: err instanceof Error ? err.message : String(err) };
    (self as unknown as Worker).postMessage(resp);
  }
});
