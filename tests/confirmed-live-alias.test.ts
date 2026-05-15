import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppConfigSchema } from '../src/config';

describe('CONFIRMED_LIVE_TRADING', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('honors CONFIRMED_LIVE when CONFIRMED_LIVE_TRADING is empty', () => {
    vi.stubEnv('CONFIRMED_LIVE_TRADING', '');
    vi.stubEnv('CONFIRMED_LIVE', 'true');
    expect(AppConfigSchema.parse(process.env).CONFIRMED_LIVE_TRADING).toBe(true);
  });

  it('prefers CONFIRMED_LIVE_TRADING when both are set', () => {
    vi.stubEnv('CONFIRMED_LIVE', 'true');
    vi.stubEnv('CONFIRMED_LIVE_TRADING', 'false');
    expect(AppConfigSchema.parse(process.env).CONFIRMED_LIVE_TRADING).toBe(false);
  });
});
