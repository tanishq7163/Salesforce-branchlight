import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testDatabase } from './support/database.ts';

test('PostgreSQL persists users/tenants, rejects cross-tenant access and revokes hashed sessions', async () => {
  const { database, store } = await testDatabase();
  try {
    await store.migrate();
    const alice = await store.upsertGithubUser('1001', 'alice');
    const bob = await store.upsertGithubUser('1002', 'bob');
    const first = await store.createTenant(alice.id, 'Alice Team');
    const second = await store.createTenant(bob.id, 'Bob Team');
    assert.deepEqual(
      (await store.listTenants(alice.id)).map((tenant) => tenant.id),
      [first.id],
    );
    await assert.rejects(
      store.withTenant(bob.id, first.id, [], async () => true),
      /access/,
    );
    await assert.rejects(
      store.withTenant(alice.id, second.id, [], async () => true),
      /access/,
    );
    const session = await store.createSession(alice.id);
    assert.equal((await store.authenticate(session.token)).id, alice.id);
    const saved = await database.query<{ token_hash: string }>(
      'SELECT token_hash FROM app_sessions',
    );
    assert.notEqual(saved.rows[0]!.token_hash, session.token);
    await store.revokeSession(session.token);
    await assert.rejects(store.authenticate(session.token), /Sign in again/);
  } finally {
    await database.close();
  }
});

test('PostgreSQL row policies refuse credential reads without the matching tenant and owner', async () => {
  const { database, store } = await testDatabase();
  try {
    const alice = await store.upsertGithubUser('1001', 'alice');
    const tenant = await store.createTenant(alice.id, 'Alice Team');
    await store.withTenant(alice.id, tenant.id, [], async (connection) => {
      await connection.query(
        'INSERT INTO provider_credentials(id,tenant_id,user_id,provider,external_id,label,environment,secret_ciphertext) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          crypto.randomUUID(),
          tenant.id,
          alice.id,
          'salesforce',
          'org-one',
          'Sandbox',
          'sandbox',
          'encrypted-example',
        ],
      );
    });
    await database.exec(
      'CREATE ROLE branchlight_runtime_test; GRANT USAGE ON SCHEMA public TO branchlight_runtime_test; GRANT SELECT ON provider_credentials TO branchlight_runtime_test; SET ROLE branchlight_runtime_test;',
    );
    assert.equal((await database.query('SELECT * FROM provider_credentials')).rows.length, 0);
    await database.query(
      "SELECT set_config('branchlight.tenant_id',$1,false),set_config('branchlight.user_id',$2,false)",
      [tenant.id, alice.id],
    );
    assert.equal((await database.query('SELECT * FROM provider_credentials')).rows.length, 1);
    await database.query("SELECT set_config('branchlight.user_id',$1,false)", [
      crypto.randomUUID(),
    ]);
    assert.equal((await database.query('SELECT * FROM provider_credentials')).rows.length, 0);
  } finally {
    await database.close();
  }
});

test('production runtime rejects a database superuser and accepts a non-bypass application role', async () => {
  const { database, store } = await testDatabase();
  try {
    await assert.rejects(store.assertRuntimeRole(), /without superuser/);
    await database.exec('CREATE ROLE branchlight_runtime_test; SET ROLE branchlight_runtime_test;');
    await store.assertRuntimeRole();
  } finally {
    await database.close();
  }
});
