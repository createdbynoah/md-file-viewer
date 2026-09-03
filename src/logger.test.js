import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLogger } from './logger.js';

describe('createLogger', () => {
  afterEach(() => vi.restoreAllMocks());

  it('emits JSON with level, msg, context and ts', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    createLogger('info').info('hello', { a: 1 });
    expect(spy).toHaveBeenCalledOnce();
    const entry = JSON.parse(spy.mock.calls[0][0]);
    expect(entry).toMatchObject({ level: 'info', msg: 'hello', a: 1 });
    expect(new Date(entry.ts).toISOString()).toBe(entry.ts);
  });

  it('suppresses messages below the threshold', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = createLogger('warn');
    log.debug('x');
    log.warn('y');
    expect(debug).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('defaults to info for missing or unknown levels', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    createLogger(undefined).debug('x');
    createLogger('bogus').info('y');
    expect(debug).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledOnce();
  });
});
