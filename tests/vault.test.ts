import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { SecretVault } from '../server/security/vault.ts';

const context = { tenantId: 'team-one', userId: 'alice', purpose: 'salesforce:org-one' };

test('credentials are encrypted with independent nonces and bound to tenant/user/purpose', () => {
  const vault = new SecretVault('current', new Map([['current', randomBytes(32)]]));
  const first = vault.encrypt('test-credential', context);
  const second = vault.encrypt('test-credential', context);
  assert.notEqual(first, second);
  assert.ok(!first.includes('test-credential'));
  assert.equal(vault.decrypt(first, context), 'test-credential');
  for (const field of ['tenantId', 'userId', 'purpose'] as const) {
    assert.throws(
      () => vault.decrypt(first, { ...context, [field]: 'someone-else' }),
      /authenticated/,
    );
  }
  const modified = JSON.parse(first);
  modified.ciphertext = randomBytes(16).toString('base64');
  assert.throws(() => vault.decrypt(JSON.stringify(modified), context), /authenticated/);
});

test('key rotation reads old credentials but writes using the active key', () => {
  const old = randomBytes(32);
  const current = randomBytes(32);
  const previous = new SecretVault('old', new Map([['old', old]]));
  const envelope = previous.encrypt('old-value', context);
  const rotated = new SecretVault(
    'new',
    new Map([
      ['old', old],
      ['new', current],
    ]),
  );
  assert.equal(rotated.decrypt(envelope, context), 'old-value');
  assert.equal(JSON.parse(rotated.encrypt('new-value', context)).keyId, 'new');
  const retired = new SecretVault('new', new Map([['new', current]]));
  assert.throws(() => retired.decrypt(envelope, context), /authenticated/);
});
