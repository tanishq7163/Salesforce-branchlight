CREATE TABLE connection_handoffs (
  code_hash text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES app_users(id),
  challenge text NOT NULL,
  grant_ciphertext text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX connection_handoff_expiry ON connection_handoffs(expires_at);