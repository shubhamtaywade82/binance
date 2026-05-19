import http from 'http';
import { URL } from 'url';
import { WebSocketServer } from 'ws';
import { RedisBridge } from './redis-bridge';
import { ClientSession } from './ws-router';
import { federatedListSymbols, federatedSearchSymbols } from './search';

const PORT = Number(process.env.PORT ?? 4100);
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const ORIGIN = process.env.GATEWAY_CORS_ORIGIN ?? '*';

const main = async (): Promise<void> => {
  const bridge = new RedisBridge(REDIS_URL);
  await bridge.start();

  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, providers: bridge.snapshotPresence() }));
      return;
    }

    if (url.pathname === '/providers') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(bridge.snapshotPresence()));
      return;
    }

    if (url.pathname === '/symbols/search') {
      const q = url.searchParams.get('q') ?? '';
      const limit = Number(url.searchParams.get('limit') ?? 20);
      federatedSearchSymbols(bridge, q, limit).then((results) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(results));
      }).catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      });
      return;
    }

    if (url.pathname.startsWith('/symbols/list/')) {
      const provider = url.pathname.slice('/symbols/list/'.length);
      const segment = url.searchParams.get('segment') ?? undefined;
      federatedListSymbols(bridge, provider, segment ? { segment } : undefined).then((results) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(results));
      }).catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      });
      return;
    }

    res.writeHead(404).end('not found');
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (socket) => {
    new ClientSession(socket, bridge);
  });

  server.listen(PORT, () => {
    console.log(`[gateway] listening on :${PORT} (redis=${REDIS_URL})`);
  });

  const shutdown = async (): Promise<void> => {
    console.log('[gateway] shutting down');
    wss.close();
    server.close();
    await bridge.stop();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
};

main().catch((err) => {
  console.error('[gateway] fatal', err);
  process.exit(1);
});
