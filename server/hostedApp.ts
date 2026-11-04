import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { Store, AccessError } from './database/store.ts';
import type { User } from './database/store.ts';
import type { RuntimeConfig } from './config.ts';
import { SecretVault } from './security/vault.ts';
import { OAuthStateService } from './auth/oauthState.ts';
import { ConnectionService } from './integrations/connections.ts';
import type { GithubProvider, SalesforceProvider } from './integrations/providers.ts';
import { salesforceAuthority } from './integrations/providers.ts';

type HostedOptions = {
  config: RuntimeConfig;
  store: Store;
  vault: SecretVault;
  github?: Pick<GithubProvider, 'authorizationUrl' | 'exchange' | 'repositories'>;
  salesforce?: Pick<SalesforceProvider, 'authorizationUrl' | 'exchange'>;
  githubInstallUrl?: string;
};

const startSchema = z.object({
  returnUrl: z.url().max(500),
  challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
const callbackSchema = z.object({
  state: z.string().min(20).max(200),
  code: z.string().min(1).max(1000).optional(),
  error: z.string().max(100).optional(),
});
const tenantParams = z.object({ tenantId: z.uuid() });

export async function createHostedApp(options: HostedOptions) {
  if (options.config.mode === 'local')
    throw new Error('Hosted API requires an explicit hosted configuration.');
  const { config, store } = options;
  const app = Fastify({ logger: false, bodyLimit: 256_000, requestTimeout: 30_000 });
  await app.register(helmet, { referrerPolicy: { policy: 'no-referrer' } });
  await app.register(rateLimit, { global: true, max: 120, timeWindow: '1 minute' });
  await app.register(cors, {
    origin: config.allowedOrigins,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Authorization', 'Content-Type'],
  });
  const auth = new OAuthStateService(store, options.vault);
  const connections = new ConnectionService(store, options.vault);
  const origins = new Set(config.allowedOrigins);
  const returnUrls = new Set(
    config.allowedOrigins.map((origin) =>
      origin.startsWith('chrome-extension://')
        ? `https://${origin.slice('chrome-extension://'.length)}.chromiumapp.org/`
        : `${origin}/`,
    ),
  );

  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.headers.origin && !origins.has(request.headers.origin)) {
      return reply.code(403).send({ error: 'Browser origin is not authorized.' });
    }
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AccessError)
      return reply.code(error.statusCode).send({ error: error.message, requestId: request.id });
    if (error instanceof z.ZodError)
      return reply.code(400).send({ error: 'Invalid request fields.', requestId: request.id });
    if (error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 429)
      return reply
        .code(429)
        .send({ error: 'Request limit reached. Try again later.', requestId: request.id });
    return reply.code(502).send({
      error:
        'The service could not complete this operation. Check connection setup or reconnect the provider.',
      requestId: request.id,
    });
  });

  async function user(authorization: string | undefined): Promise<User> {
    if (!authorization?.startsWith('Bearer ') || authorization.length > 200)
      throw new AccessError('Sign in to continue.', 401);
    return store.authenticate(authorization.slice(7));
  }
  function redirectTarget(value: string) {
    if (!returnUrls.has(value))
      throw new AccessError('This sign-in return address is not registered.', 400);
    return value;
  }

  app.get('/api/health', async () => ({
    name: 'Branchlight hosted service',
    mode: config.mode,
    productionDeployment: false,
  }));
  app.get('/api/v1/capabilities', async () => ({
    mode: config.mode,
    githubSignIn: Boolean(options.github),
    salesforceConnections: Boolean(options.salesforce),
    githubInstallUrl: options.githubInstallUrl ?? null,
    hostedWorkspaces: false,
    productionDeployment: false,
    releaseApprovals: false,
  }));

  app.post(
    '/auth/github/start',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request) => {
      if (!options.github)
        throw new AccessError('GitHub App registration is not configured on this deployment.', 503);
      const body = startSchema.parse(request.body);
      const state = await auth.start({
        provider: 'github',
        returnUrl: redirectTarget(body.returnUrl),
        challenge: body.challenge,
        authority: 'https://github.com',
      });
      return { authorizationUrl: options.github.authorizationUrl(state.state, state.challenge) };
    },
  );
  app.get('/auth/github/callback', async (request, reply) => {
    if (!options.github) throw new AccessError('GitHub is not configured.', 503);
    const query = callbackSchema.parse(request.query);
    const state = await auth.consume(query.state, 'github');
    if (query.error || !query.code)
      throw new AccessError('GitHub sign-in was not completed. Start again.', 400);
    const result = await options.github.exchange(query.code, state.verifier);
    const identity = await store.upsertGithubUser(result.user.id, result.user.login);
    await connections.saveGithub(identity.id, result.grant);
    const code = await auth.createHandoff(identity.id, state.challenge);
    const target = new URL(redirectTarget(state.returnUrl));
    target.hash = new URLSearchParams({ code }).toString();
    return reply.redirect(target.href);
  });
  app.post(
    '/auth/exchange',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request) => {
      const body = z
        .object({ code: z.string().min(20).max(100), verifier: z.string().min(43).max(128) })
        .parse(request.body);
      return auth.exchange(body.code, body.verifier);
    },
  );
  app.get('/api/v1/session', async (request) => ({
    user: await user(request.headers.authorization),
  }));
  app.post('/api/v1/logout', async (request) => {
    await user(request.headers.authorization);
    await store.revokeSession(request.headers.authorization!.slice(7));
    return { signedOut: true };
  });
  app.get('/api/v1/tenants', async (request) =>
    store.listTenants((await user(request.headers.authorization)).id),
  );
  app.post('/api/v1/tenants', async (request) => {
    const identity = await user(request.headers.authorization);
    const body = z.object({ name: z.string().trim().min(1).max(100) }).parse(request.body);
    return store.createTenant(identity.id, body.name);
  });

  app.get('/api/v1/tenants/:tenantId/github/repositories', async (request) => {
    const identity = await user(request.headers.authorization);
    const { tenantId } = tenantParams.parse(request.params);
    await store.withTenant(identity.id, tenantId, [], async () => undefined);
    if (!options.github) throw new AccessError('GitHub is not configured.', 503);
    return options.github.repositories(await connections.github(identity.id));
  });
  app.post('/api/v1/tenants/:tenantId/repositories', async (request) => {
    const identity = await user(request.headers.authorization);
    const { tenantId } = tenantParams.parse(request.params);
    const body = z.object({ githubId: z.number().int().positive() }).parse(request.body);
    if (!options.github) throw new AccessError('GitHub is not configured.', 503);
    return {
      id: await connections.bindRepository(identity.id, tenantId, body.githubId, options.github),
    };
  });
  app.get('/api/v1/tenants/:tenantId/repositories', async (request) => {
    const identity = await user(request.headers.authorization);
    return connections.listRepositories(identity.id, tenantParams.parse(request.params).tenantId);
  });

  app.post('/api/v1/tenants/:tenantId/salesforce/start', async (request) => {
    const identity = await user(request.headers.authorization);
    const { tenantId } = tenantParams.parse(request.params);
    await store.withTenant(identity.id, tenantId, [], async () => undefined);
    if (!options.salesforce)
      throw new AccessError(
        'Salesforce External Client App registration is not configured on this deployment.',
        503,
      );
    const body = startSchema.extend({ authority: z.string().max(300) }).parse(request.body);
    const authority = salesforceAuthority(body.authority);
    const state = await auth.start({
      provider: 'salesforce',
      userId: identity.id,
      tenantId,
      authority,
      returnUrl: redirectTarget(body.returnUrl),
      challenge: body.challenge,
    });
    return {
      authorizationUrl: options.salesforce.authorizationUrl(
        authority,
        state.state,
        state.challenge,
      ),
    };
  });
  app.get('/auth/salesforce/callback', async (request, reply) => {
    if (!options.salesforce) throw new AccessError('Salesforce is not configured.', 503);
    const query = callbackSchema.parse(request.query);
    const state = await auth.consume(query.state, 'salesforce');
    if (query.error || !query.code || !state.userId || !state.tenantId)
      throw new AccessError('Salesforce connection was not completed. Start again.', 400);
    await store.withTenant(state.userId, state.tenantId, [], async () => undefined);
    const grant = await options.salesforce.exchange(
      state.authority,
      query.code,
      state.verifier,
      config.mode === 'sandbox-demo',
    );
    if (config.mode === 'sandbox-demo' && !grant.sandbox)
      throw new AccessError('Sandbox demo does not accept production connections.', 403);
    const code = await auth.createConnectionHandoff(
      state.userId,
      state.tenantId,
      state.challenge,
      grant,
    );
    const target = new URL(redirectTarget(state.returnUrl));
    target.hash = new URLSearchParams({ connection_code: code }).toString();
    return reply.redirect(target.href);
  });
  app.post('/api/v1/salesforce/complete', async (request) => {
    const identity = await user(request.headers.authorization);
    const body = z
      .object({ code: z.string().min(20).max(100), verifier: z.string().min(43).max(128) })
      .parse(request.body);
    const pending = await auth.completeConnection(identity.id, body.code, body.verifier);
    const id = await connections.saveSalesforce(identity.id, pending.tenantId, pending.grant);
    return { id, tenantId: pending.tenantId, connected: true };
  });
  app.get('/api/v1/tenants/:tenantId/salesforce', async (request) => {
    const identity = await user(request.headers.authorization);
    return connections.listSalesforce(identity.id, tenantParams.parse(request.params).tenantId);
  });
  app.post('/api/v1/tenants/:tenantId/salesforce/:connectionId/disconnect', async (request) => {
    const identity = await user(request.headers.authorization);
    const params = tenantParams.extend({ connectionId: z.uuid() }).parse(request.params);
    await connections.disconnectSalesforce(identity.id, params.tenantId, params.connectionId);
    return { disconnected: true, upstreamRevocationRequired: true };
  });
  app.get('/api/v1/tenants/:tenantId/audit', async (request) => {
    const identity = await user(request.headers.authorization);
    const { tenantId } = tenantParams.parse(request.params);
    return store.withTenant(
      identity.id,
      tenantId,
      ['admin'],
      async (connection) =>
        (
          await connection.query(
            'SELECT id,user_id,action,resource_id,created_at FROM audit_events WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100',
            [tenantId],
          )
        ).rows,
    );
  });
  app.post('/api/deploy', async (request) => {
    await user(request.headers.authorization);
    throw new AccessError(
      'Deployment remains disabled until artifact validation and release approval gates are implemented.',
      403,
    );
  });
  return app;
}
