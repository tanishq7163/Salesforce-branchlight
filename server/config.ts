import { z } from 'zod';

const modeSchema = z.enum(['local', 'sandbox-demo', 'production']);
const extensionIdSchema = z.string().regex(/^[a-p]{32}$/);

export type RuntimeConfig = {
  mode: z.infer<typeof modeSchema>;
  host: string;
  port: number;
  publicApiUrl: string;
  editorUrl: string;
  allowedOrigins: string[];
  databaseUrl?: string;
  encryptionKey?: Buffer;
  productionDeployment: false;
};

function parseUrl(value: string, field: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${field} must be a valid URL. Its value is not logged.`);
  }
}

function httpsOrigin(value: string | undefined, field: string): string {
  if (!value) throw new Error(`${field} is required in hosted mode.`);
  const parsed = parseUrl(value, field);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${field} must be an HTTPS origin without credentials or a path.`);
  }
  return parsed.origin;
}

export function readRuntimeConfig(environment: NodeJS.ProcessEnv): RuntimeConfig {
  const mode = modeSchema.parse(environment.BRANCHLIGHT_MODE ?? 'local');
  const port = z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .parse(environment.PORT ?? environment.BRANCHLIGHT_API_PORT ?? '8787');
  const ids = (
    environment.BRANCHLIGHT_ALLOWED_EXTENSION_IDS ??
    environment.BRANCHLIGHT_EXTENSION_ID ??
    ''
  )
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => extensionIdSchema.parse(value));
  const allowedOrigins = ids.map((id) => `chrome-extension://${id}`);

  if (mode === 'local') {
    const editor = parseUrl(
      environment.BRANCHLIGHT_EDITOR_URL ?? 'http://127.0.0.1:5173',
      'BRANCHLIGHT_EDITOR_URL',
    );
    if (
      editor.protocol !== 'http:' ||
      !['localhost', '127.0.0.1'].includes(editor.hostname) ||
      editor.username ||
      editor.password ||
      editor.pathname !== '/' ||
      editor.search ||
      editor.hash
    ) {
      throw new Error('Local editor must use a loopback HTTP origin.');
    }
    return {
      mode,
      host: '127.0.0.1',
      port,
      publicApiUrl: `http://127.0.0.1:${port}`,
      editorUrl: editor.origin,
      allowedOrigins: [editor.origin, ...allowedOrigins],
      productionDeployment: false,
    };
  }

  const publicApiUrl = httpsOrigin(
    environment.BRANCHLIGHT_PUBLIC_API_URL,
    'BRANCHLIGHT_PUBLIC_API_URL',
  );
  if (environment.BRANCHLIGHT_WEB_ORIGIN)
    allowedOrigins.push(httpsOrigin(environment.BRANCHLIGHT_WEB_ORIGIN, 'BRANCHLIGHT_WEB_ORIGIN'));
  if (!allowedOrigins.length)
    throw new Error('Hosted mode requires an allowed extension ID or HTTPS web origin.');
  const databaseUrl = environment.DATABASE_URL;
  if (
    !databaseUrl ||
    !['postgres:', 'postgresql:'].includes(parseUrl(databaseUrl, 'DATABASE_URL').protocol)
  ) {
    throw new Error('DATABASE_URL must be a PostgreSQL connection URL.');
  }
  const encoded = environment.BRANCHLIGHT_ENCRYPTION_KEY ?? '';
  const encryptionKey = Buffer.from(encoded, 'base64');
  if (encryptionKey.length !== 32 || encryptionKey.toString('base64') !== encoded) {
    throw new Error(
      'BRANCHLIGHT_ENCRYPTION_KEY must encode exactly 32 random bytes in canonical base64.',
    );
  }
  return {
    mode,
    host: '0.0.0.0',
    port,
    publicApiUrl,
    editorUrl: environment.BRANCHLIGHT_WEB_ORIGIN ?? publicApiUrl,
    allowedOrigins: [...new Set(allowedOrigins)],
    databaseUrl,
    encryptionKey,
    productionDeployment: false,
  };
}
