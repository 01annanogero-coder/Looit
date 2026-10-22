import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, describeError } from './log';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looit-log-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('describeError', () => {
  it('uses the stack of an Error', () => {
    const err = new Error('boom');
    expect(describeError(err)).toContain('boom');
    expect(describeError(err)).toContain('log.test');
  });

  it('copes with values that are not errors', () => {
    expect(describeError('plain text')).toBe('plain text');
    expect(describeError({ a: 1 })).toBe('{"a":1}');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(typeof describeError(circular)).toBe('string');
  });
});

describe('logger', () => {
  it('creates the folder and appends timestamped lines', () => {
    const file = path.join(dir, 'nested', 'looit.log');
    const log = createLogger(file, 1000, () => new Date('2026-10-22T07:00:00Z'));
    log.info('starting');
    log.error('Uncaught exception', new Error('bad'));
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('2026-10-22T07:00:00.000Z INFO starting');
    expect(text).toContain('ERROR Uncaught exception');
    expect(text).toContain('bad');
  });

  it('moves a full log aside and keeps only one previous log', () => {
    const file = path.join(dir, 'looit.log');
    const log = createLogger(file, 200);
    for (let i = 0; i < 40; i++) log.info(`line ${i} ${'x'.repeat(20)}`);
    const files = fs.readdirSync(dir).sort();
    expect(files).toEqual(['looit.log', 'looit.old.log']);
    expect(fs.statSync(file).size).toBeLessThan(400);
    // The newest line is always in the current log.
    expect(fs.readFileSync(file, 'utf8')).toContain('line 39');
  });

  it('never throws when the log cannot be written', () => {
    const blocker = path.join(dir, 'file-not-folder');
    fs.writeFileSync(blocker, 'x');
    const log = createLogger(path.join(blocker, 'looit.log'));
    expect(() => log.info('still fine')).not.toThrow();
    expect(() => log.error('still fine', new Error('x'))).not.toThrow();
  });
});
