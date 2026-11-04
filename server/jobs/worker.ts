import { PgBoss } from 'pg-boss';
import { Pool } from 'pg';
import { readRuntimeConfig } from '../config.ts';

const config = readRuntimeConfig(process.env);
if (config.mode === 'local')
  throw new Error('The durable worker requires hosted runtime configuration.');
const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 3,
  connectionTimeoutMillis: 10_000,
});
const queue = new PgBoss({ connectionString: config.databaseUrl, migrate: false });
queue.on('error', () => console.error('Durable queue operation failed. Check PostgreSQL health.'));
pool.on('error', () => console.error('Worker database connection failed.'));
try {
  await queue.start();
  await queue.work('maintenance.expired-auth', async () => {
    const connection = await pool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query('DELETE FROM app_sessions WHERE expires_at<now()');
      await connection.query('DELETE FROM oauth_requests WHERE expires_at<now()');
      await connection.query('DELETE FROM login_handoffs WHERE expires_at<now()');
      await connection.query('DELETE FROM connection_handoffs WHERE expires_at<now()');
      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  });
  await queue.schedule('maintenance.expired-auth', '*/15 * * * *', {}, { tz: 'UTC' });
  console.log(
    'Durable authentication-maintenance worker started. Deployment jobs remain disabled.',
  );
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, async () => {
      await queue.stop();
      await pool.end();
    });
} catch {
  console.error('Worker startup failed. Run database/queue migrations and verify hosted settings.');
  await queue.stop().catch(() => undefined);
  await pool.end();
  process.exitCode = 1;
}
