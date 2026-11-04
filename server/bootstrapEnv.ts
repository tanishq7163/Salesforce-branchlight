import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function initializeEnvironment(target: string, template: string) {
  const values = parseEnv(template);
  values.BRANCHLIGHT_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  values.BRANCHLIGHT_DEV_DATABASE_PASSWORD = randomBytes(24).toString('hex');
  values.DATABASE_URL = `postgresql://branchlight_owner:${values.BRANCHLIGHT_DEV_DATABASE_PASSWORD}@127.0.0.1:54329/branchlight`;
  const content =
    Object.entries(values)
      .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
      .join('\n') + '\n';
  await writeFile(target, content, { flag: 'wx', mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await initializeEnvironment(resolve('.env'), await readFile(resolve('.env.example'), 'utf8'));
    console.log(
      'Created private local settings in .env. Secrets were not printed. Keep the encryption key backed up securely.',
    );
  } catch (error) {
    console.error(
      error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST'
        ? '.env already exists and was left unchanged.'
        : 'Environment initialization failed. Check the template and filesystem permissions.',
    );
    process.exitCode = 1;
  }
}
