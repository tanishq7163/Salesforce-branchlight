import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createApp } from './app.ts';
import { Pool } from 'pg';
import { readRuntimeConfig } from './config.ts';
import { Store } from './database/store.ts';
import { SecretVault } from './security/vault.ts';
import { createHostedApp } from './hostedApp.ts';
import { GithubProvider, SalesforceProvider } from './integrations/providers.ts';

async function start() {
  const config = readRuntimeConfig(process.env);
  if (config.mode !== 'local') {
    const pool = new Pool({
      connectionString: config.databaseUrl,
      max: 10,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
    });
    pool.on('error', () =>
      console.error('Database connection error. Reconnecting on the next request.'),
    );
    try {
      const store = new Store(pool);
      const schema = await store.transaction((connection) =>
        connection.query<{ version: number }>(
          'SELECT max(version) AS version FROM schema_migrations',
        ),
      );
      if (schema.rows[0]?.version !== 3)
        throw new Error('Database migrations must run before hosted startup.');
      if (config.mode === 'production') await store.assertRuntimeRole();
      const vault = new SecretVault('primary', new Map([['primary', config.encryptionKey!]]));
      function providerConfig(name: 'GITHUB' | 'SALESFORCE') {
        const clientId = process.env[`${name}_CLIENT_ID`];
        const clientSecret = process.env[`${name}_CLIENT_SECRET`];
        if (Boolean(clientId) !== Boolean(clientSecret))
          throw new Error(`${name} client ID and secret must be configured together.`);
        return clientId && clientSecret
          ? {
              clientId,
              clientSecret,
              redirectUrl: `${config.publicApiUrl}/auth/${name.toLowerCase()}/callback`,
            }
          : undefined;
      }
      const github = providerConfig('GITHUB');
      const salesforce = providerConfig('SALESFORCE');
      const slug = process.env.GITHUB_APP_SLUG;
      if (slug && !/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error('Invalid GitHub App slug.');
      const app = await createHostedApp({
        config,
        store,
        vault,
        github: github ? new GithubProvider(github) : undefined,
        salesforce: salesforce ? new SalesforceProvider(salesforce) : undefined,
        githubInstallUrl: slug ? `https://github.com/apps/${slug}/installations/new` : undefined,
      });
      app.addHook('onClose', async () => {
        await pool.end();
      });
      await app.listen({ host: config.host, port: config.port });
      console.log(
        `Branchlight ${config.mode} API listening on port ${config.port}. Production deployment: disabled.`,
      );
      for (const signal of ['SIGINT', 'SIGTERM'] as const)
        process.once(signal, async () => {
          await app.close();
        });
      return;
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw error;
    }
  }
  const directory = resolve('.branchlight');
  const token = randomBytes(32).toString('hex');
  const port = config.port;
  const editorUrl = config.editorUrl;
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'pairing-token'), token, { mode: 0o600 });
  const app = await createApp({
    token,
    directory,
    allowedOrigins: config.allowedOrigins,
  });
  await app.listen({ host: '127.0.0.1', port });
  const pairingUrl = `${editorUrl}/#pair=${token}&api=${encodeURIComponent(`http://127.0.0.1:${port}`)}`;
  await writeFile(
    join(directory, 'open-studio.html'),
    `<!doctype html><meta charset="utf-8"><title>Open Branchlight</title><script>location.replace(${JSON.stringify(pairingUrl)})</script><a href="${pairingUrl}">Open Branchlight Studio</a>`,
    { mode: 0o600 },
  );
  console.log(`Local Git service: http://127.0.0.1:${port}`);
  console.log('Pairing launcher: .branchlight/open-studio.html (token is not logged).');
  console.log(
    'Production deployment: disabled. This service is for one local developer, not shared hosting.',
  );
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, async () => {
      await app.close();
      process.exit(0);
    });
  }
}

start().catch((error: unknown) => {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  console.error(
    code === 'EADDRINUSE'
      ? 'The configured API port is already in use. Stop the existing service or choose another port.'
      : 'Backend startup failed. Check runtime mode, required environment settings, database connectivity and migrations. Credentials are not logged.',
  );
  process.exitCode = 1;
});
