import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { ConnectionService } from '../server/integrations/connections.ts';
import { SecretVault } from '../server/security/vault.ts';
import { testDatabase } from './support/database.ts';

test('connection metadata is tenant/owner scoped and provider credentials never appear in list responses', async () => {
  const { database, store } = await testDatabase();
  try {
    const service = new ConnectionService(
      store,
      new SecretVault('current', new Map([['current', randomBytes(32)]])),
    );
    const alice = await store.upsertGithubUser('1001', 'alice');
    const bob = await store.upsertGithubUser('1002', 'bob');
    const tenant = await store.createTenant(alice.id, 'Alice Team');
    await service.saveGithub(alice.id, { token: 'github-test-secret' });
    await service.saveSalesforce(alice.id, tenant.id, {
      accessToken: 'salesforce-test-secret',
      instanceUrl: 'https://acme.my.salesforce.com',
      authority: 'https://test.salesforce.com',
      orgId: '00D000000000001AAA',
      userId: '005000000000001AAA',
      label: 'Sandbox',
      sandbox: true,
    });
    const listed = await service.listSalesforce(alice.id, tenant.id);
    assert.equal(listed.length, 1);
    assert.ok(!JSON.stringify(listed).includes('secret'));
    const encrypted = await database.query<{ secret_ciphertext: string }>(
      'SELECT secret_ciphertext FROM provider_credentials',
    );
    assert.ok(!encrypted.rows[0]!.secret_ciphertext.includes('salesforce-test-secret'));
    await assert.rejects(service.listSalesforce(bob.id, tenant.id), /access/);
    await database.query(
      "INSERT INTO memberships(tenant_id,user_id,role) VALUES ($1,$2,'developer')",
      [tenant.id, bob.id],
    );
    assert.equal((await service.listSalesforce(bob.id, tenant.id)).length, 0);
    await assert.rejects(service.disconnectSalesforce(bob.id, tenant.id, listed[0]!.id), /access/);
    assert.equal((await service.github(alice.id)).token, 'github-test-secret');
    await assert.rejects(service.github(bob.id), /Connect GitHub/);
  } finally {
    await database.close();
  }
});

test('repository binding rechecks membership and the actual GitHub App/user access intersection', async () => {
  const { database, store } = await testDatabase();
  try {
    const service = new ConnectionService(
      store,
      new SecretVault('current', new Map([['current', randomBytes(32)]])),
    );
    const alice = await store.upsertGithubUser('1001', 'alice');
    const tenant = await store.createTenant(alice.id, 'Alice Team');
    await service.saveGithub(alice.id, { token: 'test-grant' });
    const provider = {
      async repositories() {
        return [
          {
            id: 100,
            installationId: 20,
            name: 'team/private',
            private: true,
            defaultBranch: 'main',
            url: 'https://github.com/team/private',
          },
        ];
      },
    };
    await assert.rejects(
      service.bindRepository(alice.id, tenant.id, 999, provider),
      /both have access/,
    );
    await service.bindRepository(alice.id, tenant.id, 100, provider);
    assert.equal(
      (await service.listRepositories(alice.id, tenant.id))[0]!.full_name,
      'team/private',
    );
    await database.query('DELETE FROM memberships WHERE tenant_id=$1 AND user_id=$2', [
      tenant.id,
      alice.id,
    ]);
    await assert.rejects(service.bindRepository(alice.id, tenant.id, 100, provider), /access/);
  } finally {
    await database.close();
  }
});
