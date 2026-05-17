import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type Redis from 'ioredis';
import type { ExecutionRouter } from '../execution/execution-router';
import { getRuntimeConfig, setRuntimeConfig, CHANGE_CHANNEL, type RuntimeConfig } from '../services/runtime-config';

export interface ControlHttpLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

const noopLog: ControlHttpLogger = {
  info: () => undefined,
  warn: () => undefined,
};

export interface ControlHttpOptions {
  /** Shared-secret bearer token. When set, every request must present
   *  `Authorization: Bearer <token>`. When undefined, the server runs
   *  unauthenticated and logs a warning on every request. */
  authToken?: string;
  log?: ControlHttpLogger;
}

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

const remoteIp = (req: http.IncomingMessage): string =>
  (req.socket?.remoteAddress as string | undefined) ?? 'unknown';

/**
 * Constant-time comparison between two strings interpreted as raw bytes.
 * Falls back to false on length mismatch (timingSafeEqual throws otherwise).
 */
const safeStringEqual = (a: string, b: string): boolean => {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
};

/**
 * Minimal HTTP control plane for runtime environment/exchange switching.
 *
 * Routes (all bind to 127.0.0.1):
 *   GET  /runtime/config   → current adapter config (exchange + env)
 *   POST /runtime/config   → hot-swap adapter; body: { exchange, env }
 *   GET  /runtime/status   → config + position state + kill-switch value
 *   POST /runtime/kill     → set state:kill_switch=1 in Redis
 *   POST /runtime/unkill   → set state:kill_switch=0 in Redis
 *
 * Authentication: when `authToken` is provided, every request must include
 * `Authorization: Bearer <token>`. Comparison is constant-time. Without a
 * token the server runs open and logs a warning on every request — production
 * setups (live mode) MUST configure CONTROL_AUTH_TOKEN.
 */
export class ControlHttpServer {
  private readonly server: http.Server;
  private redisSub: Redis | null = null;
  private readonly authToken: string | undefined;
  private readonly log: ControlHttpLogger;

  constructor(
    private readonly redis: Redis | null,
    private readonly router: ExecutionRouter,
    private readonly hasPosition: () => boolean,
    opts: ControlHttpOptions = {},
  ) {
    this.authToken = opts.authToken;
    this.log = opts.log ?? noopLog;
    this.server = http.createServer((req, res) => {
      this.dispatch(req, res).catch((err: Error) => {
        sendJson(res, 500, { ok: false, error: err.message });
      });
    });
  }

  listen(port: number): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(port, '127.0.0.1', () => {
        if (!this.authToken) {
          this.log.warn('control_http_unauthenticated', {
            hint:
              'CONTROL_AUTH_TOKEN is not set. The control HTTP server is reachable by ' +
              'anything on localhost (sidecars, port-forwards, shared accounts). Set ' +
              'CONTROL_AUTH_TOKEN to a long random string in live deployments.',
          });
        }
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

  /**
   * Returns true when the request carries a valid bearer token, false otherwise.
   * When no auth token is configured, every request is allowed (caller has already
   * logged a warning at listen-time).
   */
  private isAuthorized(req: http.IncomingMessage): boolean {
    if (!this.authToken) return true;
    const header = req.headers['authorization'];
    if (typeof header !== 'string') return false;
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!m) return false;
    return safeStringEqual(m[1], this.authToken);
  }

  private async dispatch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url ?? '/';
    const method = req.method?.toUpperCase() ?? 'GET';
    const ip = remoteIp(req);

    if (!this.isAuthorized(req)) {
      this.log.warn('control_http_unauthorized', { method, url, ip });
      res.setHeader('WWW-Authenticate', 'Bearer realm="control"');
      sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }

    this.log.info('control_http_request', { method, url, ip });

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
