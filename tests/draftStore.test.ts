import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createDraftStore } from '../src/draftStore.ts';

const scope = {
  repository: 'team/private',
  workspace: 'alice',
  branch: 'feature/alice',
  path: 'Invoice.cls',
};

test('saved drafts survive a closed and reopened IndexedDB connection without network calls', async () => {
  const name = randomUUID();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('Saving must not make network requests.');
  };
  const first = createDraftStore(name);
  try {
    await first.save(scope, 'local edit', 'baseline', 0);
    await first.close();
    const reopened = createDraftStore(name);
    try {
      assert.equal((await reopened.read(scope))?.content, 'local edit');
      assert.equal(await reopened.read({ ...scope, branch: 'main' }), undefined);
      assert.equal(await reopened.read({ ...scope, workspace: 'bob' }), undefined);
    } finally {
      await reopened.close();
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('concurrent tabs cannot both save using the same revision', async () => {
  const name = randomUUID();
  const first = createDraftStore(name);
  const second = createDraftStore(name);
  try {
    const results = await Promise.allSettled([
      first.save(scope, 'alice edit', 'baseline', 0),
      second.save(scope, 'stale tab edit', 'baseline', 0),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.equal((await first.read(scope))?.revision, 1);
  } finally {
    await first.close();
    await second.close();
  }
});
