import http from 'node:http';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { ControlHttpServer, type HealthReport } from '../src/control/http-server';
import type { ExecutionRouter } from '../src/execution/execution-router';

let port = 49100;
const nextPort = () => port++;

const router = {
  currentConfig: () => ({ exchange: 'binance', env: 'testnet' }),
  applyConfig: () => ({ ok: true }),
} as unknown as ExecutionRouter;

const httpRequest = (p: number, path: string, opts: { token?: string } = {}): Promise<{ status: number; body: any }> =>
  new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.token !== undefined) headers.Authorization = `Bearer ${opts.token}`;
    const req = http.request({ host: '127.0.0.1', port: p, method: 'GET', path, headers }, (res) => {
      let buf = '';
      res.on('data', (c: Buffer | string) => { buf += c; });
      res.on('end', () => {
        let parsed: any = buf;
        try { parsed = JSON.parse(buf); } catch { /* leave raw */ }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on('error', reject);
    req.end();
  });

let server: ControlHttpServer | null = null;
const start = async (healthProbe?: () => HealthReport, authToken?: string) => {
  const p = nextPort();
  server = new ControlHttpServer(null, router, () => false, { authToken, healthProbe });
  await server.listen(p);
  return p;
};

beforeEach(() => { server = null; });
afterEach(async () => { if (server) { await server.stop(); server = null; } });

describe('ControlHttpServer /health endpoint (M-13)', () => {
  it('returns 200 + {ok:true} without a probe configured', async () => {
    const p = await start(undefined);
    const r = await httpRequest(p, '/health');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });

  it('returns 200 when the probe reports ok=true', async () => {
    const p = await start(() => ({ ok: true, reasons: [], details: { uptimeSec: 10 } }));
    const r = await httpRequest(p, '/health');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it('returns 503 when the probe reports ok=false', async () => {
    const p = await start(() => ({ ok: false, reasons: ['no_market_data'], details: { klineAgeMs: 999999 } }));
    const r = await httpRequest(p, '/health');
    expect(r.status).toBe(503);
    expect(r.body.ok).toBe(false);
  });

  it('hides the structured report from unauthenticated callers (returns only {ok})', async () => {
    const p = await start(
      () => ({ ok: true, reasons: [], details: { secret: 'should-not-leak' } }),
      'super-secret-token-1234567890',
    );
    const r = await httpRequest(p, '/health');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(JSON.stringify(r.body)).not.toContain('secret');
  });

  it('returns the full report when authenticated', async () => {
    const TOKEN = 'super-secret-token-1234567890';
    const p = await start(
      () => ({ ok: true, reasons: [], details: { klineAgeMs: 100 } }),
      TOKEN,
    );
    const r = await httpRequest(p, '/health', { token: TOKEN });
    expect(r.status).toBe(200);
    expect(r.body.details.klineAgeMs).toBe(100);
  });

  it('does NOT require auth even when token is configured (container probes)', async () => {
    const p = await start(
      () => ({ ok: true, reasons: [], details: {} }),
      'super-secret-token-1234567890',
    );
    const r = await httpRequest(p, '/health'); // no token
    expect(r.status).toBe(200);
  });

  it('treats a probe throw as unhealthy (503)', async () => {
    const p = await start(() => { throw new Error('boom'); });
    const r = await httpRequest(p, '/health');
    expect(r.status).toBe(503);
    expect(r.body.ok).toBe(false);
  });
});
