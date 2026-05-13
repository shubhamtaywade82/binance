/**
 * WebSocket Gateway — Redis pub/sub → browser clients.
 *
 * Run standalone:  ts-node gateway/ws-server.ts
 * Docker service:  see docker-compose.yml
 *
 * Subscribes to all bot event channels and fans out JSON frames to every
 * connected browser. Each message includes { channel, data, ts }.
 */
import WebSocket, { WebSocketServer } from 'ws';
import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const PORT      = Number(process.env.GATEWAY_PORT ?? 4000);

const CHANNELS = ['ticks', 'signals', 'positions', 'orders'] as const;

const sub = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
sub.on('error', (err) => process.stderr.write(`redis_sub_error ${err.message}\n`));

const wss = new WebSocketServer({ port: PORT });

wss.on('listening', () => {
  process.stdout.write(`ws_gateway_ready port=${PORT}\n`);
});

wss.on('connection', (client, req) => {
  const ip = req.socket.remoteAddress ?? 'unknown';
  process.stdout.write(`ws_client_connected ip=${ip} total=${wss.clients.size}\n`);

  client.on('close', () => {
    process.stdout.write(`ws_client_disconnected total=${wss.clients.size}\n`);
  });
});

// Single message handler fans out to all connected clients.
sub.on('message', (channel: string, message: string) => {
  if (wss.clients.size === 0) return;
  let data: unknown;
  try { data = JSON.parse(message); } catch { data = message; }
  const frame = JSON.stringify({ channel, data });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(frame);
  });
});

sub.subscribe(...CHANNELS).then(() => {
  process.stdout.write(`ws_gateway_subscribed channels=${CHANNELS.join(',')}\n`);
}).catch((err: Error) => {
  process.stderr.write(`ws_gateway_subscribe_failed ${err.message}\n`);
  process.exit(1);
});

// Graceful shutdown
const shutdown = () => {
  sub.quit().catch(() => undefined);
  wss.close(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);
