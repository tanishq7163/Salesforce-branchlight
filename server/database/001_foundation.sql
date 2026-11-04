CREATE TABLE IF NOT EXISTS app_users (
  id uuid PRIMARY KEY,
  github_id text NOT NULL UNIQUE,
  login text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS memberships (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES app_users(id),
  role text NOT NULL CHECK (role IN ('admin', 'developer', 'reviewer', 'release_approver')),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE TABLE IF NOT EXISTS app_sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_users(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS oauth_requests (
  state_hash text PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('github', 'salesforce')),
  tenant_id uuid REFERENCES tenants(id),
  user_id uuid REFERENCES app_users(id),
  return_url text NOT NULL,
  challenge text NOT NULL,
  verifier_ciphertext text NOT NULL,
  authority text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS login_handoffs (
  code_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_users(id),
  challenge text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_credentials (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES app_users(id),
  provider text NOT NULL CHECK (provider IN ('github', 'salesforce')),
  external_id text NOT NULL,
  label text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('github', 'sandbox', 'production')),
  secret_ciphertext text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, provider, external_id)
);
CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES app_users(id),
  action text NOT NULL,
  resource_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hosted_drafts (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES app_users(id),
  workspace_id uuid NOT NULL,
  branch text NOT NULL,
  path text NOT NULL,
  content_ciphertext text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, workspace_id, branch, path)
);
ALTER TABLE provider_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_credentials FORCE ROW LEVEL SECURITY;
ALTER TABLE hosted_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE hosted_drafts FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY credential_owner ON provider_credentials
  USING (tenant_id::text = current_setting('branchlight.tenant_id', true)
    AND user_id::text = current_setting('branchlight.user_id', true))
  WITH CHECK (tenant_id::text = current_setting('branchlight.tenant_id', true)
    AND user_id::text = current_setting('branchlight.user_id', true));
CREATE POLICY draft_owner ON hosted_drafts
  USING (tenant_id::text = current_setting('branchlight.tenant_id', true)
    AND user_id::text = current_setting('branchlight.user_id', true))
  WITH CHECK (tenant_id::text = current_setting('branchlight.tenant_id', true)
    AND user_id::text = current_setting('branchlight.user_id', true));
CREATE POLICY audit_tenant ON audit_events
  USING (tenant_id::text = current_setting('branchlight.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('branchlight.tenant_id', true)
    AND user_id::text = current_setting('branchlight.user_id', true));
CREATE INDEX session_expiry ON app_sessions(expires_at);
CREATE INDEX oauth_expiry ON oauth_requests(expires_at);
CREATE INDEX audit_tenant_time ON audit_events(tenant_id, created_at DESC);