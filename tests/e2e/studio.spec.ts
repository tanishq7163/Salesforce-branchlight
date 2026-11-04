import { test, expect, chromium } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

async function edit(page: Page, marker: string) {
  await page
    .locator('.monaco-editor')
    .first()
    .click({ position: { x: 150, y: 40 } });
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type(`// ${marker}`);
  await expect(page.locator('.view-lines').first()).toContainText(marker);
}

async function pair(page: Page) {
  const token = (await readFile(resolve('.branchlight/pairing-token'), 'utf8')).trim();
  await page.getByRole('button', { name: 'Pair service', exact: true }).click();
  await page.getByLabel('Pairing token').fill(token);
  await page.getByRole('dialog').getByRole('button', { name: 'Pair service', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.connection-status')).toContainText('connected');
}

test('Ctrl+S persists only a local draft, survives reload and sends no network writes', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('.monaco-editor textarea').first()).toBeAttached();
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET') writes.push(request.url());
  });
  await edit(page, 'browserOnlyDraft');
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('status')).toContainText('Draft saved on this device');
  expect(writes).toEqual([]);
  await page.reload();
  await expect(page.locator('.view-lines').first()).toContainText('browserOnlyDraft');
  await expect(page.getByRole('button', { name: 'Deploy approved release' })).toBeDisabled();
  await page.screenshot({ path: info.outputPath('desktop.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('saved branch drafts stay isolated and the UI stages, commits and pushes through real Git', async ({
  page,
}) => {
  await page.goto('/');
  await pair(page);
  await page.getByRole('button', { name: 'Create local Git example' }).click();
  await expect(page.getByRole('combobox', { name: 'Branch', exact: true })).toHaveValue(
    /^feature\/my-work-/,
  );
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeEnabled();
  const originalBranch = `feature/ui-${Date.now()}`;
  await page.getByRole('button', { name: 'Create branch', exact: true }).click();
  await page.getByLabel('Branch name').fill(originalBranch);
  await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Branch', exact: true })).toHaveValue(
    originalBranch,
  );
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeEnabled();
  await edit(page, 'isolatedBranchDraft');
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/') && request.method() === 'POST') writes.push(request.url());
  });
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('status')).toContainText('Draft saved on this device');
  expect(writes).toEqual([]);
  await page.getByRole('button', { name: 'Create branch', exact: true }).click();
  await page.getByLabel('Branch name').fill('feature/isolated');
  await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Branch', exact: true })).toHaveValue(
    'feature/isolated',
  );
  await expect(page.locator('.view-lines').first()).not.toContainText('isolatedBranchDraft');
  await page.getByRole('combobox', { name: 'Branch', exact: true }).selectOption(originalBranch);
  await expect(page.locator('.view-lines').first()).toContainText('isolatedBranchDraft');
  await page.getByRole('button', { name: 'Stage file', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('File staged in Git');
  await page.getByRole('textbox', { name: 'Commit message' }).fill('UI reviewed source change');
  await page.getByRole('button', { name: 'Commit staged', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Staged changes committed locally');
  await page.getByRole('button', { name: 'Push branch', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Branch pushed to remote');
  await expect(page.locator('.clean-state')).toContainText('Working tree clean');
  await page.getByRole('button', { name: 'Commit history', exact: true }).click();
  await expect(page.locator('.history-list')).toContainText('UI reviewed source change');
});

test('mobile layout stays within the viewport and exposes branch controls', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('.monaco-editor textarea').first()).toBeAttached();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Explorer', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Find file' })).toBeVisible();
  await page.getByRole('button', { name: 'Branch workflow', exact: true }).click();
  const tooltip = page
    .getByRole('button', { name: 'Branch workflow', exact: true })
    .locator('.tooltip');
  const bounds = await tooltip.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await expect(page.getByRole('button', { name: 'Commit staged', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Commit staged', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Branch workflow', exact: true }).click();
  await page.mouse.move(380, 40);
  await page.screenshot({ path: info.outputPath('mobile.png'), fullPage: true });
});

test('a saved new file remains discoverable after closing its tab and reloading', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.monaco-editor textarea').first()).toBeAttached();
  await page.getByRole('button', { name: 'New file', exact: true }).click();
  await page.getByLabel('Source path').fill('force-app/main/default/classes/NewDraft.cls');
  await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'NewDraft.cls' })).toBeVisible();
  await edit(page, 'recoveredNewFile');
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('status')).toContainText('Draft saved on this device');
  await page.getByRole('button', { name: 'Close NewDraft.cls', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'NewDraft.cls', exact: true }).click();
  await expect(page.locator('.view-lines').first()).toContainText('recoveredNewFile');
});

test('the built MV3 extension loads the editor with packaged workers and no CSP errors', async ({}, info) => {
  const extensionPath = resolve('dist');
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 900 },
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto(`chrome-extension://${extensionId}/index.html`);
    await expect(page.locator('.view-lines').first()).toContainText('LightningElement');
    await page.getByRole('button', { name: 'Diff view', exact: true }).click();
    await expect(page.locator('.monaco-diff-editor')).toBeVisible();
    await page.screenshot({ path: info.outputPath('extension.png'), fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('the development server refuses runtime-directory files', async ({ request }) => {
  const path = resolve('.branchlight/dev-server-probe.txt');
  await writeFile(path, 'non-secret runtime probe', { flag: 'wx' });
  try {
    const response = await request.get('/.branchlight/dev-server-probe.txt');
    expect(response.status()).toBe(403);
  } finally {
    await rm(path);
  }
});
