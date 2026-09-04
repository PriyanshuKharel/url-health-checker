/** Tiny structured logger so api/worker logs are greppable in `docker compose logs`. */
export function createLogger(scope: string) {
  const emit = (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => {
    const line = { ts: new Date().toISOString(), level, scope, msg, ...(extra ?? {}) };
    const out = level === 'error' ? console.error : console.log;
    out(JSON.stringify(line));
  };
  return {
    info: (msg: string, extra?: Record<string, unknown>) => emit('info', msg, extra),
    warn: (msg: string, extra?: Record<string, unknown>) => emit('warn', msg, extra),
    error: (msg: string, extra?: Record<string, unknown>) => emit('error', msg, extra),
  };
}
export type Logger = ReturnType<typeof createLogger>;
