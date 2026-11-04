import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { simpleGit } from 'simple-git';
import { z } from 'zod';
import { GitWorkspace, WorkspaceError } from './gitWorkspace.ts';

type AppOptions = {
  token: string;
  directory: string;
  allowedOrigins?: string[];
  localRepository?: string;
};

const branchSchema = z.string().min(1).max(150);
const workspaceParameters = z.object({ id: z.uuid() });
const stageSchema = z.object({
  branch: branchSchema,
  path: z.string().min(1).max(500),
  content: z.string().max(2_000_000),
  expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
  resolveConflict: z.boolean().optional(),
});

const starterFiles: Record<string, string> = {
  'sfdx-project.json': JSON.stringify(
    {
      packageDirectories: [{ path: 'force-app', default: true }],
      namespace: '',
      sourceApiVersion: '66.0',
    },
    null,
    2,
  ),
  'force-app/main/default/lwc/invoiceList/invoiceList.js':
    "import { LightningElement, api } from 'lwc';\n\nexport default class InvoiceList extends LightningElement {\n  @api accountId;\n  invoices = [];\n\n  get hasInvoices() {\n    return this.invoices.length > 0;\n  }\n}\n",
  'force-app/main/default/lwc/invoiceList/invoiceList.html':
    '<template>\n  <lightning-card title="Invoices" icon-name="standard:orders">\n    <template lwc:if={hasInvoices}>\n      <template for:each={invoices} for:item="invoice">\n        <p key={invoice.Id}>{invoice.Name}</p>\n      </template>\n    </template>\n  </lightning-card>\n</template>\n',
  'force-app/main/default/lwc/invoiceList/invoiceList.css': ':host {\n  display: block;\n}\n',
  'force-app/main/default/lwc/invoiceList/invoiceList.js-meta.xml':
    '<?xml version="1.0" encoding="UTF-8"?>\n<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata">\n  <apiVersion>66.0</apiVersion>\n  <isExposed>true</isExposed>\n  <targets><target>lightning__RecordPage</target></targets>\n</LightningComponentBundle>\n',
  'force-app/main/default/classes/InvoiceService.cls':
    'public with sharing class InvoiceService {\n  @AuraEnabled(cacheable=true)\n  public static List<Account> getAccounts() {\n    return [SELECT Id, Name FROM Account WITH USER_MODE LIMIT 20];\n  }\n}\n',
  'force-app/main/default/classes/InvoiceService.cls-meta.xml':
    '<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">\n  <apiVersion>66.0</apiVersion>\n  <status>Active</status>\n</ApexClass>\n',
};

