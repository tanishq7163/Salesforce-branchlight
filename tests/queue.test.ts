import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { PgBoss, fromPglite } from 'pg-boss';

test('durable queue persists and claims a job once before explicit completion', async () => {
  const database = new PGlite();
  const queue = new PgBoss({ db: fromPglite(database), schedule: false, supervise: false });
  try {
    await queue.start();
    await queue.createQueue('test.safe-job', { retryLimit: 0 });
    const id = await queue.send('test.safe-job', { tenantId: 'test-tenant' });
    const jobs = await queue.fetch<{ tenantId: string }>('test.safe-job');
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.id, id);
    assert.equal(jobs[0]!.data.tenantId, 'test-tenant');
    assert.equal((await queue.fetch('test.safe-job')).length, 0);
    await queue.complete('test.safe-job', jobs[0]!.id);
    assert.equal((await queue.fetch('test.safe-job')).length, 0);
  } finally {
    await queue.stop();
    await database.close();
  }
});
