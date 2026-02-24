const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

export function createLogger(level) {
  const threshold = LEVELS[(level || 'info').toLowerCase()] ?? LEVELS.info;

  function emit(lvl, msg, ctx) {
    if (LEVELS[lvl] < threshold) return;
    const entry = { level: lvl, msg, ...ctx, ts: new Date().toISOString() };
    console[lvl](JSON.stringify(entry));
  }

  return {
    debug: (msg, ctx) => emit('debug', msg, ctx),
    info: (msg, ctx) => emit('info', msg, ctx),
    warn: (msg, ctx) => emit('warn', msg, ctx),
    error: (msg, ctx) => emit('error', msg, ctx),
  };
}
