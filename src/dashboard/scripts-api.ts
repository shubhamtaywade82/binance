/**
 * NanoPine scripts CRUD API. Mounted by {@link createDashboardBridge}'s HTTP handler;
 * persists scripts to a JSON file (path injected by the caller).
 *
 *   GET    /api/scripts           → 200 { scripts: ScriptRecord[] }
 *   POST   /api/scripts           → 201 ScriptRecord (id assigned server-side if missing)
 *   PUT    /api/scripts/:id       → 200 ScriptRecord
 *   DELETE /api/scripts/:id       → 204
 *
 * No auth — assumes the dashboard is bound to localhost or a trusted reverse proxy.
 */
import { promises as fsAsync, existsSync, readFileSync } from 'fs';
import path from 'path';
import type http from 'http';

export interface ScriptRecord {
  id: string;
  name: string;
  source: string;
  inputs: Record<string, unknown>;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ScriptsApiOptions {
  filePath: string;
  log?: { info?: (msg: string, ctx?: unknown) => void; warn?: (msg: string, ctx?: unknown) => void };
}

export interface ScriptsApi {
  handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean>;
  /** Test hook — read the current in-memory cache. */
  list(): ScriptRecord[];
}

const MAX_BODY_BYTES = 256 * 1024; // 256 KB per request — scripts shouldn't be larger.

export function createScriptsApi(opts: ScriptsApiOptions): ScriptsApi {
  const filePath = path.resolve(opts.filePath);
  let cache: ScriptRecord[] = [];

  // Synchronous boot read so the first GET doesn't see an empty list during a slow disk.
  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) cache = parsed.filter(isValidRecord);
    } catch (e) {
      opts.log?.warn?.('nanopine_scripts_read_failed', { filePath, err: (e as Error).message });
    }
  }

  const persist = async (): Promise<void> => {
    const tmp = `${filePath}.tmp`;
    const json = JSON.stringify(cache, null, 2);
    await fsAsync.mkdir(path.dirname(filePath), { recursive: true });
    await fsAsync.writeFile(tmp, json, 'utf8');
    await fsAsync.rename(tmp, filePath);
  };

  const sendJson = (
    res: http.ServerResponse,
    statusCode: number,
    body: unknown,
  ): void => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const sendError = (res: http.ServerResponse, statusCode: number, message: string): void => {
    sendJson(res, statusCode, { error: message });
  };

  const readBody = (req: http.IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      let total = 0;
      let aborted = false;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        if (aborted) return;
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
          aborted = true;
          // Keep draining to let the client finish before we respond — avoids the
          // common "fetch failed" with ECONNRESET on the client side.
        } else {
          chunks.push(chunk);
        }
      });
      req.on('end', () => {
        if (aborted) reject(new Error('payload too large'));
        else resolve(Buffer.concat(chunks).toString('utf8'));
      });
      req.on('error', reject);
    });

  return {
    list: () => cache.slice(),
    handle: async (req, res) => {
      const url = req.url ?? '';
      if (!url.startsWith('/api/scripts')) return false;
      const method = (req.method ?? 'GET').toUpperCase();

      // GET /api/scripts
      if (method === 'GET' && (url === '/api/scripts' || url === '/api/scripts/')) {
        sendJson(res, 200, { scripts: cache });
        return true;
      }

      // POST /api/scripts — upsert (create with assigned id, or replace existing by id).
      if (method === 'POST' && (url === '/api/scripts' || url === '/api/scripts/')) {
        try {
          const body = await readBody(req);
          const parsed = body ? JSON.parse(body) : null;
          const sc = coerceRecord(parsed);
          if (!sc) {
            sendError(res, 400, 'Invalid script record');
            return true;
          }
          const idx = cache.findIndex((s) => s.id === sc.id);
          if (idx >= 0) cache[idx] = sc;
          else cache.push(sc);
          await persist();
          sendJson(res, idx >= 0 ? 200 : 201, sc);
        } catch (e) {
          sendError(res, 400, (e as Error).message);
        }
        return true;
      }

      // PUT /api/scripts — replace the entire array atomically. Useful for
      // syncing the whole local store back to the server in one request.
      if (method === 'PUT' && (url === '/api/scripts' || url === '/api/scripts/')) {
        try {
          const body = await readBody(req);
          const parsed = body ? JSON.parse(body) : null;
          if (!Array.isArray(parsed)) {
            sendError(res, 400, 'Expected an array of scripts');
            return true;
          }
          const next: ScriptRecord[] = [];
          for (const raw of parsed) {
            const sc = coerceRecord(raw);
            if (sc) next.push(sc);
          }
          cache = next;
          await persist();
          sendJson(res, 200, { scripts: cache });
        } catch (e) {
          sendError(res, 400, (e as Error).message);
        }
        return true;
      }

      // PUT /api/scripts/:id
      // DELETE /api/scripts/:id
      const matchId = url.match(/^\/api\/scripts\/([^/?#]+)\/?$/);
      if (matchId) {
        const id = decodeURIComponent(matchId[1]);
        if (method === 'PUT') {
          try {
            const body = await readBody(req);
            const parsed = body ? JSON.parse(body) : null;
            const sc = coerceRecord(parsed);
            if (!sc) {
              sendError(res, 400, 'Invalid script record');
              return true;
            }
            sc.id = id;
            const idx = cache.findIndex((s) => s.id === id);
            if (idx >= 0) cache[idx] = sc;
            else cache.push(sc);
            await persist();
            sendJson(res, 200, sc);
          } catch (e) {
            sendError(res, 400, (e as Error).message);
          }
          return true;
        }
        if (method === 'DELETE') {
          const idx = cache.findIndex((s) => s.id === id);
          if (idx >= 0) {
            cache.splice(idx, 1);
            try {
              await persist();
            } catch (e) {
              sendError(res, 500, (e as Error).message);
              return true;
            }
          }
          res.writeHead(204);
          res.end();
          return true;
        }
      }

      sendError(res, 405, `Method ${method} not allowed on ${url}`);
      return true;
    },
  };
}

function coerceRecord(raw: unknown): ScriptRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const now = Date.now();
  const id = typeof r.id === 'string' && r.id ? r.id : `s_${Math.random().toString(36).slice(2, 10)}_${now.toString(36)}`;
  const name = typeof r.name === 'string' && r.name ? r.name : 'Untitled';
  const source = typeof r.source === 'string' ? r.source : '';
  const inputs = r.inputs && typeof r.inputs === 'object' && !Array.isArray(r.inputs)
    ? (r.inputs as Record<string, unknown>)
    : {};
  const enabled = r.enabled === true;
  const createdAt = typeof r.createdAt === 'number' ? r.createdAt : now;
  const updatedAt = typeof r.updatedAt === 'number' ? r.updatedAt : now;
  if (source.length > MAX_BODY_BYTES) return null;
  return { id, name, source, inputs, enabled, createdAt, updatedAt };
}

function isValidRecord(raw: unknown): raw is ScriptRecord {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.name === 'string' &&
    typeof r.source === 'string' &&
    typeof r.enabled === 'boolean'
  );
}
