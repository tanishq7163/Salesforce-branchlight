import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { readRuntimeConfig } from '../server/config.ts';

function hosted(): NodeJS.ProcessEnv {
  return {
    BRANCHLIGHT_MODE: 'sandbox-demo',
    BRANCHLIGHT_PUBLIC_API_URL: 'https://api.example.test',
    BRANCHLIGHT_ALLOWED_EXTENSION_IDS: 'a'.repeat(32),
    DATABASE_URL: 'postgresql://localhost/branchlight',
    BRANCHLIGHT_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  };
}

test('local mode remains loopback-only and allows the existing extension ID', () => {
  const config = readRuntimeConfig({ BRANCHLIGHT_EXTENSION_ID: 'a'.repeat(32) });
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.productionDeployment, false);
  assert.ok(config.allowedOrigins.includes(`chrome-extension://${'a'.repeat(32)}`));
  assert.throws(() => readRuntimeConfig({ BRANCHLIGHT_EDITOR_URL: 'http://external.example' }));
});

test('hosted modes require HTTPS, persistent database configuration and an encryption key', () => {
  for (const field of [
    'BRANCHLIGHT_PUBLIC_API_URL',
    'DATABASE_URL',
    'BRANCHLIGHT_ENCRYPTION_KEY',
    'BRANCHLIGHT_ALLOWED_EXTENSION_IDS',
  ]) {
    const values = hosted();
    delete values[field];
    assert.throws(() => readRuntimeConfig(values));
  }
  assert.throws(() =>
    readRuntimeConfig({ ...hosted(), BRANCHLIGHT_PUBLIC_API_URL: 'http://api.example.test' }),
  );
  assert.throws(() => readRuntimeConfig({ ...hosted(), BRANCHLIGHT_ENCRYPTION_KEY: 'not-a-key' }));
  assert.throws(() => readRuntimeConfig({ ...hosted(), BRANCHLIGHT_ALLOWED_EXTENSION_IDS: '*' }));
});

test('hosted configuration never enables production deployment through an environment flag', () => {
  const config = readRuntimeConfig({
    ...hosted(),
    BRANCHLIGHT_MODE: 'production',
    BRANCHLIGHT_ENABLE_DEPLOY: 'true',
  });
  assert.equal(config.mode, 'production');
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.productionDeployment, false);
  assert.equal(config.encryptionKey?.length, 32);
});

test('malformed connection URLs do not leak their contents into configuration errors', () => {
  assert.throws(
    () => readRuntimeConfig({ ...hosted(), DATABASE_URL: 'invalid-test-password-value' }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes('invalid-test-password-value'));
      assert.ok(!JSON.stringify(error).includes('invalid-test-password-value'));
      return true;
    },
  );
});
