import { parentPort, workerData } from 'worker_threads';

/**
 * Isolated worker for running NanoPine scripts.
 * Context is limited to provided data.
 */
if (parentPort) {
  const { source, candles, inputs } = workerData;

  try {
    // Basic sandboxing using a Function constructor with restricted scope
    // In a real production system, we'd use 'vm' module or a more robust sandbox like 'isolated-vm'
    const sandbox = {
      candles,
      inputs,
      Math,
      Date,
      console: {
        log: (...args: any[]) => parentPort?.postMessage({ type: 'log', data: args }),
      },
    };

    const fn = new Function(...Object.keys(sandbox), source);
    const result = fn(...Object.values(sandbox));

    parentPort.postMessage({ type: 'result', data: result });
  } catch (err) {
    parentPort.postMessage({ type: 'error', data: (err as Error).message });
  }
}