export async function createApp(options: AppOptions) {
  const app = Fastify({ bodyLimit: 2_200_000, logger: false });
  const workspaceRoot = join(resolve(options.directory), 'workspaces');
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(join(workspaceRoot, 'disabled-hooks'), { recursive: true });
  const allowedOrigins = new Set(
    options.allowedOrigins ?? ['http://127.0.0.1:5173', 'http://localhost:5173'],
  );
  await app.register(cors, {
    origin: (origin, callback) => callback(null, Boolean(origin && allowedOrigins.has(origin))),
    methods: ['GET', 'POST'],
    allowedHeaders: ['Authorization', 'Content-Type'],
  });

  const expectedToken = createHash('sha256').update(options.token).digest();
  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'OPTIONS') return;
    if (request.headers.origin && !allowedOrigins.has(request.headers.origin)) {
      return reply
        .code(403)
        .send({ error: 'This browser origin is not paired with the local service.' });
    }
    if (
      !request.headers.authorization?.startsWith('Bearer ') ||
      !timingSafeEqual(
        createHash('sha256').update(request.headers.authorization.slice(7)).digest(),
        expectedToken,
      )
    ) {
      return reply.code(401).send({ error: 'Pair with the local service before using Git.' });
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({ error: 'Invalid request fields.' });
    if (error instanceof WorkspaceError)
      return reply.code(error.statusCode).send({ error: error.message });
    const message = error instanceof Error ? error.message : 'Operation failed.';
    const safeMessage = message.replace(/https:\/\/[^\s/@]+:[^\s/@]+@/g, 'https://[redacted]@');
    return reply.code(409).send({ error: safeMessage.slice(0, 1200) });
  });

  const workspaces = new Map<string, GitWorkspace>();
  async function load(id: string): Promise<GitWorkspace> {
    const existing = workspaces.get(id);
    if (existing) return existing;
    try {
      const descriptor = z
        .object({ repository: z.string() })
        .parse(JSON.parse(await readFile(join(workspaceRoot, id, 'descriptor.json'), 'utf8')));
      const workspace = new GitWorkspace(
        join(workspaceRoot, id, 'repository'),
        id,
        descriptor.repository,
      );
      workspaces.set(id, workspace);
      return workspace;
    } catch {
      throw new WorkspaceError('Workspace not found.', 404);
    }
  }

  async function clone(
    repository: string,
    authorName: string,
    authorEmail: string,
    source = repository,
  ) {
    const id = randomUUID();
    const directory = join(workspaceRoot, id);
    await mkdir(directory);
    try {
      await simpleGit({
        config: ['core.hooksPath=' + join(workspaceRoot, 'disabled-hooks'), 'core.fsmonitor=false'],
        unsafe: { allowUnsafeHooksPath: true, allowUnsafeFsMonitor: true },
        timeout: { block: 60_000 },
      }).clone(source, join(directory, 'repository'));
      const workspace = new GitWorkspace(join(directory, 'repository'), id, repository);
      await workspace.git.addConfig('user.name', authorName);
      await workspace.git.addConfig('user.email', authorEmail);
      await writeFile(join(directory, 'descriptor.json'), JSON.stringify({ repository }), 'utf8');
      workspaces.set(id, workspace);
      return workspace.view();
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  app.get('/api/health', async () => ({
    name: 'Branchlight local Git service',
    productionDeployment: false,
  }));
  app.get('/api/workspaces', async () => {
    const directories = await readdir(workspaceRoot, { withFileTypes: true });
    const result: { id: string; repository: string }[] = [];
    for (const entry of directories) {
      if (!entry.isDirectory() || !z.uuid().safeParse(entry.name).success) continue;
      try {
        const workspace = await load(entry.name);
        result.push({ id: workspace.id, repository: workspace.repository });
      } catch {
        continue;
      }
    }
    return result;
  });

  const cloneSchema = z.object({
    repository: z.string().max(500),
    authorName: z.string().trim().min(1).max(100),
    authorEmail: z.email().max(200),
  });
  app.post('/api/workspaces', async (request) => {
    const body = cloneSchema.parse(request.body);
    const github = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(
      body.repository,
    );
    const allowedLocal =
      options.localRepository && resolve(body.repository) === resolve(options.localRepository);
    if (!github && !allowedLocal)
      throw new WorkspaceError(
        'Use an HTTPS GitHub repository URL without embedded credentials.',
        400,
      );
    return clone(body.repository, body.authorName, body.authorEmail);
  });

  let starterCreation: Promise<string> | undefined;
  app.post('/api/starter', async () => {
    starterCreation ??= (async () => {
      const source = join(resolve(options.directory), 'starter-source');
      await mkdir(source, { recursive: true });
      const git = simpleGit(source);
      if (!(await git.checkIsRepo())) {
        await git.init(['--initial-branch=main']);
        await git.addConfig('user.name', 'Local Developer');
        await git.addConfig('user.email', 'local@example.test');
        for (const [path, content] of Object.entries(starterFiles)) {
          await mkdir(join(source, path, '..'), { recursive: true });
          await writeFile(join(source, path), content, 'utf8');
        }
        await git.add('.');
        await git.commit('Local Salesforce source example');
      }
      const bare = join(resolve(options.directory), 'starter-remote.git');
      try {
        await readFile(join(bare, 'HEAD'));
      } catch {
        await simpleGit().clone(source, bare, ['--bare']);
      }
      return bare;
    })();
    const workspace = await clone(
      'local://salesforce-example',
      'Local Developer',
      'local@example.test',
      await starterCreation,
    );
    const loaded = await load(workspace.id);
    await loaded.checkout(`feature/my-work-${workspace.id.slice(0, 8)}`, 'main', true);
    return loaded.view();
  });

  app.get('/api/workspaces/:id', async (request) =>
    (await load(workspaceParameters.parse(request.params).id)).view(),
  );
  app.get('/api/workspaces/:id/file', async (request) => {
    const query = z
      .object({ branch: branchSchema, path: z.string().max(500) })
      .parse(request.query);
    return (await load(workspaceParameters.parse(request.params).id)).file(
      query.path,
      query.branch,
    );
  });
  app.get('/api/workspaces/:id/conflict', async (request) => {
    const query = z
      .object({ branch: branchSchema, path: z.string().max(500) })
      .parse(request.query);
    return (await load(workspaceParameters.parse(request.params).id)).conflict(
      query.path,
      query.branch,
    );
  });
  app.post('/api/workspaces/:id/stage', async (request) => {
    const body = stageSchema.parse(request.body);
    const workspace = await load(workspaceParameters.parse(request.params).id);
    await workspace.stage(
      body.path,
      body.content,
      body.expectedHash,
      body.branch,
      body.resolveConflict,
    );
    return workspace.view();
  });
  app.post('/api/workspaces/:id/unstage', async (request) => {
    const body = z.object({ branch: branchSchema, path: z.string().max(500) }).parse(request.body);
    const workspace = await load(workspaceParameters.parse(request.params).id);
    await workspace.unstage(body.path, body.branch);
    return workspace.view();
  });
  app.post('/api/workspaces/:id/commit', async (request) => {
    const body = z
      .object({
        branch: branchSchema,
        message: z.string().min(1).max(1000),
        head: z.string().regex(/^[a-f0-9]{40,64}$/),
        indexTree: z.string().regex(/^[a-f0-9]{40,64}$/),
      })
      .parse(request.body);
    const workspace = await load(workspaceParameters.parse(request.params).id);
    await workspace.commit(body.message, body.branch, body.head, body.indexTree);
    return workspace.view();
  });
  app.post('/api/workspaces/:id/checkout', async (request) => {
    const body = z
      .object({
        branch: branchSchema,
        expectedBranch: branchSchema,
        create: z.boolean().optional(),
      })
      .parse(request.body);
    const workspace = await load(workspaceParameters.parse(request.params).id);
    await workspace.checkout(body.branch, body.expectedBranch, body.create);
    return workspace.view();
  });
  for (const action of ['push', 'pull', 'fetch', 'abortMerge'] as const) {
    app.post(`/api/workspaces/:id/${action}`, async (request) => {
      const body = z.object({ branch: branchSchema }).parse(request.body);
      const workspace = await load(workspaceParameters.parse(request.params).id);
      if (action === 'fetch') await workspace.fetch();
      else await workspace[action](body.branch);
      return workspace.view();
    });
  }
  app.post('/api/workspaces/:id/merge', async (request) => {
    const body = z.object({ source: branchSchema, branch: branchSchema }).parse(request.body);
    const workspace = await load(workspaceParameters.parse(request.params).id);
    await workspace.merge(body.source, body.branch);
    return workspace.view();
  });
  app.post('/api/deploy', async (_request, reply) =>
    reply.code(403).send({
      error:
        'Salesforce deployment is disabled. No org credentials or deployment adapter are configured.',
    }),
  );
  return app;
}
