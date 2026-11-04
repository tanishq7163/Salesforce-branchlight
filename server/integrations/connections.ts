import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AccessError, Store } from '../database/store.ts';
import { SecretVault } from '../security/vault.ts';
import type { GithubGrant, GithubProvider, SalesforceGrant } from './providers.ts';

const githubGrantSchema = z.object({
  token: z.string().min(1),
  refreshToken: z.string().optional(),
  expiresAt: z.string().optional(),
  refreshTokenExpiresAt: z.string().optional(),
});

export class ConnectionService {
  private store: Store;
  private vault: SecretVault;
  constructor(store: Store, vault: SecretVault) {
    this.store = store;
    this.vault = vault;
  }

  async saveGithub(userId: string, grant: GithubGrant) {
    const envelope = this.vault.encrypt(JSON.stringify(grant), {
      tenantId: 'identity',
      userId,
      purpose: 'github:user-grant',
    });
    await this.store.transaction(async (connection) => {
      await connection.query("SELECT set_config('branchlight.user_id',$1,true)", [userId]);
      await connection.query(
        'INSERT INTO user_provider_grants(user_id,secret_ciphertext) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET secret_ciphertext=EXCLUDED.secret_ciphertext,updated_at=now()',
        [userId, envelope],
      );
    });
  }

  async github(userId: string): Promise<GithubGrant> {
    const ciphertext = await this.store.transaction(async (connection) => {
      await connection.query("SELECT set_config('branchlight.user_id',$1,true)", [userId]);
      const result = await connection.query<{ secret_ciphertext: string }>(
        'SELECT secret_ciphertext FROM user_provider_grants WHERE user_id=$1',
        [userId],
      );
      if (!result.rows[0])
        throw new AccessError('Connect GitHub before selecting a repository.', 409);
      return result.rows[0].secret_ciphertext;
    });
    return githubGrantSchema.parse(
      JSON.parse(
        this.vault.decrypt(ciphertext, {
          tenantId: 'identity',
          userId,
          purpose: 'github:user-grant',
        }),
      ),
    );
  }

  async saveSalesforce(userId: string, tenantId: string, grant: SalesforceGrant) {
    return this.store.withTenant(userId, tenantId, [], async (connection) => {
      const ciphertext = this.vault.encrypt(JSON.stringify(grant), {
        tenantId,
        userId,
        purpose: `salesforce:${grant.orgId}`,
      });
      const id = randomUUID();
      const result = await connection.query<{ id: string }>(
        "INSERT INTO provider_credentials(id,tenant_id,user_id,provider,external_id,label,environment,secret_ciphertext) VALUES ($1,$2,$3,'salesforce',$4,$5,$6,$7) ON CONFLICT (tenant_id,user_id,provider,external_id) DO UPDATE SET label=EXCLUDED.label,environment=EXCLUDED.environment,secret_ciphertext=EXCLUDED.secret_ciphertext RETURNING id",
        [
          id,
          tenantId,
          userId,
          grant.orgId,
          grant.label,
          grant.sandbox ? 'sandbox' : 'production',
          ciphertext,
        ],
      );
      await this.store.audit(
        connection,
        tenantId,
        userId,
        'salesforce.connected',
        result.rows[0]!.id,
      );
      return result.rows[0]!.id;
    });
  }

  async listSalesforce(userId: string, tenantId: string) {
    return this.store.withTenant(
      userId,
      tenantId,
      [],
      async (connection) =>
        (
          await connection.query<{
            id: string;
            label: string;
            environment: string;
            external_id: string;
          }>(
            "SELECT id,label,environment,external_id FROM provider_credentials WHERE tenant_id=$1 AND user_id=$2 AND provider='salesforce' ORDER BY created_at",
            [tenantId, userId],
          )
        ).rows,
    );
  }

  async disconnectSalesforce(userId: string, tenantId: string, id: string) {
    await this.store.withTenant(userId, tenantId, [], async (connection) => {
      const result = await connection.query(
        'DELETE FROM provider_credentials WHERE id=$1 AND tenant_id=$2 AND user_id=$3 RETURNING id',
        [id, tenantId, userId],
      );
      if (!result.rows.length) throw new AccessError();
      await this.store.audit(connection, tenantId, userId, 'salesforce.disconnected', id);
    });
  }

  async bindRepository(
    userId: string,
    tenantId: string,
    githubId: number,
    provider: Pick<GithubProvider, 'repositories'>,
  ) {
    await this.store.withTenant(userId, tenantId, ['admin'], async () => undefined);
    const available = await provider.repositories(await this.github(userId));
    const selected = available.find((repository) => repository.id === githubId);
    if (!selected)
      throw new AccessError(
        'The GitHub App and your account must both have access to this repository.',
      );
    return this.store.withTenant(userId, tenantId, ['admin'], async (connection) => {
      const result = await connection.query<{ id: string }>(
        'INSERT INTO repository_bindings(id,tenant_id,user_id,github_id,installation_id,full_name,default_branch) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id,github_id) DO UPDATE SET user_id=EXCLUDED.user_id,installation_id=EXCLUDED.installation_id,full_name=EXCLUDED.full_name,default_branch=EXCLUDED.default_branch RETURNING id',
        [
          randomUUID(),
          tenantId,
          userId,
          String(selected.id),
          String(selected.installationId),
          selected.name,
          selected.defaultBranch,
        ],
      );
      await this.store.audit(
        connection,
        tenantId,
        userId,
        'repository.connected',
        result.rows[0]!.id,
      );
      return result.rows[0]!.id;
    });
  }

  async listRepositories(userId: string, tenantId: string) {
    return this.store.withTenant(
      userId,
      tenantId,
      [],
      async (connection) =>
        (
          await connection.query<{ id: string; full_name: string; default_branch: string }>(
            'SELECT id,full_name,default_branch FROM repository_bindings WHERE tenant_id=$1 ORDER BY created_at',
            [tenantId],
          )
        ).rows,
    );
  }
}
