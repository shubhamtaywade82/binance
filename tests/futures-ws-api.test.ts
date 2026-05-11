import { EventEmitter } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  BinanceFuturesWsApiClient,
  FuturesWsApiError,
} from '../src/binance/futures-ws-api';
import { loadEd25519PrivateKeyFromPem } from '../src/binance/futures-ws-sign';

class FakeWs extends EventEmitter {
  readyState = WebSocket.CONNECTING;
  sent: string[] = [];

  constructor(public readonly url: string) {
    super();
    queueMicrotask(() => {
      this.readyState = WebSocket.OPEN;
      this.emit('open');
    });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = WebSocket.CLOSING;
    this.emit('close', 1000, Buffer.from(''));
  }
}

describe('BinanceFuturesWsApiClient', () => {
  it('logon sends session.logon with signature and resolves 200', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const key = loadEd25519PrivateKeyFromPem(pem);

    const sockets: FakeWs[] = [];
    const wsFactory = (url: string) => {
      const s = new FakeWs(url);
      sockets.push(s);
      return s as unknown as WebSocket;
    };

    const client = new BinanceFuturesWsApiClient({
      url: 'wss://ws-fapi.binance.com/ws-fapi/v1',
      apiKey: 'testApiKey',
      privateKey: key,
      wsFactory,
      requestTimeoutMs: 5000,
    });

    await client.connect();
    const sock = sockets[0]!;
    expect(sock.url).toContain('ws-fapi');

    const logonPromise = client.logon();
    expect(sock.sent.length).toBe(1);

    const out = JSON.parse(sock.sent[0]!) as {
      id: string;
      method: string;
      params: Record<string, unknown>;
    };
    expect(out.method).toBe('session.logon');
    expect(out.params.apiKey).toBe('testApiKey');
    expect(typeof out.params.signature).toBe('string');

    sock.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          id: out.id,
          status: 200,
          result: { serverTime: 1234567890 },
        }),
      ),
    );

    const res = await logonPromise;
    expect(res.status).toBe(200);
    expect(client.isSessionAuthenticated).toBe(true);

    await client.disconnect();
  });

  it('rejects with FuturesWsApiError on non-200 status', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

    const sockets: FakeWs[] = [];
    const wsFactory = (url: string) => {
      const s = new FakeWs(url);
      sockets.push(s);
      return s as unknown as WebSocket;
    };

    const client = new BinanceFuturesWsApiClient({
      url: 'wss://ws-fapi.binance.com/ws-fapi/v1',
      apiKey: 'k',
      privateKey: loadEd25519PrivateKeyFromPem(pem),
      wsFactory,
      requestTimeoutMs: 2000,
    });

    await client.connect();
    const sock = sockets[0]!;
    const p = client.sessionStatus();
    const out = JSON.parse(sock.sent[0]!) as { id: string };

    sock.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          id: out.id,
          status: 400,
          error: { code: -1102, msg: 'Bad param' },
        }),
      ),
    );

    await expect(p).rejects.toThrow(FuturesWsApiError);
    await client.disconnect();
  });
});
