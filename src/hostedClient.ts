export type HostedCapabilities = {
  mode: string;
  githubSignIn: boolean;
  salesforceConnections: boolean;
  githubInstallUrl: string | null;
  hostedWorkspaces: boolean;
  productionDeployment: boolean;
};
export type HostedSession = { token: string; expiresAt: string };
export type TenantSummary = { id: string; name: string; role: string };
export type OrgSummary = { id: string; label: string; environment: string; external_id: string };
export type RepoSummary = { id: string; full_name: string; default_branch: string };
export type AvailableRepository = {
  id: number;
  installationId: number;
  name: string;
  private: boolean;
  defaultBranch: string;
  url: string;
};

export function hostedOrigin(value: string, development = false): string {
  const parsed = new URL(value);
  const local =
    development &&
    parsed.protocol === 'http:' &&
    ['localhost', '127.0.0.1'].includes(parsed.hostname);
  if (
    (!local && parsed.protocol !== 'https:') ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('Hosted API must be an HTTPS origin without a path or embedded credentials.');
  }
  return parsed.origin;
}

export async function browserChallenge(verifier: string): Promise<string> {
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
  );
  return btoa(String.fromCharCode(...hash))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function identityAvailable() {
  return typeof chrome !== 'undefined' && Boolean(chrome.identity?.launchWebAuthFlow);
}

export class HostedClient {
  base: string;
  private session: HostedSession | null = null;
  constructor(base: string, development = false) {
    this.base = hostedOrigin(base, development);
  }

  private sessionKey() {
    return `branchlight.app-session:${this.base}`;
  }
  async restore() {
    const key = this.sessionKey();
    const raw =
      typeof chrome !== 'undefined' && chrome.storage?.session
        ? (await chrome.storage.session.get(key))[key]
        : JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (
      raw &&
      typeof raw.token === 'string' &&
      typeof raw.expiresAt === 'string' &&
      Date.parse(raw.expiresAt) > Date.now()
    ) {
      this.session = raw;
      return true;
    }
    await this.clear();
    return false;
  }
  async clear() {
    this.session = null;
    const key = this.sessionKey();
    if (typeof chrome !== 'undefined' && chrome.storage?.session)
      await chrome.storage.session.remove(key);
    else sessionStorage.removeItem(key);
  }
  async request<Result>(path: string, body?: unknown): Promise<Result> {
    const response = await fetch(`${this.base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(25_000),
      headers: {
        ...(this.session ? { Authorization: `Bearer ${this.session.token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 401) await this.clear();
      throw new Error(
        typeof result.error === 'string'
          ? result.error
          : 'The hosted service could not complete the request.',
      );
    }
    return result as Result;
  }

  async finish(returnUrl: string, verifier: string, provider: 'github' | 'salesforce') {
    const returned = new URL(returnUrl);
    const expected = identityAvailable() ? chrome.identity.getRedirectURL() : `${location.origin}/`;
    if (
      returned.origin !== new URL(expected).origin ||
      returned.pathname !== new URL(expected).pathname
    )
      throw new Error('Unexpected authentication return address.');
    const fragment = new URLSearchParams(returned.hash.slice(1));
    if (provider === 'salesforce') {
      const code = fragment.get('connection_code');
      if (!code) throw new Error('Salesforce authorization did not complete.');
      await this.request('/api/v1/salesforce/complete', { code, verifier });
      return;
    }
    const code = fragment.get('code');
    if (!code) throw new Error('The sign-in return code is missing.');
    const session = await this.request<HostedSession>('/auth/exchange', { code, verifier });
    if (!session.token || !Number.isFinite(Date.parse(session.expiresAt)))
      throw new Error('Invalid application session.');
    this.session = session;
    const key = this.sessionKey();
    if (typeof chrome !== 'undefined' && chrome.storage?.session)
      await chrome.storage.session.set({ [key]: session });
    else sessionStorage.setItem(key, JSON.stringify(session));
  }

  async authorize(
    provider: 'github' | 'salesforce',
    tenantId?: string,
    authority = 'https://test.salesforce.com',
  ) {
    const verifier = Array.from(crypto.getRandomValues(new Uint8Array(32)), (value) =>
      value.toString(16).padStart(2, '0'),
    ).join('');
    const returnUrl = identityAvailable()
      ? chrome.identity.getRedirectURL()
      : `${location.origin}/`;
    const path =
      provider === 'github' ? '/auth/github/start' : `/api/v1/tenants/${tenantId}/salesforce/start`;
    const { authorizationUrl } = await this.request<{ authorizationUrl: string }>(path, {
      returnUrl,
      challenge: await browserChallenge(verifier),
      ...(provider === 'salesforce' ? { authority } : {}),
    });
    const target = new URL(authorizationUrl);
    if (target.protocol !== 'https:') throw new Error('Provider authorization requires HTTPS.');
    if (identityAvailable()) {
      const returned = await chrome.identity.launchWebAuthFlow({
        url: target.href,
        interactive: true,
      });
      if (!returned) throw new Error('Sign-in was cancelled.');
      await this.finish(returned, verifier, provider);
    } else {
      sessionStorage.setItem(
        'branchlight.pending-auth',
        JSON.stringify({ verifier, provider, api: this.base }),
      );
      location.assign(target.href);
    }
  }
}
