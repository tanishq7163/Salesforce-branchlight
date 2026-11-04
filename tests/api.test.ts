import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.ts';

test('the local API requires pairing, rejects untrusted origins and refuses deployment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'branchlight-api-'));
  const token = 'test-only-token';
  const app = await createApp({ directory, token });
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: '/api/health',
          headers: { authorization: 'Bearer wrong' },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: '/api/health',
          headers: { authorization: `Bearer ${token}`, origin: 'https://evil.example' },
        })
      ).statusCode,
      403,
    );
    const health = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().productionDeployment, false);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/deploy',
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
      403,
    );
    for (const repository of [
      'https://user:token@github.com/team/private.git',
      'https://evil.example/private.git',
      'file:///etc',
      '--upload-pack=bad',
    ]) {
      const result = await app.inject({
        method: 'POST',
        url: '/api/workspaces',
        headers: { authorization: `Bearer ${token}` },
        payload: { repository, authorName: 'Alice', authorEmail: 'alice@example.test' },
      });
      assert.equal(result.statusCode, 400);
    }
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('local example workspaces are isolated, durable and support a real commit/push cycle', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'branchlight-api-'));
  const token = 'test-only-token';
  const app = await createApp({ directory, token });
  const headers = { authorization: `Bearer ${token}` };
  try {
    const first = (await app.inject({ method: 'POST', url: '/api/starter', headers })).json();
    const second = (await app.inject({ method: 'POST', url: '/api/starter', headers })).json();
    assert.notEqual(first.id, second.id);
    assert.match(first.branch, /^feature\/my-work-/);
    assert.notEqual(first.branch, second.branch);
    const path = first.files.find((file: string) => file.endsWith('InvoiceService.cls'));
    const file = (
      await app.inject({
        method: 'GET',
        url: `/api/workspaces/${first.id}/file?path=${encodeURIComponent(path)}&branch=${encodeURIComponent(first.branch)}`,
        headers,
      })
    ).json();
    const stagedResponse = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${first.id}/stage`,
      headers,
      payload: {
        branch: first.branch,
        path,
        content: `${file.content}\n`,
        expectedHash: file.hash,
      },
    });
    assert.equal(stagedResponse.statusCode, 200);
    const staged = stagedResponse.json();
    const commit = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${first.id}/commit`,
      headers,
      payload: {
        branch: first.branch,
        message: 'Local test commit',
        head: staged.head,
        indexTree: staged.indexTree,
      },
    });
    assert.equal(commit.statusCode, 200);
    const push = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${first.id}/push`,
      headers,
      payload: { branch: first.branch },
    });
    assert.equal(push.statusCode, 200);
    const untouched = (
      await app.inject({ method: 'GET', url: `/api/workspaces/${second.id}`, headers })
    ).json();
    assert.equal(untouched.changes.length, 0);
    await app.close();
    const restarted = await createApp({ directory, token });
    try {
      const recovered = await restarted.inject({
        method: 'GET',
        url: `/api/workspaces/${first.id}`,
        headers,
      });
      assert.equal(recovered.statusCode, 200);
      assert.equal(recovered.json().history[0].message, 'Local test commit');
    } finally {
      await restarted.close();
    }
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
