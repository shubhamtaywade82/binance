import { describe, expect, it } from 'vitest';
import { RiskManager } from '../src/strategy/risk';
import type { AppConfig } from '../src/config';

const baseConfig = {
  CAPITAL_PER_TRADE_USDT: 100,
  CAPITAL_PER_TRADE_INR: 0,
  INR_PER_USDT: 85,
  LEVERAGE: 10,
  TP_PRICE_PCT: 0.015,
  SL_PRICE_PCT: 0.01,
  TAKER_FEE: 0.0004,
  FUNDING_FEE_EST: 0.0001,
  VOL_ADJUSTED_SIZING: false,
  VOL_BASELINE: 0,
} as unknown as AppConfig;

describe('RiskManager volatility-adjusted sizing', () => {
  it('returns standard sizing when VOL_ADJUSTED_SIZING is false', () => {
    const risk = new RiskManager(baseConfig);
    const standard = risk.sizePosition(150, 0.01);
    const withVol = risk.sizePosition(150, 0.01, 80);
    expect(standard.quantity).toBe(withVol.quantity);
  });

  it('reduces position when rv exceeds baseline', () => {
    const cfg = { ...baseConfig, VOL_ADJUSTED_SIZING: true, VOL_BASELINE: 50 } as unknown as AppConfig;
    const risk = new RiskManager(cfg);
    const standard = risk.sizePosition(150, 0.01);
    const scaled = risk.sizePosition(150, 0.01, 100);
    expect(scaled.quantity).toBeLessThan(standard.quantity);
    expect(scaled.marginUsdt).toBeLessThan(standard.marginUsdt);
  });

  it('caps reduction at 50% minimum', () => {
    const cfg = { ...baseConfig, VOL_ADJUSTED_SIZING: true, VOL_BASELINE: 50 } as unknown as AppConfig;
    const risk = new RiskManager(cfg);
    const scaled = risk.sizePosition(150, 0.01, 500);
    const standard = risk.sizePosition(150, 0.01);
    expect(scaled.marginUsdt).toBeCloseTo(standard.marginUsdt * 0.5, 1);
  });

  it('does not scale up when rv is below baseline', () => {
    const cfg = { ...baseConfig, VOL_ADJUSTED_SIZING: true, VOL_BASELINE: 50 } as unknown as AppConfig;
    const risk = new RiskManager(cfg);
    const standard = risk.sizePosition(150, 0.01);
    const scaled = risk.sizePosition(150, 0.01, 30);
    expect(scaled.quantity).toBe(standard.quantity);
  });

  it('ignores vol adjustment when realizedVol is undefined', () => {
    const cfg = { ...baseConfig, VOL_ADJUSTED_SIZING: true, VOL_BASELINE: 50 } as unknown as AppConfig;
    const risk = new RiskManager(cfg);
    const standard = risk.sizePosition(150, 0.01);
    const noVol = risk.sizePosition(150, 0.01, undefined);
    expect(standard.quantity).toBe(noVol.quantity);
  });
});

describe('isWithinTradingHours (via orchestrator logic)', () => {
  const parse = (s: string): number => {
    const [h, m] = s.split(':').map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };

  const isWithin = (spec: string, nowMin: number): boolean => {
    if (!spec || !spec.includes('-')) return true;
    const [startStr, endStr] = spec.split('-');
    const start = parse(startStr);
    const end = parse(endStr);
    if (start <= end) return nowMin >= start && nowMin < end;
    return nowMin >= start || nowMin < end;
  };

  it('empty spec always allows', () => {
    expect(isWithin('', 720)).toBe(true);
  });

  it('within normal range', () => {
    expect(isWithin('02:00-21:00', 600)).toBe(true);
    expect(isWithin('02:00-21:00', 120)).toBe(true);
  });

  it('outside normal range', () => {
    expect(isWithin('02:00-21:00', 1320)).toBe(false);
    expect(isWithin('02:00-21:00', 60)).toBe(false);
  });

  it('handles overnight range (start > end)', () => {
    expect(isWithin('21:00-06:00', 1380)).toBe(true);
    expect(isWithin('21:00-06:00', 180)).toBe(true);
    expect(isWithin('21:00-06:00', 720)).toBe(false);
  });
});
