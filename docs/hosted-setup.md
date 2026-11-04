# Hosted Foundation Setup

This milestone is not the complete production application. It adds hosted account and connection onboarding while preserving the original local editor. Hosted Git workspaces, source retrieval/deployment, release approval, developer tool parity and public production readiness are pending. Do not publish this milestone as the finished product or use production org credentials in sandbox-demo mode.

## Runtime Modes

| Mode           | Authentication                              | Backend                                                | Deployment     |
| -------------- | ------------------------------------------- | ------------------------------------------------------ | -------------- |
| `local`        | Per-start pairing token                     | Loopback, existing filesystem clones                   | Disabled       |
| `sandbox-demo` | GitHub sign-in and short-lived app sessions | HTTPS + PostgreSQL; verified Salesforce sandboxes only | Disabled       |
| `production`   | Hosted authentication                       | HTTPS + PostgreSQL; configuration foundation only      | Still disabled |

Production mode is not a switch that completes or enables production features. An environment flag cannot bypass the deployment denial. Hosted endpoints do not expose the legacy global-token/workspace API.

## Initialize Local Settings

Node.js 24+ is required. Run `npm ci` and then:

```powershell
npm run setup:env
```

This exclusively creates `.env` with a random 32-byte encryption key and separate random development database password. Existing settings are never overwritten and secrets are never printed. The initial mode stays `local`, so existing editing remains unchanged. On Windows, ensure the file is private under your account's filesystem ACL; POSIX mode bits alone do not configure Windows ACLs.

`.env` and `.env.*` are ignored by Git and the Docker build. Never put provider secrets in `VITE_` variables: Vite variables are public extension build configuration. Losing the encryption key makes stored provider credentials unrecoverable. The vault primitive supports multiple key IDs, but automatic runtime key rotation/KMS integration is not delivered yet; do not casually replace the deployed key.

## PostgreSQL

Start Docker Desktop's Linux engine before this step:

```powershell
docker compose --env-file .env -f infra/compose.yaml up -d postgres
npm run db:migrate
```

The local database binds only to `127.0.0.1:54329`. The initializer configures its connection URL. Migrations create the identity/tenant/credential tables, forced row-level policies and pg-boss queue schema. The application requires schema version 3 and does not auto-migrate during startup. The worker currently handles expiring sessions/OAuth handoffs only, not deployments.

Use a migration/owner credential for `DATABASE_MIGRATION_URL` and a separately provisioned restricted runtime login for `DATABASE_URL` before public production. The development Compose and sandbox Render blueprint use a bootstrap database owner and are not the completed production database-role setup. PostgreSQL policies supplement backend permission checks; superuser/BYPASSRLS roles bypass those policies. Grant only the tables/functions needed by each service, make audit access append-only, verify policies under the runtime role, and keep PostgreSQL private/TLS-protected as appropriate. Backup/restore and role hardening remain production gates.

## HTTPS And Browser Return Addresses

Set `BRANCHLIGHT_MODE=sandbox-demo`, `BRANCHLIGHT_PUBLIC_API_URL` to the actual HTTPS API origin, and `BRANCHLIGHT_ALLOWED_EXTENSION_IDS` to a comma-separated list of the installed Chrome/Edge extension IDs. No wildcard origins are accepted.

For a separately hosted browser frontend, optionally set `BRANCHLIGHT_WEB_ORIGIN` to its exact HTTPS origin. Its return URL is the origin plus `/`. Extension authentication uses the browser identity API's redirect URL. Currently accepted extension returns are `https://<allowed-extension-id>.chromiumapp.org/`; verify the installed browser's actual redirect against that convention during live onboarding. Register the actual published IDs before store rollout. Chrome and Edge testing must use their own actual IDs.

## GitHub App Registration

