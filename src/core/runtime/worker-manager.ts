import { Worker } from 'worker_threads';
import path from 'path';
import { Candle } from '../../types';

export interface WorkerResult {
  type: 'result' | 'error' | 'log';
  data: any;
}

export class ScriptWorkerManager {
  private workerPath = path.resolve(__dirname, 'script-worker.js'); // Assumes compiled JS location

  public async runScript(source: string, candles: Candle[], inputs: Record<string, any>): Promise<any> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(this.workerPath, {
        workerData: { source, candles, inputs }
      });

      worker.on('message', (msg: WorkerResult) => {
        if (msg.type === 'result') {
          resolve(msg.data);
          worker.terminate();
        } else if (msg.type === 'error') {
          reject(new Error(msg.data));
          worker.terminate();
        } else if (msg.type === 'log') {
          console.log(`[ScriptWorker]`, ...msg.data);
        }
      });

      worker.on('error', (err) => {
        reject(err);
      });

      worker.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`Worker stopped with exit code ${code}`));
        }
      });

      // Timeout safety
      setTimeout(() => {
        worker.terminate();
        reject(new Error('Script execution timed out'));
      }, 5000);
    });
  }
}
