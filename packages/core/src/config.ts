function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export const config = {
  databaseUrl: required('DATABASE_URL', 'postgres://uhc:uhc@localhost:5432/uhc'),
  redisUrl: required('REDIS_URL', 'redis://localhost:6379'),
  instanceId: process.env.HOSTNAME ?? `pid-${process.pid}`,
};
