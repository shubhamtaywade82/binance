import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AppConfig } from '../config';

export interface AppLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

function consoleLine(msg: string, meta?: Record<string, unknown>): string {
  return `${msg} ${meta ? JSON.stringify(meta) : ''}\n`;
}

function jsonLine(level: 'info' | 'warn', msg: string, meta?: Record<string, unknown>): string {
  return `${JSON.stringify({ ts: new Date().toISOString(), level, msg, ...meta })}\n`;
}

/**
 * Stdout/stderr for humans in the terminal, optional NDJSON file for persistence.
 * Set `APP_LOG_PATH` (e.g. `./logs/app.ndjson`) to append one JSON object per line.
 */
export function createAppLogger(cfg: AppConfig): AppLogger {
  const filePath = (cfg.APP_LOG_PATH ?? '').trim();
  let fileWriteWarned = false;

  const writeFile = (level: 'info' | 'warn', msg: string, meta?: Record<string, unknown>): void => {
    if (!filePath) return;
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      appendFileSync(filePath, jsonLine(level, msg, meta), { encoding: 'utf8' });
    } catch (err) {
      if (!fileWriteWarned) {
        fileWriteWarned = true;
        process.stderr.write(
          `app_logger_file_error ${(err as Error).message} path=${filePath}\n`,
        );
      }
    }
  };

  return {
    info: (msg, meta) => {
      process.stdout.write(consoleLine(msg, meta));
      writeFile('info', msg, meta);
    },
    warn: (msg, meta) => {
      process.stderr.write(consoleLine(msg, meta));
      writeFile('warn', msg, meta);
    },
  };
}
