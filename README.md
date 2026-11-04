# Branchlight Studio

A new Chrome extension for Salesforce source editing with an explicit Git workflow.
This is an independently implemented local-development preview, not a fork of Lightning Studio.

**Save writes a browser draft, never Salesforce and never a Git remote. Salesforce deployment is disabled.**

## Hosted V1 Foundation

The repository now also includes a separate hosted foundation: PostgreSQL tenant/session storage, encrypted provider credentials, GitHub sign-in/repository discovery, Salesforce OAuth connection verification, a durable authentication-maintenance worker, and an extension onboarding screen. These do not yet enable hosted editor workspaces or Salesforce deployment.

See [docs/hosted-setup.md](docs/hosted-setup.md) for mode selection, database/app registration and Render instructions, and [docs/v1-status.md](docs/v1-status.md) for implemented versus pending release gates. The local workflow below remains available and does not require these integrations.

## Requirements

- Node.js 24 or newer and npm.
- Git available on PATH.
- Chrome for loading the extension.
- For private GitHub repositories, configure the local machine's Git Credential Manager first. Do not put credentials in repository URLs.

## Run

```powershell
npm ci
npm run dev
```

In a second terminal:

```powershell
npm run server
```

The editor defaults to http://127.0.0.1:5173. The Git service binds only to 127.0.0.1:8787.
Open the generated `.branchlight/open-studio.html` in a browser to pair automatically:

```powershell
Start-Process .branchlight/open-studio.html
```

The pairing launcher contains a local credential. Keep it private. Tokens rotate whenever the service starts and are never logged. The editor removes the pairing fragment immediately and keeps its service credential in memory only. Reopen the launcher to pair after reloading the editor.

Choose **Create local Git example** to exercise branches and commits without a GitHub account or Salesforce org. This creates a real local bare Git remote and an isolated clone; it does not connect to Salesforce. Alternatively choose **Connect repository**, enter a GitHub HTTPS URL and commit author, then create a feature branch.

Only workspace identifiers are stored in localStorage. Source drafts live in IndexedDB and Git working copies live under `.branchlight/workspaces`. Browser drafts are device/profile-specific, are not a backup, and can be lost when browser data is cleared. Push reviewed work to GitHub for durable shared history.

### Ports

If the editor's port is occupied, Vite selects another port. Set the actual editor URL before starting the API, or restart the editor on a free explicit port:

```powershell
npm run dev -- --port 5174 --strictPort
```

```powershell
$env:BRANCHLIGHT_EDITOR_URL = 'http://127.0.0.1:5174'
$env:BRANCHLIGHT_API_PORT = '8788'
npm run server
```

The generated launcher uses those URLs. The service refuses unapproved browser origins.

## Load the Chrome Extension

```powershell
npm run build
```

1. Open `chrome://extensions`, enable Developer mode, select **Load unpacked**, and choose the generated `dist` directory.
2. Record the extension ID shown by Chrome.
3. Restart the backend with the ID allowlisted:

```powershell
$env:BRANCHLIGHT_EXTENSION_ID = 'your-32-character-extension-id'
npm run server
```

4. Open the extension from Chrome's toolbar. Use **Pair service** with the backend URL and the current value in `.branchlight/pairing-token`. Enter it directly in the extension, not in chat or committed configuration.

All editor scripts, workers and fonts are packaged locally; no CDN scripts or Salesforce page session cookies are used.

## Available Workflow

- Full-tab Monaco editor, file tree, tabs, search, syntax highlighting, editable diffs and source-file creation.
- LWC, Apex classes/triggers, Aura and Visualforce text editing. This is not full Apex IntelliSense or Salesforce metadata validation.
- Ctrl+S / Cmd+S saves only the current draft. Closing a tab or switching branches/workspaces preserves changed drafts locally. Unsaved changes warn before navigation away.
- Draft keys include repository, workspace, branch and path. IndexedDB transactions reject stale-tab saves.
- Isolated Git clones, branch creation/switching, file staging/unstaging, commits, history, fetch, fast-forward-only pull and ordinary push.
- Staging checks the working-file content hash. Commit requests check both HEAD and the staged index snapshot. The backend refuses staging/commits/pushes on `main` and `master`.
- Three-way conflict inspection, editable resolution, explicit resolve-and-stage and merge abort. Branch switching is blocked while Git working changes remain uncommitted; browser drafts stay preserved.
- GitHub PR creation opens the actual GitHub compare page. Native PR API creation, review synchronization and merge approval enforcement are not implemented yet.
- Desktop and narrow-screen access to the branch workflow panel.

Saving, staging, committing, pushing and deploying are distinct operations. A saved local draft is not yet a Git working-tree change. **Stage file** explicitly materializes that draft into its isolated clone and adds it to the index. Commit records the staged snapshot; Push updates the Git remote. Pull/merge refresh the editor and flag a recovered draft when its base changed. Reconcile such a draft before staging.

New Salesforce metadata components often need multiple bundle files and descriptors. The preview creates individual files, not complete validated metadata bundles. Include all required files in the staged commit; deployable bundle validation is a later milestone. Destructive metadata deployment and rename/delete tools are not included.

## Security Boundary

The Git API is **single-developer, loopback-only**, with a random pairing credential and exact origin allowlist. It must not be exposed over a network or used as a shared team backend. Every API endpoint requires pairing. Source path traversal, hidden files, Git internals and symlinks are refused. Repository hooks and fsmonitor are disabled for managed workspaces. Cloning accepts only HTTPS GitHub URLs without embedded credentials. Git actions are serialized within each workspace.

Production deployment has no adapter or credentials; the backend independently rejects `/api/deploy`. A disabled button alone is not the security control. Internal Git locks do not protect against privileged external filesystem edits. Do not manually edit the service's managed clones while it is running.

GitHub Free private repositories cannot enforce native protected branches. The local `main`/`master` guard does not prevent external Git clients from pushing. The planned team backend must verify cumulative reviewed release provenance, stale approvals, exact artifacts, org drift, permissions and independent deployment approval before any production capability is enabled.

Remaining team-backend work includes GitHub App/user authorization, Salesforce OAuth, PostgreSQL and durable workers, role-based access, PR/release governance, sandbox/UAT validation, org baseline/drift detection and audited production releases. This preview is not ready for production or 10-user shared hosting.

## Verification

```powershell
npm test
npm run typecheck
npm run format:check
npm run build
npx playwright install chromium
npm run test:e2e
npm audit
```

Browser tests start or reuse the editor and API on their default ports and use only generated local example repositories. Build first: the MV3 test loads `dist` in Chromium and checks for CSP errors. Tests cover no-network Save/reload, branch-draft isolation, stage/commit/push, mobile layout and packaged extension loading. Service tests use disposable local bare Git remotes to check merge conflicts, rejected stale pushes, index snapshot guards, path constraints, pairing and deployment refusal.

No live private GitHub repository or Salesforce org is needed for these checks. Those integrations require separate end-to-end testing with authorized accounts before rollout.
