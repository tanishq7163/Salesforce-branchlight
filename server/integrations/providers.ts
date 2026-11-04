import { Octokit } from '@octokit/rest';
import { z } from 'zod';

export type HttpTransport = typeof fetch;
export type GithubGrant = {
  token: string;
  refreshToken?: string;
  expiresAt?: string;
  refreshTokenExpiresAt?: string;
};
export type SalesforceGrant = {
  accessToken: string;
  refreshToken?: string;
  instanceUrl: string;
  authority: string;
  userId: string;
  orgId: string;
  label: string;
  sandbox: boolean;
};

export function salesforceAuthority(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    parsed.port ||
    !(
      /^(login|test)\.salesforce\.com$/.test(parsed.hostname) ||
      /^[a-z0-9][a-z0-9-]*\.(sandbox\.)?my\.salesforce\.com$/.test(parsed.hostname)
    )
  ) {
    throw new Error('Use an official Salesforce login, sandbox or My Domain HTTPS origin.');
  }
  return parsed.origin;
}

function instanceOrigin(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    parsed.port ||
    !/^[a-z0-9][a-z0-9.-]*\.salesforce\.com$/.test(parsed.hostname)
  ) {
    throw new Error('Salesforce returned an invalid instance origin.');
  }
  return parsed.origin;
}

export class GithubProvider {
  private clientId: string;
  private clientSecret: string;
  private redirectUrl: string;
  private transport: HttpTransport;

  constructor(options: {
    clientId: string;
    clientSecret: string;
    redirectUrl: string;
    transport?: HttpTransport;
  }) {
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.redirectUrl = options.redirectUrl;
    this.transport = options.transport ?? fetch;
  }

  authorizationUrl(state: string, challenge: string): string {
    const url = new URL('https://github.com/login/oauth/authorize');
    url.search = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUrl,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    return url.href;
  }

  async exchange(
    code: string,
    verifier: string,
  ): Promise<{ user: { id: string; login: string }; grant: GithubGrant }> {
    const response = await this.transport('https://github.com/login/oauth/access_token', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        redirect_uri: this.redirectUrl,
        code_verifier: verifier,
      }),
    });
    if (!response.ok) throw new Error('GitHub authorization failed. Start sign-in again.');
    const tokens = z
      .object({
        access_token: z.string().min(1),
        refresh_token: z.string().optional(),
        expires_in: z.number().positive().optional(),
        refresh_token_expires_in: z.number().positive().optional(),
      })
      .parse(await response.json());
    const octokit = new Octokit({ auth: tokens.access_token, request: { fetch: this.transport } });
    const { data } = await octokit.users.getAuthenticated();
    const grant: GithubGrant = {
      token: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
        : undefined,
      refreshTokenExpiresAt: tokens.refresh_token_expires_in
        ? new Date(Date.now() + tokens.refresh_token_expires_in * 1000).toISOString()
        : undefined,
    };
    return { user: { id: String(data.id), login: data.login }, grant };
  }

  async repositories(grant: GithubGrant) {
    if (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now())
      throw new Error('Reconnect GitHub to renew repository authorization.');
    const octokit = new Octokit({ auth: grant.token, request: { fetch: this.transport } });
    const installations = await octokit.paginate(
      octokit.apps.listInstallationsForAuthenticatedUser,
      { per_page: 100 },
    );
    const repositories: {
      id: number;
      installationId: number;
      name: string;
      private: boolean;
      defaultBranch: string;
      url: string;
    }[] = [];
    for (const installation of installations) {
      const entries = await octokit.paginate(
        octokit.apps.listInstallationReposForAuthenticatedUser,
        { installation_id: installation.id, per_page: 100 },
      );
      for (const repository of entries) {
        repositories.push({
          id: repository.id,
          installationId: installation.id,
          name: repository.full_name,
          private: repository.private,
          defaultBranch: repository.default_branch,
          url: repository.html_url,
        });
        if (repositories.length > 2000)
          throw new Error(
            'Repository listing limit reached. Narrow the GitHub App installation scope.',
          );
      }
    }
    return repositories;
  }
}

export class SalesforceProvider {
  private clientId: string;
  private clientSecret: string;
  private redirectUrl: string;
  private transport: HttpTransport;

  constructor(options: {
    clientId: string;
    clientSecret: string;
    redirectUrl: string;
    transport?: HttpTransport;
  }) {
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.redirectUrl = options.redirectUrl;
    this.transport = options.transport ?? fetch;
  }

  authorizationUrl(authority: string, state: string, challenge: string): string {
    const url = new URL('/services/oauth2/authorize', salesforceAuthority(authority));
    url.search = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUrl,
      response_type: 'code',
      scope: 'api refresh_token openid',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    return url.href;
  }

  private async json(url: string, options: RequestInit) {
    const response = await this.transport(url, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok)
      throw new Error(
        'Salesforce refused this request. Check app authorization, API access and user permissions.',
      );
    return response.json();
  }

  async exchange(
    authority: string,
    code: string,
    verifier: string,
    sandboxOnly: boolean,
  ): Promise<SalesforceGrant> {
    const origin = salesforceAuthority(authority);
    const tokens = z
      .object({
        access_token: z.string().min(1),
        refresh_token: z.string().optional(),
        instance_url: z.string(),
      })
      .parse(
        await this.json(`${origin}/services/oauth2/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: this.clientId,
            client_secret: this.clientSecret,
            redirect_uri: this.redirectUrl,
            code,
            code_verifier: verifier,
          }),
        }),
      );
    const instanceUrl = instanceOrigin(tokens.instance_url);
    const headers = { Authorization: `Bearer ${tokens.access_token}` };
    const identity = z
      .object({
        organization_id: z.string().regex(/^[A-Za-z0-9]{15,18}$/),
        user_id: z.string().regex(/^[A-Za-z0-9]{15,18}$/),
      })
      .parse(await this.json(`${instanceUrl}/services/oauth2/userinfo`, { headers }));
    const organizations = z
      .object({
        records: z
          .array(z.object({ Id: z.string(), Name: z.string(), IsSandbox: z.boolean() }))
          .length(1),
      })
      .parse(
        await this.json(
          `${instanceUrl}/services/data/v66.0/query?${new URLSearchParams({ q: 'SELECT Id, Name, IsSandbox FROM Organization' })}`,
          { headers },
        ),
      );
    const organization = organizations.records[0]!;
    if (organization.Id.slice(0, 15) !== identity.organization_id.slice(0, 15))
      throw new Error('Salesforce org identity verification failed.');
    if (sandboxOnly && !organization.IsSandbox) {
      await this.transport(`${origin}/services/oauth2/revoke`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: tokens.refresh_token ?? tokens.access_token }),
      }).catch(() => undefined);
      throw new Error('Sandbox-demo mode cannot connect production orgs.');
    }
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      instanceUrl,
      authority: origin,
      userId: identity.user_id,
      orgId: identity.organization_id,
      label: organization.Name,
      sandbox: organization.IsSandbox,
    };
  }
}
