import { createPool, runMigrations } from '@uhc/core';

const pool = createPool();
runMigrations(pool, (m) => console.log(m))
  .then(async () => {
    console.log('migrations up to date');
    await pool.end();
  })
  .catch(async (err) => {
    console.error('migration failed', err);
    await pool.end();
    process.exit(1);
  });
