import pg from 'pg';
import { config } from './config.js';

export type DbClient = pg.PoolClient | pg.Pool;

export function createPool(): pg.Pool {
  return new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
}

/** Runs fn inside a transaction, rolling back on any error. */
export async function withTransaction<T>(pool: pg.Pool, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}
