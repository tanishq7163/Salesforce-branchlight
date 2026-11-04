import { Pool } from 'pg';
import { PgBoss } from 'pg-boss';
import { Store } from './store.ts';

const connectionString = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!connectionString)
  throw new Error('Configure DATABASE_MIGRATION_URL before running migrations.');
const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000 });
const queue = new PgBoss({ connectionString, supervise: false, schedule: false });
pool.on('error', () => console.error('Migration database connection failed.'));
queue.on('error', () => console.error('Queue migration database operation failed.'));
try {
  await new Store(pool).migrate();
  await queue.start();
  await queue.createQueue('maintenance.expired-auth', { retryLimit: 2 });
  console.log('Database and durable queue migrations completed.');
} catch {
  console.error(
    'Database migration failed. Verify the migration role, connectivity and PostgreSQL version. Credentials are not logged.',
  );
  process.exitCode = 1;
} finally {
  await queue.stop().catch(() => undefined);
  await pool.end();
}
