import { parentPort, workerData } from 'worker_threads';
import { runInSandbox } from './sandbox';

/**
 * Worker entry point — delegates to `runInSandbox` (see sandbox.ts) for the
 * actual isolation logic so the security-critical code is unit-testable
 * without spinning up a Worker per test.
 */
if (parentPort) {
  const { source, candles, inputs, timeoutMs } = workerData as {
    source: string;
    candles: unknown[];
    inputs: Record<string, unknown>;
    timeoutMs?: number;
  };

  try {
    const result = runInSandbox(source, candles, inputs, {
      timeoutMs,
      onLog: (...args) => parentPort?.postMessage({ type: 'log', data: args }),
    });
    parentPort.postMessage({ type: 'result', data: result });
  } catch (err) {
    parentPort.postMessage({ type: 'error', data: (err as Error).message });
  }
}
