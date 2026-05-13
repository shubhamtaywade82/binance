import { describe, expect, it, vi } from 'vitest';
import type { AccountConfigUpdate, TradeLiteEvent, PrivateWsCallbacks } from '../src/binance/private-ws';
import { buildStreamList, type MultiplexOptions } from '../src/binance/ws-multiplex';

describe('ACCOUNT_CONFIG_UPDATE and TRADE_LITE private event types', () => {
  it('AccountConfigUpdate has leverage change shape', () => {
    const event: AccountConfigUpdate = {
      e: 'ACCOUNT_CONFIG_UPDATE',
      E: Date.now(),
      T: Date.now(),
      ac: { s: 'SOLUSDT', l: 20 },
    };
    expect(event.ac?.s).toBe('SOLUSDT');
    expect(event.ac?.l).toBe(20);
  });

  it('AccountConfigUpdate has multi-assets margin shape', () => {
    const event: AccountConfigUpdate = {
      e: 'ACCOUNT_CONFIG_UPDATE',
      E: Date.now(),
      T: Date.now(),
      ai: { j: true },
    };
    expect(event.ai?.j).toBe(true);
  });

  it('TradeLiteEvent has expected fields', () => {
    const event: TradeLiteEvent = {
      e: 'TRADE_LITE',
      E: Date.now(),
      T: Date.now(),
      s: 'SOLUSDT',
      q: '10',
      p: '150.5',
      m: false,
      L: '150.5',
    };
    expect(event.s).toBe('SOLUSDT');
    expect(event.q).toBe('10');
    expect(event.m).toBe(false);
  });

  it('PrivateWsCallbacks includes new event handlers', () => {
    const callbacks: PrivateWsCallbacks = {
      onAccountConfigUpdate: vi.fn(),
      onTradeLite: vi.fn(),
    };
    expect(callbacks.onAccountConfigUpdate).toBeDefined();
    expect(callbacks.onTradeLite).toBeDefined();
  });
});

describe('markPrice stream includes fundingRate', () => {
  it('buildStreamList includes markPrice when configured', () => {
    const opts: MultiplexOptions = {
      symbols: ['SOLUSDT'],
      timeframes: ['15m'],
      product: 'usdm',
      useMarkPrice: true,
    };
    const streams = buildStreamList(opts);
    expect(streams.some(s => s.includes('markPrice'))).toBe(true);
  });
});
