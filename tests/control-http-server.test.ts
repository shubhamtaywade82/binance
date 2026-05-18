import http from 'node:http';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ControlHttpServer } from '../src/control/http-server';
import type { ExecutionRouter } from '../src/execution/execution-router';

interface RouterMock {
  currentConfig: () => { exchange: string; env: string };
  applyConfig: (rc: { exchange: string; env: string }, hasPosition: () => boolean) => { ok: boolean; error?: string };
}

const makeRouter = (): RouterMock => ({
  currentConfig: () => ({ exchange: 'binance', env: 'testnet' }),
  applyConfig: (_rc, _hp) => ({ ok: true }),
});

interface HttpResult {
  status: number;
  body: any;
  headers: http.IncomingHttpHeaders;
}

const httpRequest = (
  port: number,
  method: 'GET' | 'POST',
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<HttpResult> =>
  new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (opts.token !== undefined) headers['Authorization'] = `Bearer ${opts.token}`;
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers,
    }, (res) => {
      let buf = '';
      res.on('data', (c: Buffer | string) => { buf += c; });
      res.on('end', () => {
        let parsed: any = buf;
        try { parsed = JSON.parse(buf); } catch { /* leave raw */ }
        resolve({ status: res.statusCode ?? 0, body: parsed, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(JSON.stringify(opts.body));
    req.end();
  });

let port = 47301;
const nextPort = (): number => port++;

const startServer = async (
  router: RouterMock,
  authToken?: string,
  hasPosition: () => boolean = () => false,
): Promise<{ server: ControlHttpServer; port: number; logs: { msg: string; meta?: any }[] }> => {
  const logs: { msg: string; meta?: any }[] = [];
  const log = {
    info: (msg: string, meta?: any) => logs.push({ msg, meta }),
    warn: (msg: string, meta?: any) => logs.push({ msg, meta }),
  };
  const server = new ControlHttpServer(
    null,
    router as unknown as ExecutionRouter,
    hasPosition,
    { authToken, log },
  );
  const p = nextPort();
  await server.listen(p);
  return { server, port: p, logs };
};

describe('ControlHttpServer auth', () => {
  let server: ControlHttpServer | null = null;
  beforeEach(() => { server = null; });
  afterEach(async () => { if (server) { await server.stop(); server = null; } });

  it('rejects requests with no Authorization header when a token is configured', async () => {
    const router = makeRouter();
    const ctx = await startServer(router, 'super-secret-token-1234567890');
    server = ctx.server;
    const r = await httpRequest(ctx.port, 'GET', '/runtime/config');
    expect(r.status).toBe(401);
    expect(r.body.ok).toBe(false);
    expect(r.headers['www-authenticate']).toMatch(/Bearer/);
  });

  it('rejects requests with a wrong token', async () => {
    const router = makeRouter();
    const ctx = await startServer(router, 'super-secret-token-1234567890');
    server = ctx.server;
    const r = await httpRequest(ctx.port, 'POST', '/runtime/kill', { token: 'WRONG' });
    expect(r.status).toBe(401);
  });

  it('rejects requests where Authorization is not a Bearer scheme', async () => {
    const router = makeRouter();
    const ctx = await startServer(router, 'super-secret-token-1234567890');
    server = ctx.server;
    const got = await new Promise<HttpResult>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: ctx.port, method: 'GET', path: '/runtime/config',
        headers: { Authorization: 'Basic dXNlcjpwYXNz' },
      }, (res) => {
        let buf = '';
        res.on('data', (c: Buffer | string) => { buf += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(buf), headers: res.headers }));
      });
      req.on('error', reject);
      req.end();
    });
    expect(got.status).toBe(401);
  });

  it('accepts requests with the correct bearer token', async () => {
    const router = makeRouter();
    const TOKEN = 'super-secret-token-1234567890';
    const ctx = await startServer(router, TOKEN);
    server = ctx.server;
    const r = await httpRequest(ctx.port, 'GET', '/runtime/config', { token: TOKEN });
    expect(r.status).toBe(200);
    expect(r.body.config).toEqual({ exchange: 'binance', env: 'testnet' });
  });

  it('protects POST /runtime/config from unauthorized callers', async () => {
    const router = makeRouter();
    const applySpy = vi.spyOn(router, 'applyConfig');
    const TOKEN = 'super-secret-token-1234567890';
    const ctx = await startServer(router, TOKEN);
    server = ctx.server;
    const wrong = await httpRequest(ctx.port, 'POST', '/runtime/config', {
      body: { exchange: 'coindcx', env: 'mainnet' },
    });
    expect(wrong.status).toBe(401);
    expect(applySpy).not.toHaveBeenCalled();

    const right = await httpRequest(ctx.port, 'POST', '/runtime/config', {
      token: TOKEN,
      body: { exchange: 'coindcx', env: 'mainnet' },
    });
    expect(right.status).toBe(200);
    expect(applySpy).toHaveBeenCalledOnce();
  });

  it('allows every request when no auth token is configured but logs a warning on listen', async () => {
    const router = makeRouter();
    const ctx = await startServer(router, undefined);
    server = ctx.server;
    const r = await httpRequest(ctx.port, 'GET', '/runtime/config');
    expect(r.status).toBe(200);
    expect(ctx.logs.some((l) => l.msg === 'control_http_unauthenticated')).toBe(true);
  });

  it('logs an unauthorized event for each rejected request', async () => {
    const router = makeRouter();
    const TOKEN = 'super-secret-token-1234567890';
    const ctx = await startServer(router, TOKEN);
    server = ctx.server;
    await httpRequest(ctx.port, 'POST', '/runtime/kill');
    expect(ctx.logs.some((l) => l.msg === 'control_http_unauthorized')).toBe(true);
  });
});
