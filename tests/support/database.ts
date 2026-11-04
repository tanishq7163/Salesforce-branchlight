import { PGlite } from '@electric-sql/pglite';
import { Store } from '../../server/database/store.ts';
import type { DatabasePool } from '../../server/database/store.ts';

export async function testDatabase() {
  const database = new PGlite();
  const pool: DatabasePool = {
    async connect() {
      return {
        async query(sql, values) {
          if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
          if (!values && sql.includes(';')) {
            await database.exec(sql);
            return { rows: [] };
          }
          return database.query(sql, values);
        },
        release() {},
      };
    },
  };
  const store = new Store(pool);
  await store.migrate();
  return { database, store };
}
