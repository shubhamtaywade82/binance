import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { createScriptsApi } from '../../src/dashboard/scripts-api';

const startServer = (api: ReturnType<typeof createScriptsApi>) =>
  new Promise<{ server: http.Server; baseUrl: string }>((resolve) => {
    const server = http.createServer(async (req, res) => {
      const handled = await api.handle(req, res);
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

const sampleScript = (id: string, name = 'Test') => ({
  id,
  name,
  source: 'indicator("t")\nplot(close)',
  inputs: {},
  enabled: false,
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
});

describe('scripts-api REST handler', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'nanopine-'));
    filePath = path.join(tmpDir, 'scripts.json');
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /api/scripts returns the empty list when no file exists', async () => {
    const api = createScriptsApi({ filePath });
    const { server, baseUrl } = await startServer(api);
    try {
      const r = await fetch(`${baseUrl}/api/scripts`);
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body).toEqual({ scripts: [] });
    } finally {
      await stop(server);
    }
  });

  it('POST creates, GET reads back, PUT replaces, DELETE removes', async () => {
    const api = createScriptsApi({ filePath });
    const { server, baseUrl } = await startServer(api);
    try {
      const created = await fetch(`${baseUrl}/api/scripts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sampleScript('s_alpha', 'Alpha')),
      });
      expect(created.status).toBe(201);

      const listAfterPost = await fetch(`${baseUrl}/api/scripts`).then((r) => r.json());
      expect(listAfterPost.scripts.map((s: any) => s.id)).toEqual(['s_alpha']);

      // Replace via PUT /api/scripts/:id
      const put = await fetch(`${baseUrl}/api/scripts/s_alpha`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...sampleScript('s_alpha', 'Alpha v2'), source: 'indicator("alpha2")' }),
      });
      expect(put.status).toBe(200);
      const putBody = await put.json();
      expect(putBody.name).toBe('Alpha v2');
      expect(putBody.source).toContain('alpha2');

      // PUT /api/scripts (whole-array replace).
      const bulk = await fetch(`${baseUrl}/api/scripts`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([sampleScript('s_beta', 'Beta')]),
      });
      expect(bulk.status).toBe(200);
      const bulkBody = await bulk.json();
      expect(bulkBody.scripts.map((s: any) => s.id)).toEqual(['s_beta']);

      // File on disk reflects the latest write.
      const onDisk = JSON.parse(readFileSync(filePath, 'utf8'));
      expect(onDisk.map((s: any) => s.id)).toEqual(['s_beta']);

      // DELETE
      const del = await fetch(`${baseUrl}/api/scripts/s_beta`, { method: 'DELETE' });
      expect(del.status).toBe(204);
      const listAfterDel = await fetch(`${baseUrl}/api/scripts`).then((r) => r.json());
      expect(listAfterDel.scripts).toEqual([]);
    } finally {
      await stop(server);
    }
  });

  it('rejects payload over the size limit', async () => {
    const api = createScriptsApi({ filePath });
    const { server, baseUrl } = await startServer(api);
    try {
      const tooBig = 'x'.repeat(300 * 1024);
      const r = await fetch(`${baseUrl}/api/scripts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...sampleScript('s_huge'), source: tooBig }),
      });
      expect(r.status).toBe(400);
    } finally {
      await stop(server);
    }
  });

  it('does not match other URLs (404 for /unknown)', async () => {
    const api = createScriptsApi({ filePath });
    const { server, baseUrl } = await startServer(api);
    try {
      const r = await fetch(`${baseUrl}/unknown`);
      expect(r.status).toBe(404);
    } finally {
      await stop(server);
    }
  });
});
