import { describe, expect, it } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';
import { createScriptsAi } from '../../src/dashboard/scripts-ai';

const startServer = (
  ai: ReturnType<typeof createScriptsAi>,
): Promise<{ server: http.Server; baseUrl: string }> =>
  new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const handled = await ai.handle(req, res);
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });

const stop = (server: http.Server) =>
  new Promise<void>((resolve) => server.close(() => resolve()));

const cfgWith = (model: string): any => ({
  OLLAMA_MODEL: model,
  OLLAMA_TARGET: 'local',
  OLLAMA_API_KEY: '',
});

describe('scripts-ai endpoint', () => {
  it('disables itself when OLLAMA_MODEL is empty', async () => {
    const ai = createScriptsAi({ cfg: cfgWith('') });
    expect(ai.enabled).toBe(false);
    const { server, baseUrl } = await startServer(ai);
    try {
      const r = await fetch(`${baseUrl}/api/scripts/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'whatever' }),
      });
      expect(r.status).toBe(503);
      const body = await r.json();
      expect(body.error).toMatch(/OLLAMA_MODEL/);
    } finally {
      await stop(server);
    }
  });

  it('rejects non-POST and missing prompt with 4xx', async () => {
    const ai = createScriptsAi({ cfg: cfgWith('llama3.2') });
    expect(ai.enabled).toBe(true);
    const { server, baseUrl } = await startServer(ai);
    try {
      const get = await fetch(`${baseUrl}/api/scripts/generate`);
      expect(get.status).toBe(405);
      const empty = await fetch(`${baseUrl}/api/scripts/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(empty.status).toBe(400);
    } finally {
      await stop(server);
    }
  });

  it('does not match unrelated URLs', async () => {
    const ai = createScriptsAi({ cfg: cfgWith('llama3.2') });
    const { server, baseUrl } = await startServer(ai);
    try {
      const r = await fetch(`${baseUrl}/api/something/else`);
      expect(r.status).toBe(404);
    } finally {
      await stop(server);
    }
  });
});
