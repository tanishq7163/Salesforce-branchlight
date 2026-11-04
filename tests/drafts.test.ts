import assert from 'node:assert/strict';
import { test } from 'node:test';
import { draftKey, nextDraft } from '../src/drafts.ts';

const scope = {
  repository: 'team/private-repo',
  workspace: 'developer-one',
  branch: 'feature/invoice',
  path: 'force-app/main/default/classes/Invoice.cls',
};

test('draft identities isolate branches, repositories, users and files', () => {
  const original = draftKey(scope);
  for (const field of ['repository', 'workspace', 'branch', 'path'] as const) {
    assert.notEqual(draftKey({ ...scope, [field]: 'different' }), original);
  }
});

test('saving updates only the draft and preserves its original base', () => {
  const original = nextDraft(scope, 'first edit', 'org baseline', undefined, 0);
  const updated = nextDraft(scope, 'second edit', 'different baseline', original, 1);
  assert.equal(updated.content, 'second edit');
  assert.equal(updated.baseContent, 'org baseline');
  assert.equal(updated.revision, 2);
  assert.equal(original.content, 'first edit');
});

test('a stale tab cannot overwrite a newer draft', () => {
  const original = nextDraft(scope, 'newer edit', 'baseline', undefined, 0);
  assert.throws(() => nextDraft(scope, 'stale edit', 'baseline', original, 0), /another tab/);
});

test('a draft cannot be silently carried into another branch', () => {
  const original = nextDraft(scope, 'draft', 'baseline', undefined, 0);
  assert.throws(
    () => nextDraft({ ...scope, branch: 'main' }, 'draft', 'baseline', original, 1),
    /different workspace/,
  );
});
