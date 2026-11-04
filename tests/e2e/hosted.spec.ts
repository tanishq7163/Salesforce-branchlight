import { test, expect, chromium } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

test.use({ baseURL: 'http://127.0.0.1:5174' });

test('hosted onboarding signs in, binds a repository, connects an org and clears its session on sign-out', async ({
  page,
}, info) => {
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const tenants: { id: string; name: string; role: string }[] = [];
  let bound = false;
  let connected = false;
  await page.addInitScript(() => {
    const identity = {
      getRedirectURL() {
        return `https://${'a'.repeat(32)}.chromiumapp.org/`;
      },
      async launchWebAuthFlow(details: { url: string }) {
        return details.url.includes('github.com')
          ? `${identity.getRedirectURL()}#code=browser-test-code`
          : `${identity.getRedirectURL()}#connection_code=browser-connection-code`;
      },
    };
    if (!globalThis.chrome) Object.defineProperty(globalThis, 'chrome', { value: {} });
    Object.defineProperty(globalThis.chrome, 'identity', { value: identity, configurable: true });
  });
  await page.route('https://api.example.test/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let result: unknown;
    if (path === '/api/v1/capabilities')
      result = {
        mode: 'sandbox-demo',
        githubSignIn: true,
        salesforceConnections: true,
        githubInstallUrl: 'https://github.com/apps/branchlight-test/installations/new',
        hostedWorkspaces: false,
        productionDeployment: false,
      };
    else if (path === '/auth/github/start') {
      expect(request.postDataJSON().challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
      result = { authorizationUrl: 'https://github.com/login/oauth/authorize?state=test-state' };
    } else if (path === '/auth/exchange') {
      expect(request.postDataJSON().verifier).toHaveLength(64);
      result = {
        token: 'browser-test-session',
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      };
    } else if (path === '/api/v1/session') result = { user: { id: 'alice', login: 'alice' } };
    else if (path === '/api/v1/tenants') {
      if (request.method() === 'POST') {
        const tenant = { id: tenantId, name: request.postDataJSON().name, role: 'admin' };
        tenants.push(tenant);
        result = tenant;
      } else result = tenants;
    } else if (path.endsWith('/github/repositories'))
      result = [
        {
          id: 100,
          installationId: 20,
          name: 'acme/private-source',
          private: true,
          defaultBranch: 'main',
          url: 'https://github.com/acme/private-source',
        },
      ];
    else if (path.endsWith('/repositories')) {
      if (request.method() === 'POST') {
        expect(request.postDataJSON().githubId).toBe(100);
        bound = true;
        result = { id: 'repository' };
      } else
        result = bound
          ? [{ id: 'repository', full_name: 'acme/private-source', default_branch: 'main' }]
          : [];
    } else if (path.endsWith('/salesforce/start')) {
      result = {
        authorizationUrl: 'https://test.salesforce.com/services/oauth2/authorize?state=test-state',
      };
    } else if (path === '/api/v1/salesforce/complete') {
      connected = true;
      result = { connected: true, tenantId, id: 'connection' };
    } else if (path.endsWith('/salesforce'))
      result = connected
        ? [
            {
              id: 'connection',
              label: 'Acme Developer Sandbox',
              environment: 'sandbox',
              external_id: '00D000000000001AAA',
            },
          ]
        : [];
    else if (path === '/api/v1/logout') result = { signedOut: true };
    else throw new Error(`Unexpected hosted test request: ${path}`);
    await route.fulfill({ json: result, headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click();
  await expect(page.locator('.hosted-account')).toContainText('alice');
  await page.getByLabel('New organization').fill('Acme Test Team');
  await page.getByRole('button', { name: 'Create organization', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Acme Test Team' })).toBeVisible();
  await page.getByRole('button', { name: 'Find repositories', exact: true }).click();
  await page.getByRole('combobox', { name: 'Repository', exact: true }).selectOption('100');
  await page.getByRole('button', { name: 'Connect repository', exact: true }).click();
  await expect(page.locator('.hosted-resource-list')).toContainText(['acme/private-source']);
  await page.getByRole('button', { name: 'Connect Salesforce', exact: true }).click();
  await expect(page.getByText('Acme Developer Sandbox', { exact: true })).toBeVisible();
  await expect(page.locator('.org-environment')).toHaveText('sandbox');
  await page.screenshot({ path: info.outputPath('hosted-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('hosted-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Sign in with GitHub', exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        Object.keys(sessionStorage).filter((key) => key.startsWith('branchlight.app-session:'))
          .length,
    ),
  ).toBe(0);
});

test('unconfigured hosted integrations are visibly disabled rather than simulated', async ({
  page,
}) => {
  await page.route('https://api.example.test/**', (route) =>
    route.fulfill({
      json: {
        mode: 'sandbox-demo',
        githubSignIn: false,
        salesforceConnections: false,
        githubInstallUrl: null,
        hostedWorkspaces: false,
        productionDeployment: false,
      },
      headers: { 'Access-Control-Allow-Origin': '*' },
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeDisabled();
  await expect(
    page.getByText('GitHub App registration is not configured.', { exact: true }),
  ).toBeVisible();
});

test('packaged hosted extension has HTTPS-only permissions and loads its identity-enabled screen under MV3', async ({}, info) => {
  const extensionPath = info.outputPath('packaged-extension');
  await promisify(execFile)(
    process.execPath,
    [resolve('node_modules/vite/bin/vite.js'), 'build', '--outDir', extensionPath],
    {
      cwd: process.cwd(),
      env: { ...process.env, VITE_BRANCHLIGHT_API_URL: 'https://api.example.test' },
      timeout: 60_000,
    },
  );
  const manifest = JSON.parse(await readFile(resolve(extensionPath, 'manifest.json'), 'utf8'));
  expect(manifest.host_permissions).toEqual(['https://api.example.test/*']);
  expect(manifest.permissions).toEqual(['identity', 'storage']);
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  try {
    await context.route('https://api.example.test/**', (route) =>
      route.fulfill({
        json: {
          mode: 'sandbox-demo',
          githubSignIn: false,
          salesforceConnections: false,
          githubInstallUrl: null,
          hostedWorkspaces: false,
          productionDeployment: false,
        },
        headers: { 'Access-Control-Allow-Origin': '*' },
      }),
    );
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();
    await expect(
      page.getByText('GitHub App registration is not configured.', { exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => Boolean(chrome.identity && chrome.storage.session))).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath('hosted-extension.png'), fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
