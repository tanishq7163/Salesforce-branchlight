import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { extensionManifest } from '../build/extensionManifest.ts';
import { hostedOrigin, browserChallenge } from '../src/hostedClient.ts';
import { pkceChallenge } from '../server/auth/oauthState.ts';

test('hosted extension permits only its configured HTTPS API and browser identity/session APIs', async () => {
  const source = JSON.parse(
    await readFile(new URL('../public/manifest.json', import.meta.url), 'utf8'),
  );
  const manifest = extensionManifest(source, 'https://api.example.test');
  assert.deepEqual(manifest.host_permissions, ['https://api.example.test/*']);
  assert.deepEqual(manifest.permissions, ['identity', 'storage']);
  assert.ok(!JSON.stringify(manifest).includes('127.0.0.1'));
  assert.ok(!JSON.stringify(manifest).includes('<all_urls>'));
  assert.deepEqual(extensionManifest(source).host_permissions, source.host_permissions);
  assert.throws(() => extensionManifest(source, 'http://api.example.test'));
  assert.throws(() => extensionManifest({ ...source, description: 'x'.repeat(133) }));
});

test('browser API origins are HTTPS except explicit loopback development', () => {
  assert.equal(hostedOrigin('https://api.example.test'), 'https://api.example.test');
  assert.throws(() => hostedOrigin('http://127.0.0.1:8787'));
  assert.equal(hostedOrigin('http://127.0.0.1:8787', true), 'http://127.0.0.1:8787');
  assert.throws(() => hostedOrigin('https://user:token@api.example.test'));
  assert.throws(() => hostedOrigin('https://api.example.test/path'));
});

test('browser-generated PKCE challenges match the backend SHA-256 contract', async () => {
  const verifier = 'x'.repeat(64);
  assert.equal(await browserChallenge(verifier), pkceChallenge(verifier));
});
