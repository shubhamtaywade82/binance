import type { ModelOutput, ExtendedModelOutput } from './model-types';

export interface InferenceClientConfig {
  url: string;
  timeoutMs: number;
  maxRetries: number;
  circuitBreakerThreshold: number;
  circuitBreakerResetMs: number;
}

const DEFAULT_CONFIG: InferenceClientConfig = {
  url: 'http://localhost:8000/infer',
  timeoutMs: 2_000,
  maxRetries: 1,
  circuitBreakerThreshold: 5,
  circuitBreakerResetMs: 30_000,
};

const FALLBACK_OUTPUT: ModelOutput = { p_up: 0, p_down: 0, p_flat: 1 };

export class InferenceClient {
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  private readonly cfg: InferenceClientConfig;

  constructor(config?: Partial<InferenceClientConfig>) {
    this.cfg = { ...DEFAULT_CONFIG, ...config };
  }

  async predict(features: Record<string, number>): Promise<ExtendedModelOutput | null> {
    if (this.isCircuitOpen()) return null;

    for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt++) {
      try {
        const result = await this.fetchPrediction(features);
        this.consecutiveFailures = 0;
        return result;
      } catch {
        if (attempt === this.cfg.maxRetries) {
          this.recordFailure();
          return null;
        }
      }
    }
    return null;
  }

  isCircuitOpen(): boolean {
    if (this.circuitOpenUntil === 0) return false;
    if (Date.now() >= this.circuitOpenUntil) {
      this.circuitOpenUntil = 0;
      this.consecutiveFailures = 0;
      return false;
    }
    return true;
  }

  resetCircuit(): void {
    this.consecutiveFailures = 0;
    this.circuitOpenUntil = 0;
  }

  get failureCount(): number {
    return this.consecutiveFailures;
  }

  private async fetchPrediction(features: Record<string, number>): Promise<ExtendedModelOutput> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);

    try {
      const res = await fetch(this.cfg.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ features }),
        signal: controller.signal,
      });

      if (!res.ok) throw new Error(`inference HTTP ${res.status}`);

      const data = (await res.json()) as Record<string, unknown>;
      const output: ExtendedModelOutput = {
        p_up: Number(data.p_up) || 0,
        p_down: Number(data.p_down) || 0,
        p_flat: Number(data.p_flat) || 0,
      };
      if (typeof data.model_version === 'string') output.model_version = data.model_version;
      if (typeof data.regime === 'string') output.regime = data.regime as ExtendedModelOutput['regime'];
      if (typeof data.expected_volatility === 'number') output.expected_volatility = data.expected_volatility;
      if (typeof data.expected_slippage === 'number') output.expected_slippage = data.expected_slippage;
      if (typeof data.fill_probability === 'number') output.fill_probability = data.fill_probability;
      if (typeof data.adverse_move_probability === 'number') output.adverse_move_probability = data.adverse_move_probability;
      return output;
    } finally {
      clearTimeout(timer);
    }
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.cfg.circuitBreakerThreshold) {
      this.circuitOpenUntil = Date.now() + this.cfg.circuitBreakerResetMs;
    }
  }
}

export { FALLBACK_OUTPUT };
