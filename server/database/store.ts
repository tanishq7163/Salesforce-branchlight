import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export type QueryResult<Row> = { rows: Row[] };
export interface Connection {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
  release(): void;
}
export interface DatabasePool {
  connect(): Promise<Connection>;
}
export type User = { id: string; login: string };
export type Role = 'admin' | 'developer' | 'reviewer' | 'release_approver';
export class AccessError extends Error {
  statusCode: number;
  constructor(message = 'You do not have access to this resource.', statusCode = 403) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export class Store {
  pool: DatabasePool;
  constructor(pool: DatabasePool) {
    this.pool = pool;
  }

  async transaction<Result>(
    operation: (connection: Connection) => Promise<Result>,
  ): Promise<Result> {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      const result = await operation(connection);
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      await connection.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  async migrate() {
    const migrations = await Promise.all(
      ['001_foundation.sql', '002_integrations.sql', '003_connection_handoffs.sql'].map((file) =>
        readFile(new URL(`./${file}`, import.meta.url), 'utf8'),
      ),
    );
    await this.transaction(async (connection) => {
      await connection.query('SELECT pg_advisory_xact_lock(19840721)');
      await connection.query(
        'CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
      );
      for (const [index, sql] of migrations.entries()) {
        const version = index + 1;
        const existing = await connection.query(
          'SELECT version FROM schema_migrations WHERE version=$1',
          [version],
        );
        if (!existing.rows.length) {
          await connection.query(sql);
          await connection.query('INSERT INTO schema_migrations(version) VALUES ($1)', [version]);
        }
      }
    });
  }

  async assertRuntimeRole() {
    await this.transaction(async (connection) => {
      const result = await connection.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user',
      );
      const role = result.rows[0];
      if (!role || role.rolsuper || role.rolbypassrls)
        throw new AccessError(
          'Production runtime must use a database role without superuser or row-policy bypass privileges.',
          503,
        );
    });
  }

  async upsertGithubUser(githubId: string, login: string): Promise<User> {
    return this.transaction(async (connection) => {
      const result = await connection.query<{ id: string; login: string }>(
        'INSERT INTO app_users(id, github_id, login) VALUES ($1,$2,$3) ON CONFLICT (github_id) DO UPDATE SET login=EXCLUDED.login WHERE app_users.active=true RETURNING id, login',
        [randomUUID(), githubId, login],
      );
      if (!result.rows[0]) throw new AccessError('This account is disabled.');
      return result.rows[0];
    });
  }

  async createSession(userId: string): Promise<{ token: string; expiresAt: string }> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    await this.transaction(async (connection) => {
      const user = await connection.query(
        'SELECT id FROM app_users WHERE id=$1 AND active=true FOR SHARE',
        [userId],
      );
      if (!user.rows.length) throw new AccessError('This account is disabled.');
      await connection.query(
        'INSERT INTO app_sessions(token_hash,user_id,expires_at) VALUES ($1,$2,$3)',
        [digest(token), userId, expiresAt],
      );
    });
    return { token, expiresAt };
  }

  async authenticate(token: string): Promise<User> {
    return this.transaction(async (connection) => {
      const result = await connection.query<{ id: string; login: string }>(
        'SELECT u.id,u.login FROM app_sessions s JOIN app_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true',
        [digest(token)],
      );
      if (!result.rows[0]) throw new AccessError('Sign in again to continue.', 401);
      return result.rows[0];
    });
  }

  async revokeSession(token: string) {
    await this.transaction((connection) =>
      connection.query('DELETE FROM app_sessions WHERE token_hash=$1', [digest(token)]),
    );
  }

  async withTenant<Result>(
    userId: string,
    tenantId: string,
    roles: readonly Role[],
    operation: (connection: Connection, role: Role) => Promise<Result>,
  ): Promise<Result> {
    return this.transaction(async (connection) => {
      const membership = await connection.query<{ role: Role }>(
        'SELECT m.role FROM memberships m JOIN app_users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.user_id=$2 AND u.active=true FOR SHARE OF m,u',
        [tenantId, userId],
      );
      const role = membership.rows[0]?.role;
      if (!role || (roles.length && role !== 'admin' && !roles.includes(role)))
        throw new AccessError();
      await connection.query(
        "SELECT set_config('branchlight.tenant_id',$1,true),set_config('branchlight.user_id',$2,true)",
        [tenantId, userId],
      );
      return operation(connection, role);
    });
  }

  async listTenants(userId: string) {
    return this.transaction(
      async (connection) =>
        (
          await connection.query<{ id: string; name: string; role: Role }>(
            'SELECT t.id,t.name,m.role FROM tenants t JOIN memberships m ON m.tenant_id=t.id WHERE m.user_id=$1 ORDER BY t.created_at',
            [userId],
          )
        ).rows,
    );
  }

  async createTenant(userId: string, name: string) {
    return this.transaction(async (connection) => {
      const active = await connection.query(
        'SELECT id FROM app_users WHERE id=$1 AND active=true FOR UPDATE',
        [userId],
      );
      if (!active.rows.length) throw new AccessError('This account is disabled.');
      const count = await connection.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM tenants WHERE created_by=$1',
        [userId],
      );
      if (Number(count.rows[0]?.count) >= 5)
        throw new AccessError('The tenant creation limit has been reached.', 429);
      const id = randomUUID();
      await connection.query('INSERT INTO tenants(id,name,created_by) VALUES ($1,$2,$3)', [
        id,
        name,
        userId,
      ]);
      await connection.query('INSERT INTO memberships(tenant_id,user_id,role) VALUES ($1,$2,$3)', [
        id,
        userId,
        'admin',
      ]);
      await connection.query(
        "SELECT set_config('branchlight.tenant_id',$1,true),set_config('branchlight.user_id',$2,true)",
        [id, userId],
      );
      await this.audit(connection, id, userId, 'tenant.created', id);
      return { id, name, role: 'admin' as const };
    });
  }

  async audit(
    connection: Connection,
    tenantId: string,
    userId: string,
    action: string,
    resourceId?: string,
  ) {
    await connection.query(
      'INSERT INTO audit_events(id,tenant_id,user_id,action,resource_id) VALUES ($1,$2,$3,$4,$5)',
      [randomUUID(), tenantId, userId, action, resourceId ?? null],
    );
  }
}
