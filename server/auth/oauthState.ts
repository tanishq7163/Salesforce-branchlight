import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Store, digest, AccessError } from '../database/store.ts';
import { SecretVault } from '../security/vault.ts';
import type { SalesforceGrant } from '../integrations/providers.ts';

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export type OAuthRequest = {
  provider: 'github' | 'salesforce';
  tenantId?: string;
  userId?: string;
  returnUrl: string;
  challenge: string;
  authority: string;
};

type StoredRequest = {
  provider: OAuthRequest['provider'];
  tenant_id: string | null;
  user_id: string | null;
  return_url: string;
  challenge: string;
  verifier_ciphertext: string;
  authority: string;
};

export class OAuthStateService {
  private store: Store;
  private vault: SecretVault;
  constructor(store: Store, vault: SecretVault) {
    this.store = store;
    this.vault = vault;
  }

  async start(request: OAuthRequest) {
    z.string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .parse(request.challenge);
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const stateHash = digest(state);
    const context = {
      tenantId: request.tenantId ?? 'login',
      userId: request.userId ?? 'anonymous',
      purpose: `oauth:${stateHash}`,
    };
    await this.store.transaction((connection) =>
      connection.query(
        "INSERT INTO oauth_requests(state_hash,provider,tenant_id,user_id,return_url,challenge,verifier_ciphertext,authority,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '10 minutes')",
        [
          stateHash,
          request.provider,
          request.tenantId ?? null,
          request.userId ?? null,
          request.returnUrl,
          request.challenge,
          this.vault.encrypt(verifier, context),
          request.authority,
        ],
      ),
    );
    return { state, challenge: pkceChallenge(verifier) };
  }

  async consume(state: string, provider: OAuthRequest['provider']) {
    const stateHash = digest(state);
    const record = await this.store.transaction(async (connection) => {
      const result = await connection.query<StoredRequest>(
        'DELETE FROM oauth_requests WHERE state_hash=$1 AND provider=$2 AND expires_at>now() RETURNING provider,tenant_id,user_id,return_url,challenge,verifier_ciphertext,authority',
        [stateHash, provider],
      );
      if (!result.rows[0])
        throw new AccessError('The sign-in request expired or was already used.', 400);
      return result.rows[0];
    });
    const context = {
      tenantId: record.tenant_id ?? 'login',
      userId: record.user_id ?? 'anonymous',
      purpose: `oauth:${stateHash}`,
    };
    return {
      provider,
      tenantId: record.tenant_id,
      userId: record.user_id,
      returnUrl: record.return_url,
      challenge: record.challenge,
      authority: record.authority,
      verifier: this.vault.decrypt(record.verifier_ciphertext, context),
    };
  }

  async createHandoff(userId: string, challenge: string): Promise<string> {
    const code = randomBytes(32).toString('base64url');
    await this.store.transaction((connection) =>
      connection.query(
        "INSERT INTO login_handoffs(code_hash,user_id,challenge,expires_at) VALUES ($1,$2,$3,now()+interval '2 minutes')",
        [digest(code), userId, challenge],
      ),
    );
    return code;
  }

  async exchange(code: string, verifier: string) {
    z.string()
      .regex(/^[A-Za-z0-9._~-]{43,128}$/)
      .parse(verifier);
    const userId = await this.store.transaction(async (connection) => {
      const result = await connection.query<{ user_id: string }>(
        'DELETE FROM login_handoffs WHERE code_hash=$1 AND challenge=$2 AND expires_at>now() RETURNING user_id',
        [digest(code), pkceChallenge(verifier)],
      );
      if (!result.rows[0])
        throw new AccessError('The sign-in return code is invalid, expired or already used.', 400);
      return result.rows[0].user_id;
    });
    return this.store.createSession(userId);
  }

  async createConnectionHandoff(
    userId: string,
    tenantId: string,
    challenge: string,
    grant: SalesforceGrant,
  ) {
    const code = randomBytes(32).toString('base64url');
    const codeHash = digest(code);
    const ciphertext = this.vault.encrypt(JSON.stringify(grant), {
      tenantId,
      userId,
      purpose: `salesforce-pending:${codeHash}`,
    });
    await this.store.withTenant(userId, tenantId, [], (connection) =>
      connection.query(
        "INSERT INTO connection_handoffs(code_hash,tenant_id,user_id,challenge,grant_ciphertext,expires_at) VALUES ($1,$2,$3,$4,$5,now()+interval '2 minutes')",
        [codeHash, tenantId, userId, challenge, ciphertext],
      ),
    );
    return code;
  }

  async completeConnection(userId: string, code: string, verifier: string) {
    z.string()
      .regex(/^[A-Za-z0-9._~-]{43,128}$/)
      .parse(verifier);
    const codeHash = digest(code);
    const record = await this.store.transaction(async (connection) => {
      const result = await connection.query<{ tenant_id: string; grant_ciphertext: string }>(
        'DELETE FROM connection_handoffs WHERE code_hash=$1 AND user_id=$2 AND challenge=$3 AND expires_at>now() RETURNING tenant_id,grant_ciphertext',
        [codeHash, userId, pkceChallenge(verifier)],
      );
      if (!result.rows[0])
        throw new AccessError(
          'The connection return code is invalid, expired or already used.',
          400,
        );
      return result.rows[0];
    });
    const grant = JSON.parse(
      this.vault.decrypt(record.grant_ciphertext, {
        tenantId: record.tenant_id,
        userId,
        purpose: `salesforce-pending:${codeHash}`,
      }),
    ) as SalesforceGrant;
    return { tenantId: record.tenant_id, grant };
  }
}
