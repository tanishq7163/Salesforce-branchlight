import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SalesforceProvider,
  salesforceAuthority,
  GithubProvider,
} from '../server/integrations/providers.ts';

test('Salesforce OAuth endpoints reject arbitrary hosts, embedded credentials and path tricks', () => {
  for (const value of [
    'http://test.salesforce.com',
    'https://test.salesforce.com.evil.example',
    'https://user:secret@test.salesforce.com',
    'https://127.0.0.1',
    'https://test.salesforce.com/other',
    'https://test.salesforce.com:8443',
  ]) {
    assert.throws(() => salesforceAuthority(value));
  }
  assert.equal(
    salesforceAuthority('https://acme--dev.sandbox.my.salesforce.com'),
    'https://acme--dev.sandbox.my.salesforce.com',
  );
});

test('authorization URLs bind state, callback and PKCE without exposing client secrets', () => {
  const github = new GithubProvider({
    clientId: 'client',
    clientSecret: 'test-secret',
    redirectUrl: 'https://api.example.test/auth/github/callback',
  });
  const salesforce = new SalesforceProvider({
    clientId: 'client',
    clientSecret: 'test-secret',
    redirectUrl: 'https://api.example.test/auth/salesforce/callback',
  });
  for (const url of [
    github.authorizationUrl('state', 'challenge'),
    salesforce.authorizationUrl('https://test.salesforce.com', 'state', 'challenge'),
  ]) {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('state'), 'state');
    assert.equal(parsed.searchParams.get('code_challenge'), 'challenge');
    assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(!url.includes('test-secret'));
  }
});

test('Salesforce demo connections verify the actual org identity and revoke rejected production grants', async () => {
  for (const sandbox of [true, false]) {
    const requests: string[] = [];
    const transport: typeof fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith('/token'))
        return Response.json({
          access_token: 'test-access',
          refresh_token: 'test-refresh',
          instance_url: 'https://acme.my.salesforce.com',
        });
      if (url.endsWith('/userinfo'))
        return Response.json({
          organization_id: '00D000000000001AAA',
          user_id: '005000000000001AAA',
        });
      if (url.includes('/query?'))
        return Response.json({
          records: [{ Id: '00D000000000001AAA', Name: 'Acme', IsSandbox: sandbox }],
        });
      if (url.endsWith('/revoke')) return new Response(null, { status: 200 });
      throw new Error('Unexpected request.');
    };
    const provider = new SalesforceProvider({
      clientId: 'client',
      clientSecret: 'test-secret',
      redirectUrl: 'https://api.example.test/auth/salesforce/callback',
      transport,
    });
    if (sandbox) {
      const grant = await provider.exchange(
        'https://test.salesforce.com',
        'code',
        'verifier',
        true,
      );
      assert.equal(grant.sandbox, true);
      assert.equal(grant.label, 'Acme');
    } else {
      await assert.rejects(
        provider.exchange('https://test.salesforce.com', 'code', 'verifier', true),
        /cannot connect production/,
      );
      assert.ok(requests.some((url) => url.endsWith('/revoke')));
    }
    assert.ok(
      requests.every((url) => !url.includes('test-access') && !url.includes('test-refresh')),
    );
  }
});

test('GitHub code exchange sends PKCE in the request body and uses the resulting user grant', async () => {
  const transport: typeof fetch = async (input, options) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === 'https://github.com/login/oauth/access_token') {
      assert.equal(options?.method, 'POST');
      const body = new URLSearchParams(String(options?.body));
      assert.equal(body.get('code_verifier'), 'test-verifier');
      assert.equal(body.get('redirect_uri'), 'https://api.example.test/auth/github/callback');
      assert.ok(!url.includes('client-secret'));
      return Response.json({
        access_token: 'test-user-token',
        refresh_token: 'test-refresh',
        expires_in: 28800,
      });
    }
    assert.equal(url, 'https://api.github.com/user');
    return Response.json({ id: 1001, login: 'alice' });
  };
  const provider = new GithubProvider({
    clientId: 'client',
    clientSecret: 'client-secret',
    redirectUrl: 'https://api.example.test/auth/github/callback',
    transport,
  });
  const result = await provider.exchange('test-code', 'test-verifier');
  assert.equal(result.user.id, '1001');
  assert.equal(result.grant.token, 'test-user-token');
  assert.ok(result.grant.expiresAt);
});
