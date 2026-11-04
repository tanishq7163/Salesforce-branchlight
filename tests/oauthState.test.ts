import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { OAuthStateService, pkceChallenge } from '../server/auth/oauthState.ts';
import { SecretVault } from '../server/security/vault.ts';
import { testDatabase } from './support/database.ts';

test('OAuth state expires, is consumed once and stores only an encrypted provider verifier', async () => {
  const { database, store } = await testDatabase();
  try {
    const service = new OAuthStateService(
      store,
      new SecretVault('current', new Map([['current', randomBytes(32)]])),
    );
    const request = await service.start({
      provider: 'github',
      returnUrl: 'https://app.example.test/',
      challenge: pkceChallenge('a'.repeat(43)),
      authority: 'https://github.com',
    });
    const stored = await database.query<{ state_hash: string; verifier_ciphertext: string }>(
      'SELECT state_hash,verifier_ciphertext FROM oauth_requests',
    );
    assert.notEqual(stored.rows[0]!.state_hash, request.state);
    const consumed = await service.consume(request.state, 'github');
    assert.equal(pkceChallenge(consumed.verifier), request.challenge);
    assert.ok(!stored.rows[0]!.verifier_ciphertext.includes(consumed.verifier));
    await assert.rejects(service.consume(request.state, 'github'), /already used/);
    const expired = await service.start({
      provider: 'github',
      returnUrl: 'https://app.example.test/',
      challenge: pkceChallenge('b'.repeat(43)),
      authority: 'https://github.com',
    });
    await database.query("UPDATE oauth_requests SET expires_at=now()-interval '1 minute'");
    await assert.rejects(service.consume(expired.state, 'github'), /expired/);
  } finally {
    await database.close();
  }
});

test('browser return codes require the original PKCE verifier and cannot be replayed', async () => {
  const { database, store } = await testDatabase();
  try {
    const service = new OAuthStateService(
      store,
      new SecretVault('current', new Map([['current', randomBytes(32)]])),
    );
    const user = await store.upsertGithubUser('1001', 'alice');
    const verifier = randomBytes(32).toString('base64url');
    const code = await service.createHandoff(user.id, pkceChallenge(verifier));
    await assert.rejects(service.exchange(code, 'x'.repeat(43)), /invalid/);
    const session = await service.exchange(code, verifier);
    assert.equal((await store.authenticate(session.token)).id, user.id);
    await assert.rejects(service.exchange(code, verifier), /already used/);
  } finally {
    await database.close();
  }
});
