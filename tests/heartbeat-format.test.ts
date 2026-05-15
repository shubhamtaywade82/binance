import { describe, expect, it } from 'vitest';
import { formatStatusLine, riskTierFor } from '../src/orchestrator/format-status-line';

describe('formatStatusLine', () => {
  it('renders an all-positive baseline (SAFE)', () => {
    const line = formatStatusLine({
      equityUsdt: 10000,
      balanceUsdt: 9500,
      unrealizedPnlUsdt: 500,
      realizedPnlUsdt: 250,
      drawdownPct: 0,
      inrPerUsdt: 85,
    });
    expect(line).toContain('EQ: ₹8,50,000.00 (10000.00 USDT)');
    expect(line).toContain('WAL: ₹8,07,500.00 (9500.00 USDT)');
    expect(line).toContain('UR: ₹42,500.00 (500.00 USDT)');
    expect(line).toContain('NET: ₹21,250.00');
    expect(line).toContain('UNREAL USDT: 500.00');
    expect(line).toContain('DD: 0.00%');
    expect(line).toContain('RISK: SAFE');
  });

  it('renders signed negatives for INR + USDT', () => {
    const line = formatStatusLine({
      equityUsdt: 9400,
      balanceUsdt: 9500,
      unrealizedPnlUsdt: -100,
      realizedPnlUsdt: -50,
      drawdownPct: -3.5,
      inrPerUsdt: 85,
    });
    expect(line).toContain('UR: -₹8,500.00 (-100.00 USDT)');
    expect(line).toContain('NET: -₹4,250.00');
    expect(line).toContain('UNREAL USDT: -100.00');
    expect(line).toContain('DD: -3.50%');
    expect(line).toContain('RISK: WARN');
  });

  it('returns CRIT tier below -5%', () => {
    const line = formatStatusLine({
      equityUsdt: 9000,
      balanceUsdt: 9000,
      unrealizedPnlUsdt: 0,
      realizedPnlUsdt: -1000,
      drawdownPct: -10,
      inrPerUsdt: 85,
    });
    expect(line).toContain('DD: -10.00%');
    expect(line).toContain('RISK: CRIT');
  });

  it('riskTierFor boundary conditions', () => {
    expect(riskTierFor(0)).toBe('SAFE');
    expect(riskTierFor(-2)).toBe('SAFE');
    expect(riskTierFor(-2.01)).toBe('WARN');
    expect(riskTierFor(-5)).toBe('WARN');
    expect(riskTierFor(-5.01)).toBe('CRIT');
  });

  it('uses pipe separator structure', () => {
    const line = formatStatusLine({
      equityUsdt: 100, balanceUsdt: 100, unrealizedPnlUsdt: 0,
      realizedPnlUsdt: 0, drawdownPct: 0, inrPerUsdt: 85,
    });
    const parts = line.split('│');
    expect(parts).toHaveLength(7);
  });
});
