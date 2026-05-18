import { describe, it, expect, vi } from 'vitest';
import { SelfLearningRuntime } from '../src/self-learning/runtime';

class FakeBus {
  subscribe(): void {}
}

describe('SelfLearningRuntime gating', () => {
  it('does not start when disabled', async () => {
    const rt = new SelfLearningRuntime(
      { enabled: false, paperOnly: true, executionMode: 'paper', intervalMs: 1000, ollamaUrl: '', ollamaModel: '' },
      new FakeBus() as any,
      null,
      { info: vi.fn(), warn: vi.fn() },
    );
    await expect(rt.start()).resolves.toBeUndefined();
  });

  it('does not start in live mode when paper-only is enabled', async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const rt = new SelfLearningRuntime(
      { enabled: true, paperOnly: true, executionMode: 'live', intervalMs: 1000, ollamaUrl: '', ollamaModel: '' },
      new FakeBus() as any,
      null,
      log,
    );
    await rt.start();
    expect(log.warn).toHaveBeenCalledWith('self_learning_disabled_live_mode', { reason: 'paper_only_gate' });
  });
});
