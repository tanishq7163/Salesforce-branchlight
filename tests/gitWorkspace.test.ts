import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import {
  GitWorkspace,
  contentHash,
  githubCompareUrl,
  validateSourcePath,
} from '../server/gitWorkspace.ts';

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'branchlight-git-'));
  temporaryRoots.push(root);
  const source = join(root, 'source');
  const remote = join(root, 'remote.git');
  await mkdir(source);
  const git = simpleGit(source);
  await git.init(['--initial-branch=main']);
  await git.addConfig('user.name', 'Test Developer');
  await git.addConfig('user.email', 'developer@example.test');
  await writeFile(
    join(source, 'Invoice.cls'),
    'public class Invoice {\n  Integer amount = 1;\n}\n',
  );
  await git.add('.');
  await git.commit('Trusted baseline');
  await simpleGit().clone(source, remote, ['--bare']);
  async function clone(name: string) {
    const directory = join(root, name);
    await simpleGit().clone(remote, directory);
    const workspace = new GitWorkspace(directory, name, remote);
    await workspace.git.addConfig('user.name', name);
    await workspace.git.addConfig('user.email', `${name}@example.test`);
    return workspace;
  }
  return { clone, remote };
}

async function editAndCommit(workspace: GitWorkspace, content: string) {
  const view = await workspace.view();
  const file = await workspace.file('Invoice.cls', view.branch);
  await workspace.stage(file.path, content, file.hash, view.branch);
  const staged = await workspace.view();
  await workspace.commit('Update invoice', staged.branch, staged.head, staged.indexTree!);
}

test('staging refuses stale content and direct edits to main', async () => {
  const { clone } = await fixture();
  const workspace = await clone('alice');
  await assert.rejects(
    workspace.stage('Invoice.cls', 'edit', contentHash('wrong baseline'), 'main'),
    /feature branch/,
  );
  await workspace.checkout('feature/alice', 'main', true);
  const opened = await workspace.file('Invoice.cls', 'feature/alice');
  await writeFile(join(workspace.root, 'Invoice.cls'), 'another editor changed this');
  await assert.rejects(
    workspace.stage('Invoice.cls', 'stale tab', opened.hash, 'feature/alice'),
    /changed since/,
  );
  assert.equal(
    await readFile(join(workspace.root, 'Invoice.cls'), 'utf8'),
    'another editor changed this',
  );
});

test('two developers changing the same file produce a resolvable three-way conflict', async () => {
  const { clone } = await fixture();
  const alice = await clone('alice');
  const bob = await clone('bob');
  await alice.checkout('feature/alice', 'main', true);
  await bob.checkout('feature/bob', 'main', true);
  await editAndCommit(alice, 'public class Invoice {\n  Integer amount = 2;\n}\n');
  await editAndCommit(bob, 'public class Invoice {\n  Integer amount = 3;\n}\n');
  await bob.push('feature/bob');
  await alice.fetch();
  await alice.merge('origin/feature/bob', 'feature/alice');
  assert.deepEqual((await alice.view()).conflicts, ['Invoice.cls']);
  const versions = await alice.conflict('Invoice.cls', 'feature/alice');
  assert.match(versions.base, /amount = 1/);
  assert.match(versions.ours, /amount = 2/);
  assert.match(versions.theirs, /amount = 3/);
  const conflict = await alice.file('Invoice.cls', 'feature/alice');
  await assert.rejects(
    alice.stage(conflict.path, conflict.content, conflict.hash, 'feature/alice', true),
    /conflict markers/,
  );
  await alice.stage(
    conflict.path,
    'public class Invoice {\n  Integer amount = 5;\n}\n',
    conflict.hash,
    'feature/alice',
    true,
  );
  const resolved = await alice.view();
  await alice.commit(
    'Resolve invoice conflict',
    resolved.branch,
    resolved.head,
    resolved.indexTree!,
  );
  assert.equal((await alice.view()).conflicts.length, 0);
});

test('a stale push to a shared branch is rejected without replacing remote changes', async () => {
  const { clone, remote } = await fixture();
  const alice = await clone('alice');
  await alice.checkout('feature/shared', 'main', true);
  await alice.push('feature/shared');
  const bob = await clone('bob');
  await bob.checkout('feature/shared', 'main');
  await editAndCommit(alice, 'alice edit');
  await alice.push('feature/shared');
  await editAndCommit(bob, 'bob edit');
  await assert.rejects(bob.push('feature/shared'));
  assert.equal(await simpleGit(remote).show(['feature/shared:Invoice.cls']), 'alice edit');
});

test('staged-snapshot changes invalidate a previously reviewed commit action', async () => {
  const { clone } = await fixture();
  const workspace = await clone('alice');
  await workspace.checkout('feature/alice', 'main', true);
  const original = await workspace.view();
  const file = await workspace.file('Invoice.cls', original.branch);
  await workspace.stage(file.path, 'new content', file.hash, original.branch);
  await assert.rejects(
    workspace.commit('Stale snapshot', original.branch, original.head, original.indexTree!),
    /snapshot changed/,
  );
});

test('source paths reject traversal, git internals, hidden secrets and unsupported files', () => {
  for (const path of [
    '../Invoice.cls',
    '.git/config',
    '.env',
    'C:/Invoice.cls',
    'folder\\Invoice.cls',
    '/Invoice.cls',
  ]) {
    assert.throws(() => validateSourcePath(path));
  }
  validateSourcePath('force-app/main/default/classes/Invoice.cls');
});

test('GitHub compare links retain the correct private repository and branch', () => {
  assert.equal(
    githubCompareUrl('https://github.com/team/private.git', 'feature/alice'),
    'https://github.com/team/private/compare/feature%2Falice?expand=1',
  );
  assert.equal(githubCompareUrl('/local/repo', 'main'), null);
});
