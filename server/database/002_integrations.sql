CREATE TABLE user_provider_grants (
  user_id uuid PRIMARY KEY REFERENCES app_users(id),
  secret_ciphertext text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE user_provider_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_provider_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY user_grant_owner ON user_provider_grants
  USING (user_id::text = current_setting('branchlight.user_id', true))
  WITH CHECK (user_id::text = current_setting('branchlight.user_id', true));
CREATE TABLE repository_bindings (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES app_users(id),
  github_id text NOT NULL,
  installation_id text NOT NULL,
  full_name text NOT NULL,
  default_branch text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, github_id)
);
ALTER TABLE repository_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE repository_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY repository_tenant ON repository_bindings
  USING (tenant_id::text = current_setting('branchlight.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('branchlight.tenant_id', true)
    AND user_id::text = current_setting('branchlight.user_id', true));