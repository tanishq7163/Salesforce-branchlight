import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { createHostedApp } from '../server/hostedApp.ts';
import { readRuntimeConfig } from '../server/config.ts';
import { SecretVault } from '../server/security/vault.ts';
import { pkceChallenge } from '../server/auth/oauthState.ts';
import { testDatabase } from './support/database.ts';

test('hosted sign-in uses a one-time return code, supports tenant/org onboarding and denies cross-tenant access', async () => {
  const { database, store } = await testDatabase();
  const key = randomBytes(32);
  const config = readRuntimeConfig({
    BRANCHLIGHT_MODE: 'sandbox-demo',
    BRANCHLIGHT_PUBLIC_API_URL: 'https://api.example.test',
    BRANCHLIGHT_WEB_ORIGIN: 'https://app.example.test',
    DATABASE_URL: 'postgresql://localhost/test',
    BRANCHLIGHT_ENCRYPTION_KEY: key.toString('base64'),
  });
  const app = await createHostedApp({
    config,
    store,
    vault: new SecretVault('primary', new Map([['primary', key]])),
    github: {
      authorizationUrl(state, challenge) {
        return `https://github.com/login/oauth/authorize?${new URLSearchParams({ state, code_challenge: challenge })}`;
      },
      async exchange() {
        return { user: { id: '1001', login: 'alice' }, grant: { token: 'github-test-secret' } };
      },
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
    },
    salesforce: {
      authorizationUrl(_authority, state) {
        return `https://test.salesforce.com/services/oauth2/authorize?state=${state}`;
      },
      async exchange() {
        return {
          accessToken: 'salesforce-test-secret',
          instanceUrl: 'https://acme.my.salesforce.com',
          authority: 'https://test.salesforce.com',
          userId: '005000000000001AAA',
          orgId: '00D000000000001AAA',
          label: 'Acme Sandbox',
          sandbox: true,
        };
      },
    },
  });
  try {
    const verifier = randomBytes(32).toString('base64url');
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/auth/github/start',
          payload: { returnUrl: 'https://evil.example/', challenge: pkceChallenge(verifier) },
        })
      ).statusCode,
      400,
    );
    const start = await app.inject({
      method: 'POST',
      url: '/auth/github/start',
      payload: { returnUrl: 'https://app.example.test/', challenge: pkceChallenge(verifier) },
    });
    assert.equal(start.statusCode, 200);
    const state = new URL(start.json().authorizationUrl).searchParams.get('state');
    const callback = await app.inject({
      method: 'GET',
      url: `/auth/github/callback?state=${state}&code=provider-code`,
    });
    assert.equal(callback.statusCode, 302);
    const target = new URL(String(callback.headers.location));
    const code = new URLSearchParams(target.hash.slice(1)).get('code');
    assert.ok(!target.href.includes('github-test-secret'));
    const exchanged = await app.inject({
      method: 'POST',
      url: '/auth/exchange',
      payload: { code, verifier },
    });
    assert.equal(exchanged.statusCode, 200);
    const headers = { authorization: `Bearer ${exchanged.json().token}` };
    assert.equal(
      (await app.inject({ method: 'POST', url: '/auth/exchange', payload: { code, verifier } }))
        .statusCode,
      400,
    );
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers,
      payload: { name: 'Acme Team' },
    });
    const tenantId = created.json().id;
    assert.equal(created.statusCode, 200);
    const bound = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${tenantId}/repositories`,
      headers,
      payload: { githubId: 100 },
    });
    assert.equal(bound.statusCode, 200);
    const connect = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${tenantId}/salesforce/start`,
      headers,
      payload: {
        returnUrl: 'https://app.example.test/',
        challenge: pkceChallenge(verifier),
        authority: 'https://test.salesforce.com',
      },
    });
    assert.equal(connect.statusCode, 200);
    const sfState = new URL(connect.json().authorizationUrl).searchParams.get('state');
    const sfCallback = await app.inject({
      method: 'GET',
      url: `/auth/salesforce/callback?state=${sfState}&code=provider-code`,
    });
    assert.equal(sfCallback.statusCode, 302);
    const pendingList = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${tenantId}/salesforce`,
      headers,
    });
    assert.equal(pendingList.json().length, 0);
    const connectionCode = new URLSearchParams(
      new URL(String(sfCallback.headers.location)).hash.slice(1),
    ).get('connection_code');
    const outsider = await store.upsertGithubUser('1003', 'outsider');
    const outsiderSession = await store.createSession(outsider.id);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/salesforce/complete',
          headers: { authorization: `Bearer ${outsiderSession.token}` },
          payload: { code: connectionCode, verifier },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/salesforce/complete',
          headers,
          payload: { code: connectionCode, verifier: 'x'.repeat(43) },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/salesforce/complete',
          headers,
          payload: { code: connectionCode, verifier },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/salesforce/complete',
          headers,
          payload: { code: connectionCode, verifier },
        })
      ).statusCode,
      400,
    );
    const listed = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${tenantId}/salesforce`,
      headers,
    });
    assert.equal(listed.json()[0].label, 'Acme Sandbox');
    assert.ok(!listed.body.includes('salesforce-test-secret'));
    const bob = await store.upsertGithubUser('1002', 'bob');
    const session = await store.createSession(bob.id);
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/tenants/${tenantId}/salesforce`,
          headers: { authorization: `Bearer ${session.token}` },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/deploy', headers })).statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/workspaces', headers })).statusCode,
      404,
    );
    await app.inject({ method: 'POST', url: '/api/v1/logout', headers });
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/v1/session', headers })).statusCode,
      401,
    );
  } finally {
    await app.close();
    await database.close();
  }
});

test('hosted API rejects unknown origins, open redirects, missing sign-in and unconfigured integrations', async () => {
  const { database, store } = await testDatabase();
  const key = randomBytes(32);
  const config = readRuntimeConfig({
    BRANCHLIGHT_MODE: 'sandbox-demo',
    BRANCHLIGHT_PUBLIC_API_URL: 'https://api.example.test',
    BRANCHLIGHT_ALLOWED_EXTENSION_IDS: 'a'.repeat(32),
    DATABASE_URL: 'postgresql://localhost/test',
    BRANCHLIGHT_ENCRYPTION_KEY: key.toString('base64'),
  });
  const app = await createHostedApp({
    config,
    store,
    vault: new SecretVault('primary', new Map([['primary', key]])),
  });
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/tenants' })).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: '/api/health',
          headers: { origin: 'https://evil.example' },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/auth/github/start',
          payload: { returnUrl: 'https://evil.example/', challenge: 'a'.repeat(43) },
        })
      ).statusCode,
      503,
    );
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/v1/capabilities' })).json()
        .productionDeployment,
      false,
    );
  } finally {
    await app.close();
    await database.close();
  }
});
