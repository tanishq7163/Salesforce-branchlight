import { useEffect, useRef, useState } from 'react';
import {
  Building2,
  Check,
  ExternalLink,
  GitFork as Github,
  GitBranch,
  Link,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Plus,
  RefreshCw,
  ShieldCheck,
  Unplug,
  X,
} from 'lucide-react';
import { HostedClient } from './hostedClient.ts';
import type {
  AvailableRepository,
  HostedCapabilities,
  OrgSummary,
  RepoSummary,
  TenantSummary,
} from './hostedClient.ts';

export function HostedApp({ apiUrl }: { apiUrl: string }) {
  const [api] = useState(() => new HostedClient(apiUrl, import.meta.env.DEV));
  const [capabilities, setCapabilities] = useState<HostedCapabilities | null>(null);
  const [account, setAccount] = useState<{ id: string; login: string } | null>(null);
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [tenantId, setTenantId] = useState('');
  const [tenantName, setTenantName] = useState('');
  const [repos, setRepos] = useState<RepoSummary[]>([]);
  const [available, setAvailable] = useState<AvailableRepository[]>([]);
  const [selectedRepo, setSelectedRepo] = useState('');
  const [orgs, setOrgs] = useState<OrgSummary[]>([]);
  const [authority, setAuthority] = useState('https://test.salesforce.com');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [audit, setAudit] = useState<{ id: string; action: string; created_at: string }[]>([]);
  const [tab, setTab] = useState<'connections' | 'audit'>('connections');
  const running = useRef(false);
  const sequence = useRef(0);
  const tenant = tenants.find((item) => item.id === tenantId);

  async function run(label: string, operation: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(label);
    setError('');
    setNotice('');
    try {
      await operation();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Operation failed.');
    } finally {
      running.current = false;
      setBusy('');
    }
  }
  async function loadAccount() {
    const identity = await api.request<{ user: { id: string; login: string } }>('/api/v1/session');
    const list = await api.request<TenantSummary[]>('/api/v1/tenants');
    setAccount(identity.user);
    setTenants(list);
    setTenantId((current) =>
      list.some((item) => item.id === current) ? current : (list[0]?.id ?? ''),
    );
  }
  async function loadConnections(id: string) {
    const request = ++sequence.current;
    const [repositories, connections] = await Promise.all([
      api.request<RepoSummary[]>(`/api/v1/tenants/${id}/repositories`),
      api.request<OrgSummary[]>(`/api/v1/tenants/${id}/salesforce`),
    ]);
    if (request === sequence.current) {
      setRepos(repositories);
      setOrgs(connections);
    }
  }
  useEffect(() => {
    void run('Connecting', async () => {
      setCapabilities(await api.request<HostedCapabilities>('/api/v1/capabilities'));
      const pendingText = sessionStorage.getItem('branchlight.pending-auth');
      const returned = location.href;
      if (location.hash) history.replaceState(null, '', location.pathname + location.search);
      if (pendingText) {
        sessionStorage.removeItem('branchlight.pending-auth');
        const pending = JSON.parse(pendingText);
        if (
          pending.api === api.base &&
          (pending.provider === 'github' || pending.provider === 'salesforce')
        ) {
          await api.restore();
          await api.finish(returned, pending.verifier, pending.provider);
        }
      }
      if (await api.restore()) await loadAccount();
    });
  }, []);
  useEffect(() => {
    setAvailable([]);
    setSelectedRepo('');
    setRepos([]);
    setOrgs([]);
    setAudit([]);
    setTab('connections');
    if (tenantId)
      void loadConnections(tenantId).catch((caught) =>
        setError(caught instanceof Error ? caught.message : 'Connection listing failed.'),
      );
  }, [tenantId]);

  return (
    <div className="hosted-shell">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">
            <GitBranch size={23} />
          </span>
          <span>
            Branchlight<span className="brand-secondary"> Studio</span>
          </span>
        </div>
        <div className="header-right">
          <span className="hosted-mode">{capabilities?.mode ?? 'Connecting'}</span>
          {account && (
            <>
              <span className="hosted-account">
                <Github size={15} />
                {account.login}
              </span>
              <button
                className="command secondary"
                disabled={Boolean(busy)}
                onClick={() =>
                  void run('Signing out', async () => {
                    try {
                      await api.request('/api/v1/logout', {});
                    } finally {
                      await api.clear();
                      sequence.current++;
                      setAccount(null);
                      setTenants([]);
                      setTenantId('');
                      setRepos([]);
                      setOrgs([]);
                      setAvailable([]);
                      setAudit([]);
                    }
                  })
                }
              >
                <LogOut size={14} />
                Sign out
              </button>
            </>
          )}
        </div>
      </header>
      <div className="hosted-layout">
        <aside className="hosted-navigation">
          <div className="section-heading">
            <span>ORGANIZATIONS</span>
            <Building2 size={15} />
          </div>
          {account ? (
            <>
              <label className="hosted-label">
                Active organization
                <select
                  aria-label="Active organization"
                  value={tenantId}
                  disabled={Boolean(busy)}
                  onChange={(event) => setTenantId(event.target.value)}
                >
                  <option value="">Select organization</option>
                  {tenants.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <form
                className="hosted-create"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run('Creating organization', async () => {
                    const created = await api.request<TenantSummary>('/api/v1/tenants', {
                      name: tenantName,
                    });
                    setTenants((previous) => [...previous, created]);
                    setTenantId(created.id);
                    setTenantName('');
                    setNotice('Organization created');
                  });
                }}
              >
                <label className="hosted-label">
                  New organization
                  <input
                    aria-label="New organization"
                    required
                    maxLength={100}
                    value={tenantName}
                    onChange={(event) => setTenantName(event.target.value)}
                  />
                </label>
                <button
                  className="command secondary full"
                  disabled={Boolean(busy) || !tenantName.trim()}
                >
                  <Plus size={14} />
                  Create organization
                </button>
              </form>
            </>
          ) : (
            <div className="hosted-nav-state">
              <LockKeyhole size={18} />
              <span>Sign-in required</span>
            </div>
          )}
          <div className="hosted-nav-footer">
            <ShieldCheck size={15} />
            <span>Production deployment disabled</span>
          </div>
        </aside>
        <main className="hosted-content">
          {!account ? (
            <section className="hosted-signin">
              <Github size={28} />
              <h1>Account</h1>
              <button
                className="command primary"
                disabled={!capabilities?.githubSignIn || Boolean(busy)}
                onClick={() =>
                  void run('Signing in', async () => {
                    await api.authorize('github');
                    await loadAccount();
                  })
                }
              >
                <Github size={16} />
                Sign in with GitHub
              </button>
              {capabilities && !capabilities.githubSignIn && (
                <div className="hosted-warning" role="status">
                  GitHub App registration is not configured.
                </div>
              )}
            </section>
          ) : (
            <>
              <div className="hosted-page-heading">
                <div>
                  <span className="eyebrow">{tenant?.role ?? 'ACCOUNT'}</span>
                  <h1>{tenant?.name ?? 'Organizations'}</h1>
                </div>
                <button
                  className="command secondary"
                  disabled={!tenantId || Boolean(busy)}
                  onClick={() => void run('Refreshing', () => loadConnections(tenantId))}
                >
                  <RefreshCw size={14} />
                  Refresh
                </button>
              </div>
              {tenantId ? (
                <>
                  <div className="hosted-tabs">
                    <button
                      className={tab === 'connections' ? 'selected' : ''}
                      onClick={() => setTab('connections')}
                    >
                      Connections
                    </button>
                    {tenant?.role === 'admin' && (
                      <button
                        className={tab === 'audit' ? 'selected' : ''}
                        onClick={() =>
                          void run('Loading audit', async () => {
                            setAudit(await api.request(`/api/v1/tenants/${tenantId}/audit`));
                            setTab('audit');
                          })
                        }
                      >
                        Audit
                      </button>
                    )}
                  </div>
                  {tab === 'connections' ? (
                    <>
                      <section className="hosted-band">
                        <div className="hosted-band-title">
                          <Github size={20} />
                          <h2>GitHub repositories</h2>
                        </div>
                        <div className="hosted-actions">
                          {capabilities?.githubInstallUrl && (
                            <a
                              className="command secondary"
                              href={capabilities.githubInstallUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              <ExternalLink size={14} />
                              Install GitHub App
                            </a>
                          )}
                          <button
                            className="command secondary"
                            disabled={!capabilities?.githubSignIn || Boolean(busy)}
                            onClick={() =>
                              void run('Loading repositories', async () => {
                                setAvailable(
                                  await api.request(
                                    `/api/v1/tenants/${tenantId}/github/repositories`,
                                  ),
                                );
                              })
                            }
                          >
                            <RefreshCw size={14} />
                            Find repositories
                          </button>
                        </div>
                        {available.length > 0 && (
                          <form
                            className="hosted-inline-form"
                            onSubmit={(event) => {
                              event.preventDefault();
                              void run('Connecting repository', async () => {
                                await api.request(`/api/v1/tenants/${tenantId}/repositories`, {
                                  githubId: Number(selectedRepo),
                                });
                                await loadConnections(tenantId);
                                setNotice('Repository connected');
                              });
                            }}
                          >
                            <label className="hosted-label">
                              Repository
                              <select
                                aria-label="Repository"
                                required
                                value={selectedRepo}
                                onChange={(event) => setSelectedRepo(event.target.value)}
                              >
                                <option value="">Select repository</option>
                                {available.map((repository) => (
                                  <option
                                    key={`${repository.installationId}-${repository.id}`}
                                    value={repository.id}
                                  >
                                    {repository.name}
                                    {repository.private ? ' (private)' : ''}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <button
                              className="command primary"
                              disabled={!selectedRepo || tenant?.role !== 'admin' || Boolean(busy)}
                            >
                              <Link size={14} />
                              Connect repository
                            </button>
                          </form>
                        )}
                        <div className="hosted-resource-list">
                          {repos.length ? (
                            repos.map((repository) => (
                              <div className="hosted-resource" key={repository.id}>
                                <Github size={17} />
                                <strong>{repository.full_name}</strong>
                                <span>{repository.default_branch}</span>
                                <Check size={15} />
                              </div>
                            ))
                          ) : (
                            <div className="hosted-empty">No connected repositories</div>
                          )}
                        </div>
                      </section>
                      <section className="hosted-band">
                        <div className="hosted-band-title">
                          <ShieldCheck size={20} />
                          <h2>Salesforce orgs</h2>
                        </div>
                        <form
                          className="hosted-inline-form"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void run('Connecting Salesforce', async () => {
                              await api.authorize('salesforce', tenantId, authority);
                              await loadConnections(tenantId);
                              setNotice('Salesforce connection updated');
                            });
                          }}
                        >
                          <label className="hosted-label">
                            Salesforce login URL
                            <input
                              aria-label="Salesforce login URL"
                              type="url"
                              required
                              value={authority}
                              onChange={(event) => setAuthority(event.target.value)}
                            />
                          </label>
                          <button
                            className="command primary"
                            disabled={!capabilities?.salesforceConnections || Boolean(busy)}
                          >
                            <Link size={14} />
                            Connect Salesforce
                          </button>
                        </form>
                        {!capabilities?.salesforceConnections && (
                          <div className="hosted-warning">
                            Salesforce External Client App is not configured.
                          </div>
                        )}
                        <div className="hosted-resource-list">
                          {orgs.length ? (
                            orgs.map((org) => (
                              <div className="hosted-resource" key={org.id}>
                                <ShieldCheck size={17} />
                                <div>
                                  <strong>{org.label}</strong>
                                  <small>{org.external_id}</small>
                                </div>
                                <span className={`org-environment ${org.environment}`}>
                                  {org.environment}
                                </span>
                                <button
                                  className="icon-button"
                                  title="Disconnect local authorization"
                                  aria-label={`Disconnect ${org.label}`}
                                  disabled={Boolean(busy)}
                                  onClick={() =>
                                    void run('Disconnecting', async () => {
                                      await api.request(
                                        `/api/v1/tenants/${tenantId}/salesforce/${org.id}/disconnect`,
                                        {},
                                      );
                                      await loadConnections(tenantId);
                                      setNotice(
                                        'Local authorization removed. Revoke the app in Salesforce to remove upstream authorization.',
                                      );
                                    })
                                  }
                                >
                                  <Unplug size={15} />
                                </button>
                              </div>
                            ))
                          ) : (
                            <div className="hosted-empty">No connected orgs</div>
                          )}
                        </div>
                      </section>
                      <section className="hosted-band hosted-release-state">
                        <LockKeyhole size={18} />
                        <div>
                          <h2>Release controls</h2>
                          <span>
                            Hosted workspaces and deployments unavailable in this milestone
                          </span>
                        </div>
                      </section>
                    </>
                  ) : (
                    <section className="hosted-band">
                      <h2>Audit events</h2>
                      {audit.length ? (
                        audit.map((event) => (
                          <div className="hosted-audit" key={event.id}>
                            <span>{event.action}</span>
                            <time>{new Date(event.created_at).toLocaleString()}</time>
                          </div>
                        ))
                      ) : (
                        <div className="hosted-empty">No audit events</div>
                      )}
                    </section>
                  )}
                </>
              ) : (
                <div className="hosted-empty">No organization selected</div>
              )}
            </>
          )}
        </main>
      </div>
      {(error || notice || busy) && (
        <div className={`notification ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>
          {error ? (
            <X size={15} />
          ) : busy ? (
            <LoaderCircle size={15} className="spin" />
          ) : (
            <Check size={15} />
          )}
          <span>{error || busy || notice}</span>
          {!busy && (
            <button
              aria-label="Dismiss notification"
              onClick={() => {
                setError('');
                setNotice('');
              }}
            >
              <X size={14} />
            </button>
          )}
        </div>
      )}
      <footer className="hosted-footer">
        <LockKeyhole size={13} />
        <span>{new URL(api.base).host}</span>
        <span>Deployment disabled</span>
      </footer>
    </div>
  );
}
