# Public V1 Delivery Status

## Delivered In This Milestone

- Explicit local/sandbox-demo/production configuration. Hosted startup rejects missing HTTPS, database, allowed origins or encryption configuration and does not expose local pairing/workspace routes.
- PostgreSQL migrations, users, organizations, memberships, hashed revocable 30-minute sessions, tenant permission checks and row-level policies for provider credentials, drafts, repositories and audit records.
- AES-256-GCM credential encryption bound to user/tenant/purpose. Cryptographic key-rotation primitive tested; managed key service/runtime rotation is not configured.
- Expiring single-use OAuth state, provider PKCE, browser PKCE return-code exchange and authenticated Salesforce-link finalization. Provider tokens never return to the extension.
- GitHub App user authorization and installed repository discovery/binding; actual Salesforce identity/sandbox verification and encrypted connection storage. External live registrations/accounts are still required.
- Hosted extension onboarding, organization creation, repository/org listings, local disconnection, audit list and logout. Included buttons perform those operations; missing integrations are disabled with a setup error.
- PostgreSQL-backed durable job foundation and authentication-expiry maintenance worker, non-root Docker image, local database Compose and sandbox Render Blueprint.
- Unique local-example branches, avoiding the repeated shared-branch push collision. Development runtime paths excluded from Vite serving/watching.

## Remaining Before Public Production

| Gate                                                                                            | State                                                             |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Live GitHub/Salesforce OAuth feasibility and customer app distribution                          | Requires registered apps, approved domain and authorized accounts |
| Hosted persistent Git workspaces, encrypted object snapshots and server draft backup            | Not implemented                                                   |
| Native PR creation/reviews/checks/merge, token refresh and webhook revocation                   | Not implemented                                                   |
| Tenant invitations, role management, refresh/step-up sessions, offboarding                      | Not implemented                                                   |
| Metadata inventory/retrieve, complete component templates, eligible Lightning Types/LMS support | Not implemented                                                   |
| Sandbox deploy, Apex test/coverage jobs and shared UAT                                          | Not implemented                                                   |
| Immutable reviewed release provenance, org drift, approvals and production deployment           | Not implemented; deployment stays denied                          |
| Reviewed destructive manifests/dependency preview and metadata ZIP import/export                | Not implemented                                                   |
| SOQL/GraphQL/REST, anonymous Apex/log tools, converters/formatters/themes parity                | Not implemented                                                   |
| Production break-glass action approval and audit/reconciliation                                 | Not implemented                                                   |
| KMS/object storage, restricted service roles, distributed quotas, recovery/security/load drills | Pending                                                           |
| Chrome/Edge live OAuth tests, publication assets/privacy/legal/store submissions                | Pending                                                           |

Public-production completion means passing the full approved feature/tenant/security/recovery matrix with real authorized integrations, not merely selecting `BRANCHLIGHT_MODE=production`. Existing local-source editing continues to work, but it does not stand in for unfinished hosted editor or Salesforce workflows.
