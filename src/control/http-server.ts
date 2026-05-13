import http from 'node:http';
import type Redis from 'ioredis';
import type { ExecutionRouter } from '../execution/execution-router';
import { getRuntimeConfig, setRuntimeConfig, CHANGE_CHANNEL, type RuntimeConfig } from '../services/runtime-config';

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer | string) => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/**
 * Minimal HTTP control plane for runtime environment/exchange switching.
 *
 * Routes (all bind to 127.0.0.1):
 *   GET  /runtime/config   → current adapter config (exchange + env)
 *   POST /runtime/config   → hot-swap adapter; body: { exchange, env }
 *   GET  /runtime/status   → config + position state + kill-switch value
 *   POST /runtime/kill     → set state:kill_switch=1 in Redis
 *   POST /runtime/unkill   → set state:kill_switch=0 in Redis
 */
export class ControlHttpServer {
  private readonly server: http.Server;
  private redisSub: Redis | null = null;

  constructor(
    private readonly redis: Redis | null,
    private readonly router: ExecutionRouter,
    private readonly hasPosition: () => boolean,
  ) {
    this.server = http.createServer((req, res) => {
      this.dispatch(req, res).catch((err: Error) => {
        sendJson(res, 500, { ok: false, error: err.message });
      });
    });
  }

  listen(port: number): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(port, '127.0.0.1', () => {
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.redisSub) {
        this.redisSub.disconnect();
        this.redisSub = null;
      }
      this.server.close(() => resolve());
    });
  }

  /**
   * Subscribe to Redis runtime:config:changed so that external tools (e.g. redis-cli,
   * another bot instance, a deploy script) can trigger an adapter swap without hitting
   * the HTTP API.  Uses a separate ioredis connection — pub/sub requires its own socket.
   */
  watchRedisConfigChanges(subClient: Redis): void {
    this.redisSub = subClient;
    subClient.subscribe(CHANGE_CHANNEL).catch(() => undefined);
    subClient.on('message', (_channel: string, message: string) => {
      try {
        const rc = JSON.parse(message) as RuntimeConfig;
        const result = this.router.applyConfig(rc, this.hasPosition);
        if (!result.ok) {
          process.stderr.write(`control_switch_rejected ${result.error}\n`);
        }
      } catch {
        // ignore malformed pub/sub messages
      }
    });
  }

  private async dispatch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url ?? '/';
    const method = req.method?.toUpperCase() ?? 'GET';

    // GET /runtime/config
    if (method === 'GET' && url === '/runtime/config') {
      sendJson(res, 200, { ok: true, config: this.router.currentConfig() });
      return;
    }

    // POST /runtime/config — hot-swap adapter
    if (method === 'POST' && url === '/runtime/config') {
      const body = await readBody(req);
      let rc: RuntimeConfig;
      try {
        rc = JSON.parse(body) as RuntimeConfig;
        if (!['binance', 'coindcx'].includes(rc.exchange)) {
          throw new Error('exchange must be "binance" or "coindcx".');
        }
        if (!['testnet', 'mainnet'].includes(rc.env)) {
          throw new Error('env must be "testnet" or "mainnet".');
        }
      } catch (err) {
        sendJson(res, 400, { ok: false, error: (err as Error).message });
        return;
      }

      let result: ReturnType<ExecutionRouter['applyConfig']>;
      try {
        result = this.router.applyConfig(rc, this.hasPosition);
      } catch (err) {
        sendJson(res, 500, { ok: false, error: (err as Error).message });
        return;
      }

      if (result.ok) {
        // Persist the new config so other subscribers (and restarts) see it.
        await setRuntimeConfig(this.redis, rc).catch(() => undefined);
      }
      sendJson(res, result.ok ? 200 : 409, result);
      return;
    }

    // GET /runtime/status
    if (method === 'GET' && url === '/runtime/status') {
      const active = this.router.currentConfig();
      const stored = await getRuntimeConfig(this.redis, active);
      let killSwitch: boolean | null = null;
      if (this.redis) {
        const val = await this.redis.get('state:kill_switch').catch(() => null);
        killSwitch = val === '1';
      }
      sendJson(res, 200, {
        ok: true,
        active,
        stored,
        hasPosition: this.hasPosition(),
        killSwitch,
      });
      return;
    }

    // POST /runtime/kill
    if (method === 'POST' && url === '/runtime/kill') {
      if (this.redis) {
        await this.redis.set('state:kill_switch', '1');
      }
      sendJson(res, 200, { ok: true, killSwitch: true });
      return;
    }

    // POST /runtime/unkill
    if (method === 'POST' && url === '/runtime/unkill') {
      if (this.redis) {
        await this.redis.set('state:kill_switch', '0');
      }
      sendJson(res, 200, { ok: true, killSwitch: false });
      return;
    }

    sendJson(res, 404, { ok: false, error: 'Not found.' });
  }
}
