import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { initializeEnvironment } from '../server/bootstrapEnv.ts';

test('environment initialization creates independent secrets and never overwrites existing settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'branchlight-env-'));
  try {
    const target = join(directory, '.env');
    const template = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
    await initializeEnvironment(target, template);
    const first = await readFile(target, 'utf8');
    const values = parseEnv(first);
    assert.equal(Buffer.from(values.BRANCHLIGHT_ENCRYPTION_KEY!, 'base64').length, 32);
    assert.match(values.BRANCHLIGHT_DEV_DATABASE_PASSWORD!, /^[a-f0-9]{48}$/);
    assert.equal(values.BRANCHLIGHT_MODE, 'local');
    await assert.rejects(initializeEnvironment(target, template));
    assert.equal(await readFile(target, 'utf8'), first);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Render blueprint is sandbox-only, uses paid durable service types and keeps its database private', async () => {
  const blueprint = parse(await readFile(new URL('../render.yaml', import.meta.url), 'utf8'));
  assert.equal(
    blueprint.envVarGroups[0].envVars.find(
      (entry: { key: string }) => entry.key === 'BRANCHLIGHT_MODE',
    ).value,
    'sandbox-demo',
  );
  assert.deepEqual(blueprint.databases[0].ipAllowList, []);
  assert.notEqual(blueprint.databases[0].plan, 'free');
  assert.deepEqual(
    blueprint.services.map((service: { type: string }) => service.type),
    ['web', 'worker'],
  );
  assert.ok(blueprint.services.every((service: { plan: string }) => service.plan !== 'free'));
  const ignored = await readFile(new URL('../.dockerignore', import.meta.url), 'utf8');
  assert.ok(ignored.includes('.branchlight'));
  assert.ok(ignored.includes('.env'));
});
