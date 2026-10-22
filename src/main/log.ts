// A small log file for support: start-up lines, crashes and unexpected errors.
// It never records project content, only what the app itself reports.
//
// Writes are synchronous so a line still lands when the process is going down,
// and the logger never throws: logging must not be the thing that breaks the app.

import fs from 'node:fs';
import path from 'node:path';

/** Past this size the log moves to `*.old.log` (one previous log is kept). */
export const MAX_LOG_BYTES = 512 * 1024;

export interface Logger {
  readonly file: string;
  info(message: string): void;
  error(context: string, err: unknown): void;
}

/** An error as readable text: the stack when there is one. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

export function createLogger(file: string, maxBytes = MAX_LOG_BYTES, now: () => Date = () => new Date()): Logger {
  const write = (level: 'INFO' | 'ERROR', text: string): void => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try {
        if (fs.statSync(file).size > maxBytes) {
          const old = file.replace(/\.log$/, '') + '.old.log';
          fs.rmSync(old, { force: true });
          fs.renameSync(file, old);
        }
      } catch {
        // No log yet: nothing to rotate.
      }
      fs.appendFileSync(file, `${now().toISOString()} ${level} ${text}\n`, 'utf8');
    } catch {
      // Ignored on purpose.
    }
  };
  return {
    file,
    info: (message) => write('INFO', message),
    error: (context, err) => write('ERROR', `${context}\n${describeError(err)}`),
  };
}