1. Register a GitHub App, with selected private repositories rather than all-repository access for initial testing.
2. Register the callback URL `https://YOUR_API_ORIGIN/auth/github/callback`.
3. Configure permissions required by the current connection screen: repository Metadata read. Request Contents/Pull requests/Checks/Commit statuses permissions only when their next implementation milestone is ready and reviewed.
4. Configure `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `GITHUB_APP_SLUG` in the backend's private settings.
5. Enable expiring user access tokens. The adapter sends PKCE parameters to the documented token endpoint; Octokit handles authenticated repository APIs.
6. Install the App on an authorized test account/repository, sign in through Branchlight, and select the repository.

Discovery uses the intersection of GitHub App installation access and the signing-in user's own access. Connecting a repository requires tenant-admin permission and rechecks provider access. This milestone fails closed when provider tokens expire and asks for reconnect; automatic refresh, webhook revocation handling, PR APIs and hosted Git clones are still pending. No PAT or local Git Credential Manager is used by hosted onboarding.

## Salesforce External Client App

1. Have an authorized Salesforce admin create/authorize an External Client App for the test sandbox. Verify current cross-org app distribution requirements before external-customer rollout.
2. Register `https://YOUR_API_ORIGIN/auth/salesforce/callback` exactly.
3. Enable authorization-code flow and PKCE with required OAuth scopes `api`, `refresh_token` and `openid`, according to your org's app policies. Keep the client secret on the backend.
4. Configure backend `SALESFORCE_CLIENT_ID` and `SALESFORCE_CLIENT_SECRET` directly in private settings.
5. In Branchlight, select your organization and use Connect Salesforce with `https://test.salesforce.com` or the official sandbox My Domain origin.

The adapter verifies the authenticated user's organization ID against `Organization.Id` and checks `Organization.IsSandbox` through the Salesforce API. Demo mode rejects production orgs and attempts to revoke the rejected grant. Returned grants remain encrypted and pending until the initiating authenticated browser completes its own PKCE proof. A one-time two-minute handoff cannot be replayed. Connection listing never returns provider tokens.

Current capability verification uses Salesforce REST API v66.0; an org whose permissions/API capabilities do not allow identity/Organization checks must fail rather than be guessed. Automatic token refresh, metadata retrieve, SOQL/GraphQL/REST developer consoles, deployment adapters and org-drift/release controls are not yet exposed. Disconnect deletes local encrypted authorization; revoke the application in Salesforce settings to remove its upstream grant too.

## Start Hosted Services

After private settings, HTTPS and database migrations are configured:

```powershell
npm run server
```

In a separate process:

```powershell
npm run worker
```

The hosted listener uses `PORT` (Render) or `BRANCHLIGHT_API_PORT`; local mode remains loopback-only. Missing OAuth app settings are reflected in capability responses and disabled UI, not fake successful connections. App sessions expire after 30 minutes and support sign-out; refresh/step-up session lifecycle and invitations are future gates. API rate limiting currently uses each process's source IP; trusted proxy configuration, distributed quotas and public SaaS traffic testing are not complete.

## Build The Hosted Extension

Set the public build variable to your API origin and build:

```powershell
$env:VITE_BRANCHLIGHT_API_URL = 'https://YOUR_API_ORIGIN'
npm run build
```

The build replaces loopback host permissions with the configured HTTPS host and adds only `identity`/`storage` permissions for onboarding. All executable code remains packaged. Load the output in Chrome/Edge and add its actual ID to the backend allowlist. No local runtime is required for an end user's hosted connection flow. Hostnames/IDs, app registration approvals and safe real test accounts cannot be provisioned by application code alone.

To return to the local editor build, remove the public variable and any corresponding Vite environment setting:

```powershell
Remove-Item Env:VITE_BRANCHLIGHT_API_URL -ErrorAction SilentlyContinue
npm run build
```

## Render Template

`render.yaml` describes **paid sandbox services**: Docker API, authentication-maintenance worker and private managed PostgreSQL. It creates billable resources if you deploy it. It does not create resources merely by existing in this repository. Review current plan pricing and choose an approved region before provisioning. All services default to manual deployment, and the application stays in sandbox-demo mode.

Deploy the API and run migrations successfully before starting the worker. The template prompts for app credentials and your exact API URL/extension IDs, and generates a shared encryption key through an environment group. Worker credentials do not include GitHub/Salesforce client secrets. The API image does not contain local `.branchlight` workspaces or environment files.

Use Render Free only for temporary sandbox demonstrations with explicit lifecycle limits. Free services sleep, local files are ephemeral and free databases expire; this is not a substitute for production workers/backups. Promotion to public production requires the remaining release gates, restricted database identities, managed key storage/rotation, encrypted object storage/snapshots, recovery drills and authorized live integration testing.

## Verification Status

Automated OAuth/browser tests use explicit provider mocks. PostgreSQL integration tests use PGlite's PostgreSQL engine, including a non-owner role for row-policy checks; Docker/PostgreSQL runtime validation must also run before deployment. Tests are not proof that your external app registrations, live org policies or Edge publishing work.

Run the local regression suite, strict type/build/format gates, browser tests and dependency audit. Do not provide private keys, provider secrets, pairing launchers, runtime workspaces or customer source to chat when configuring the integrations.
