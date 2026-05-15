import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AppConfig } from '../config';

export interface AppLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

const consoleLine = (msg: string, meta?: Record<string, unknown>): string => {
  return `${msg} ${meta ? JSON.stringify(meta) : ''}\n`;
}

const jsonLine = (level: 'info' | 'warn', msg: string, meta?: Record<string, unknown>): string => {
  return `${JSON.stringify({ ts: new Date().toISOString(), level, msg, ...meta })}\n`;
}

export const createAppLogger = (cfg: AppConfig): AppLogger => {
  const filePath = (cfg.APP_LOG_PATH ?? '').trim();
  const jsonConsole = cfg.LOG_JSON_CONSOLE;
  let fileWriteWarned = false;

  const writeConsole = (level: 'info' | 'warn', msg: string, meta?: Record<string, unknown>): void => {
    const line = jsonConsole ? jsonLine(level, msg, meta) : consoleLine(msg, meta);
    if (level === 'warn') process.stderr.write(line);
    else process.stdout.write(line);
  };

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
      writeConsole('info', msg, meta);
      writeFile('info', msg, meta);
    },
    warn: (msg, meta) => {
      writeConsole('warn', msg, meta);
      writeFile('warn', msg, meta);
    },
  };
}
