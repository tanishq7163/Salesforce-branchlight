import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import Editor, { DiffEditor } from '@monaco-editor/react';
import {
  Braces,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Circle,
  CloudOff,
  Code2,
  Columns2,
  ExternalLink,
  FileCode2,
  Files,
  Folder,
  GitBranch,
  GitCommitHorizontal,
  GitCompareArrows,
  GitMerge,
  GitPullRequest,
  History,
  KeyRound,
  LockKeyhole,
  Menu,
  Minus,
  Plug,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Upload,
  X,
} from 'lucide-react';
import { ApiClient } from './api.ts';
import { createDraftStore } from './draftStore.ts';
import type { DraftScope } from './drafts.ts';
import type { ConflictVersions, SourceFile, WorkspaceView } from './contracts.ts';
import { languageFor } from './monaco.ts';

const draftStore = createDraftStore();
const pairing = new URLSearchParams(location.hash.slice(1));
const initialToken = pairing.get('pair') ?? '';
const initialApi = pairing.get('api') ?? 'http://127.0.0.1:8787';
if (pairing.has('pair')) history.replaceState(null, '', location.pathname + location.search);

const localPath = 'force-app/main/default/lwc/invoiceList/invoiceList.js';
const localFiles: Record<string, string> = {
  [localPath]:
    "import { LightningElement, api } from 'lwc';\n\nexport default class InvoiceList extends LightningElement {\n  @api accountId;\n  invoices = [];\n\n  get hasInvoices() {\n    return this.invoices.length > 0;\n  }\n}\n",
  'force-app/main/default/lwc/invoiceList/invoiceList.html':
    '<template>\n  <lightning-card title="Invoices" icon-name="standard:orders">\n    <template lwc:if={hasInvoices}>\n      <p>Invoices</p>\n    </template>\n  </lightning-card>\n</template>\n',
  'force-app/main/default/lwc/invoiceList/invoiceList.css': ':host {\n  display: block;\n}\n',
};
const localWorkspace: WorkspaceView = {
  id: 'browser-drafts',
  repository: 'local://browser-drafts',
  branch: 'drafts',
  branches: ['drafts'],
  head: '',
  indexTree: null,
  files: Object.keys(localFiles),
  changes: [],
  conflicts: [],
  history: [],
  ahead: 0,
  behind: 0,
  pullRequestUrl: null,
};

type Document = SourceFile & {
  scope: DraftScope;
  savedContent: string;
  baseContent: string;
  workingContent: string;
  revision: number;
  stale: boolean;
};
type Modal = 'connect' | 'clone' | 'branch' | 'newFile' | 'merge' | null;
type Sidebar = 'files' | 'changes' | 'history';

function IconButton({
  label,
  children,
  onClick,
  disabled = false,
  active = false,
}: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      className={`icon-button ${active ? 'active' : ''}`}
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
      <span className="tooltip">{label}</span>
    </button>
  );
}

function FileTree({
  paths,
  activePath,
  changes,
  onOpen,
}: {
  paths: string[];
  activePath: string;
  changes: Set<string>;
  onOpen: (path: string) => void;
}) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  type Node = { children: Map<string, Node>; path?: string };
  const tree: Node = { children: new Map() };
  for (const path of paths) {
    let node = tree;
    for (const part of path.split('/')) {
      if (!node.children.has(part)) node.children.set(part, { children: new Map() });
      node = node.children.get(part)!;
    }
    node.path = path;
  }
  function render(node: Node, prefix = '', depth = 0): ReactNode {
    return [...node.children.entries()].map(([name, child]) => {
      const key = `${prefix}/${name}`;
      if (child.path)
        return (
          <button
            type="button"
            key={key}
            className={`tree-file ${activePath === child.path ? 'selected' : ''}`}
            style={{ paddingLeft: 12 + depth * 12 }}
            title={child.path}
            onClick={() => onOpen(child.path!)}
          >
            <FileCode2 size={15} />
            <span>{name}</span>
            {changes.has(child.path) && <span className="file-dot" />}
          </button>
        );
      const collapsed = closed.has(key);
      return (
        <div key={key}>
          <button
            type="button"
            className="tree-folder"
            style={{ paddingLeft: 8 + depth * 12 }}
            aria-expanded={!collapsed}
            onClick={() =>
              setClosed((previous) => {
                const next = new Set(previous);
                if (collapsed) next.delete(key);
                else next.add(key);
                return next;
              })
            }
          >
            {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
            <Folder size={14} />
            <span>{name}</span>
          </button>
          {!collapsed && render(child, key, depth + 1)}
        </div>
      );
    });
  }
  return <div className="file-tree">{render(tree)}</div>;
}

export function App() {
  const [client, setClient] = useState<ApiClient | null>(null);
  const [workspace, setWorkspace] = useState(localWorkspace);
  const [workspaceList, setWorkspaceList] = useState<{ id: string; repository: string }[]>([]);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [activePath, setActivePath] = useState(localPath);
  const [sidebar, setSidebar] = useState<Sidebar>('files');
  const [sidebarVisible, setSidebarVisible] = useState(false);
  const [workflowVisible, setWorkflowVisible] = useState(false);
  const [viewMode, setViewMode] = useState<'code' | 'diff'>('code');
  const [bottomTab, setBottomTab] = useState<'changes' | 'activity'>('changes');
  const [modal, setModal] = useState<Modal>(null);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [commitMessage, setCommitMessage] = useState('');
  const [events, setEvents] = useState<{ time: string; message: string }[]>([]);
  const [conflict, setConflict] = useState<ConflictVersions | null>(null);
  const [conflictVersion, setConflictVersion] = useState<keyof ConflictVersions>('ours');
  const [apiUrl, setApiUrl] = useState(initialApi);
  const [pairToken, setPairToken] = useState(initialToken);
  const active = documents.find((document) => document.path === activePath);
  const documentsRef = useRef(documents);
  documentsRef.current = documents;
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const clientRef = useRef(client);
  clientRef.current = client;
  const operationRef = useRef(false);
  const loadSequence = useRef(0);
  const dirty = active ? active.content !== active.savedContent : false;
  const isLocal = workspace.id === localWorkspace.id;
  const protectedBranch = ['main', 'master'].includes(workspace.branch);
  const staged = workspace.changes.filter(
    (change) =>
      change.index !== ' ' && change.index !== '?' && !workspace.conflicts.includes(change.path),
  );
  const changedPaths = new Set([
    ...workspace.changes.map((change) => change.path),
    ...documents
      .filter((document) => document.content !== document.base)
      .map((document) => document.path),
  ]);
  const visibleFiles = [
    ...new Set([...workspace.files, ...documents.map((document) => document.path)]),
  ].filter((path) => path.toLowerCase().includes(query.toLowerCase()));

  function record(message: string) {
    setNotice(message);
    setEvents((previous) =>
      [
        {
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          message,
        },
        ...previous,
      ].slice(0, 30),
    );
  }

  async function run(label: string, operation: () => Promise<void>) {
    if (operationRef.current) return;
    operationRef.current = true;
    setBusy(label);
    setError('');
    try {
      await operation();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Operation failed.');
    } finally {
      operationRef.current = false;
      setBusy('');
    }
  }

  function updateDocument(path: string, change: Partial<Document>) {
    setDocuments((previous) =>
      previous.map((document) => (document.path === path ? { ...document, ...change } : document)),
    );
  }

  async function openFile(
    path: string,
    target = workspaceRef.current,
    connection = clientRef.current,
    force = false,
  ) {
    const sequence = ++loadSequence.current;
    setActivePath(path);
    const existing = documentsRef.current.find(
      (document) =>
        document.path === path &&
        document.scope.workspace === target.id &&
        document.scope.branch === target.branch,
    );
    if (existing && !force) return;
    const source: SourceFile =
      connection && target.id !== localWorkspace.id
        ? await connection.file(target.id, path, target.branch)
        : { path, content: localFiles[path] ?? '', base: localFiles[path] ?? '', hash: '' };
    const scope = {
      repository: target.repository,
      workspace: target.id,
      branch: target.branch,
      path,
    };
    const draft = await draftStore.read(scope);
    if (sequence !== loadSequence.current) return;
    const document: Document = {
      ...source,
      scope,
      content: draft?.content ?? source.content,
      savedContent: draft?.content ?? source.content,
      baseContent: draft?.baseContent ?? source.content,
      workingContent: source.content,
      revision: draft?.revision ?? 0,
      stale: Boolean(
        draft && draft.baseContent !== source.content && draft.content !== source.content,
      ),
    };
    setDocuments((previous) => [
      ...previous.filter(
        (item) =>
          item.path !== path &&
          item.scope.branch === target.branch &&
          item.scope.workspace === target.id,
      ),
      document,
    ]);
    setConflict(null);
    if (connection && target.conflicts.includes(path)) {
      setConflict(await connection.conflict(target.id, path, target.branch));
      setViewMode('diff');
    }
  }

  async function saveDocument(document: Document) {
    const draft = await draftStore.save(
      document.scope,
      document.content,
      document.baseContent ?? document.base,
      document.revision,
    );
    setDocuments((previous) =>
      previous.map((item) =>
        item.path === document.path &&
        item.scope.branch === document.scope.branch &&
        item.scope.workspace === document.scope.workspace
          ? { ...item, savedContent: draft.content, revision: draft.revision }
          : item,
      ),
    );
    return draft;
  }

  async function saveActive() {
    const document = documentsRef.current.find((item) => item.path === activePath);
    if (!document) return;
    await run('Saving draft', async () => {
      await saveDocument(document);
      record('Draft saved on this device');
    });
  }

  async function preserveDocuments() {
    for (const document of documentsRef.current) {
      if (document.content !== document.savedContent) await saveDocument(document);
    }
  }

  async function activateWorkspace(
    target: WorkspaceView,
    connection: ApiClient | null = clientRef.current,
  ) {
    await preserveDocuments();
    const savedDrafts = await draftStore.list({
      repository: target.repository,
      workspace: target.id,
      branch: target.branch,
    });
    const recovered = {
      ...target,
      files: [...new Set([...target.files, ...savedDrafts.map((draft) => draft.path)])],
    };
    setWorkspace(recovered);
    workspaceRef.current = recovered;
    documentsRef.current = [];
    setDocuments([]);
    setConflict(null);
    setQuery('');
    if (target.id !== localWorkspace.id)
      localStorage.setItem('branchlight-last-workspace', target.id);
    if (recovered.files.length)
      await openFile(
        recovered.files.find((path) => path.endsWith('.js')) ?? recovered.files[0]!,
        recovered,
        connection,
      );
  }

  async function connect(base: string, token: string) {
    const connection = new ApiClient(base, token);
    await connection.request('/health');
    const list = await connection.list();
    setWorkspaceList(list);
    setClient(connection);
    clientRef.current = connection;
    setPairToken('');
    setModal(null);
    const saved = localStorage.getItem('branchlight-last-workspace');
    const selected = list.find((item) => item.id === saved);
    if (selected) await activateWorkspace(await connection.view(selected.id), connection);
    record('Local Git service paired');
  }

  useEffect(() => {
    void activateWorkspace(localWorkspace, null).catch((caught) => setError(String(caught)));
    if (initialToken) void run('Pairing', () => connect(initialApi, initialToken));
  }, []);

  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) {
      if (documentsRef.current.some((document) => document.content !== document.savedContent))
        event.preventDefault();
    }
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveActive();
      }
    }
    window.addEventListener('keydown', shortcut, true);
    return () => window.removeEventListener('keydown', shortcut, true);
  }, [activePath]);

  async function stageActive(resolveConflict = false) {
    if (!client || !active) return;
    await run('Staging', async () => {
      if (active.stale)
        throw new Error('Compare the changed working file and mark it reconciled before staging.');
      await saveDocument(active);
      const updated = await client.action(workspace.id, 'stage', {
        path: active.path,
        content: active.content,
        expectedHash: active.hash,
        branch: workspace.branch,
        resolveConflict,
      });
      setWorkspace(updated);
      const source = await client.file(workspace.id, active.path, workspace.branch);
      updateDocument(active.path, {
        hash: source.hash,
        workingContent: source.content,
        stale: false,
      });
      setConflict(null);
      setSidebar('changes');
      record(resolveConflict ? 'Conflict resolved and staged' : 'File staged in Git');
    });
  }

  async function gitAction(action: 'push' | 'pull' | 'fetch' | 'abortMerge') {
    if (!client) return;
    await run(
      action === 'abortMerge' ? 'Aborting merge' : `${action[0]!.toUpperCase()}${action.slice(1)}`,
      async () => {
        await preserveDocuments();
        const updated = await client.action(workspace.id, action, { branch: workspace.branch });
        setWorkspace(updated);
        if (['pull', 'abortMerge'].includes(action)) await activateWorkspace(updated);
        record(
          action === 'push'
            ? 'Branch pushed to remote'
            : action === 'pull'
              ? 'Branch updated from remote'
              : action === 'fetch'
                ? 'Remote refs fetched'
                : 'Merge aborted; browser drafts preserved',
        );
      },
    );
  }

  async function switchBranch(branch: string) {
    await run('Switching branch', async () => {
      await preserveDocuments();
      const target = await client!.action(workspace.id, 'checkout', {
        branch,
        expectedBranch: workspace.branch,
      });
      await activateWorkspace(target);
      record(`Switched to ${target.branch}`);
    });
  }

  async function submitModal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const value = (name: string) => String(fields.get(name) ?? '').trim();
    await run('Working', async () => {
      if (modal === 'connect') return connect(apiUrl, pairToken);
      if (modal === 'newFile') {
        const path = value('path');
        if (!/^[A-Za-z0-9_/-]+(?:\.[A-Za-z0-9_-]+)+$/.test(path) || path.includes('..'))
          throw new Error('Enter a supported relative source path.');
        await openFile(path);
        setModal(null);
        record('New local file opened');
        return;
      }
      if (!client) throw new Error('Pair the local Git service first.');
      if (modal === 'clone') {
        await preserveDocuments();
        const target = await client.request<WorkspaceView>('/workspaces', {
          repository: value('repository'),
          authorName: value('authorName'),
          authorEmail: value('authorEmail'),
        });
        setWorkspaceList(await client.list());
        await activateWorkspace(target);
        record('Repository cloned into an isolated workspace');
      } else if (modal === 'branch') {
        await preserveDocuments();
        const target = await client.action(workspace.id, 'checkout', {
          branch: value('branch'),
          expectedBranch: workspace.branch,
          create: true,
        });
        await activateWorkspace(target);
        record(`Branch created: ${target.branch}`);
      } else if (modal === 'merge') {
        await preserveDocuments();
        const target = await client.action(workspace.id, 'merge', {
          source: value('source'),
          branch: workspace.branch,
        });
        await activateWorkspace(target);
        if (target.conflicts.length) await openFile(target.conflicts[0]!, target, client);
        record(
          target.conflicts.length
            ? 'Merge requires conflict resolution'
            : 'Branches merged locally',
        );
      }
      setModal(null);
    });
  }

  function renderChanges() {
    return (
      <div className="changes-list">
        {workspace.changes.length === 0 ? (
          <div className="empty-state">
            <CheckCheck size={22} />
            <span>No Git changes</span>
          </div>
        ) : (
          workspace.changes.map((change) => (
            <div className="change-row" key={change.path}>
              <button
                type="button"
                className="change-name"
                title={change.path}
                onClick={() => void run('Opening file', () => openFile(change.path))}
              >
                <FileCode2 size={14} />
                <span>{change.path.split('/').at(-1)}</span>
              </button>
              <span
                className={`change-code ${workspace.conflicts.includes(change.path) ? 'danger-text' : ''}`}
              >
                {workspace.conflicts.includes(change.path)
                  ? '!'
                  : change.index === '?'
                    ? 'U'
                    : change.index.trim() || change.working.trim()}
              </span>
              {change.index !== ' ' && change.index !== '?' && (
                <IconButton
                  label={`Unstage ${change.path.split('/').at(-1)}`}
                  disabled={Boolean(busy)}
                  onClick={() =>
                    void run('Unstaging', async () => {
                      setWorkspace(
                        await client!.action(workspace.id, 'unstage', {
                          path: change.path,
                          branch: workspace.branch,
                        }),
                      );
                      record('File unstaged');
                    })
                  }
                >
                  <Minus size={14} />
                </IconButton>
              )}
            </div>
          ))
        )}
      </div>
    );
  }

  return (
    <div className={`studio ${workflowVisible ? 'workflow-open' : ''}`}>
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">
            <GitBranch size={23} />
          </span>
          <span>
            Branchlight<span className="brand-secondary"> Studio</span>
          </span>
          <span className="preview-badge">PREVIEW</span>
        </div>
        <div className="header-right">
          <span className={`connection-status ${client ? 'connected' : ''}`}>
            <span className="status-dot" />
            {client ? 'Local Git connected' : 'Git disconnected'}
          </span>
          <button
            className="command secondary"
            onClick={() => setModal(client ? 'clone' : 'connect')}
          >
            <Plug size={15} />
            {client ? 'Connect repository' : 'Pair service'}
          </button>
        </div>
      </header>
      <div className="context-bar">
        <div className="repository-context">
          <IconButton label="Toggle explorer" onClick={() => setSidebarVisible(!sidebarVisible)}>
            <Menu size={17} />
          </IconButton>
          <Code2 size={16} />
          <select
            aria-label="Workspace"
            value={workspace.id}
            disabled={Boolean(busy)}
            onChange={(event) =>
              void run('Switching workspace', async () => {
                await activateWorkspace(
                  event.target.value === localWorkspace.id
                    ? localWorkspace
                    : await client!.view(event.target.value),
                );
              })
            }
          >
            <option value={localWorkspace.id}>Local browser drafts</option>
            {workspaceList.map((item) => (
              <option key={item.id} value={item.id}>
                {item.repository.replace('https://github.com/', '').replace('local://', '')} /{' '}
                {item.id.slice(0, 6)}
              </option>
            ))}
          </select>
          <span className="context-divider" />
          <GitBranch size={15} />
          <select
            aria-label="Branch"
            value={workspace.branch}
            disabled={isLocal || Boolean(busy)}
            onChange={(event) => void switchBranch(event.target.value)}
          >
            {workspace.branches.map((branch) => (
              <option key={branch}>{branch}</option>
            ))}
          </select>
          <IconButton
            label="Create branch"
            disabled={isLocal || Boolean(busy)}
            onClick={() => setModal('branch')}
          >
            <Plus size={15} />
          </IconButton>
        </div>
        <div className="org-context">
          <LockKeyhole size={14} />
          <span>No Salesforce org connected</span>
          <span className="deployment-disabled">Deployment disabled</span>
        </div>
      </div>
      <div className="workbench">
        <nav className="activity-rail" aria-label="Workspace views">
          <IconButton
            label="Explorer"
            active={sidebar === 'files'}
            onClick={() => {
              setSidebar('files');
              setSidebarVisible(true);
              setWorkflowVisible(false);
            }}
          >
            <Files size={21} />
          </IconButton>
          <IconButton
            label="Source control"
            active={sidebar === 'changes'}
            onClick={() => {
              setSidebar('changes');
              setSidebarVisible(true);
              setWorkflowVisible(false);
            }}
          >
            <GitBranch size={21} />
          </IconButton>
          <IconButton
            label="Commit history"
            active={sidebar === 'history'}
            onClick={() => {
              setSidebar('history');
              setSidebarVisible(true);
              setWorkflowVisible(false);
            }}
          >
            <History size={21} />
          </IconButton>
          <IconButton
            label="Branch workflow"
            active={workflowVisible}
            onClick={() => {
              setWorkflowVisible(!workflowVisible);
              setSidebarVisible(false);
            }}
          >
            <GitPullRequest size={21} />
          </IconButton>
          <div className="rail-spacer" />
          <IconButton label="Connection settings" onClick={() => setModal('connect')}>
            <KeyRound size={20} />
          </IconButton>
        </nav>
        <aside className={`sidebar ${sidebarVisible ? 'mobile-open' : ''}`}>
          <div className="section-heading">
            <span>
              {sidebar === 'files'
                ? 'EXPLORER'
                : sidebar === 'changes'
                  ? 'SOURCE CONTROL'
                  : 'COMMIT HISTORY'}
            </span>
            <div>
              <IconButton
                label="Refresh workspace"
                disabled={isLocal || Boolean(busy)}
                onClick={() =>
                  void run('Refreshing', async () => {
                    await preserveDocuments();
                    setWorkspace(await client!.view(workspace.id));
                    if (active) await openFile(active.path, workspace, client, true);
                    record('Workspace refreshed');
                  })
                }
              >
                <RefreshCw size={14} />
              </IconButton>
              {sidebar === 'files' && (
                <IconButton
                  label="New file"
                  disabled={Boolean(busy)}
                  onClick={() => setModal('newFile')}
                >
                  <Plus size={15} />
                </IconButton>
              )}
            </div>
          </div>
          {sidebar === 'files' ? (
            <>
              <label className="search-input">
                <Search size={14} />
                <input
                  aria-label="Find file"
                  placeholder="Find file"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <div className="tree-root">
                <ChevronDown size={13} />
                <span>
                  {isLocal
                    ? 'LOCAL DRAFTS'
                    : workspace.repository.replace(/.*\//, '').replace(/\.git$/, '')}
                </span>
                <span className="count">{visibleFiles.length}</span>
              </div>
              <FileTree
                paths={visibleFiles}
                activePath={activePath}
                changes={changedPaths}
                onOpen={(path) => {
                  setSidebarVisible(false);
                  void run('Opening file', () => openFile(path));
                }}
              />
            </>
          ) : sidebar === 'changes' ? (
            <>
              <div className="sidebar-summary">
                <span>{workspace.changes.length} changed files</span>
                <span>{staged.length} staged</span>
              </div>
              {renderChanges()}
              <div className="draft-summary">
                <Save size={14} />
                {documents.filter((document) => document.content !== document.base).length} open
                local drafts
              </div>
            </>
          ) : (
            <div className="history-list">
              {workspace.history.length ? (
                workspace.history.map((commit) => (
                  <div className="history-entry" key={commit.hash}>
                    <GitCommitHorizontal size={16} />
                    <div>
                      <strong>{commit.message}</strong>
                      <span>
                        {commit.author} <code>{commit.hash.slice(0, 7)}</code>
                      </span>
                    </div>
                  </div>
                ))
              ) : (
                <div className="empty-state">
                  <History size={22} />
                  <span>No Git history</span>
                </div>
              )}
            </div>
          )}
          <div className="sidebar-footer">
            <span>
              <ShieldCheck size={14} />
              {isLocal ? 'On-device drafts' : 'Isolated Git workspace'}
            </span>
            <small>{workspace.head ? workspace.head.slice(0, 8) : 'No remote repository'}</small>
          </div>
        </aside>
        <main className="editor-column">
          <div className="document-tabs" role="tablist" aria-label="Open files">
            {documents.map((document) => (
              <div
                className={`document-tab ${document.path === activePath ? 'selected' : ''}`}
                key={document.path}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={document.path === activePath}
                  onClick={() => {
                    setActivePath(document.path);
                    setConflict(null);
                    if (workspace.conflicts.includes(document.path))
                      void run('Loading conflict', async () => {
                        setConflict(
                          await client!.conflict(workspace.id, document.path, workspace.branch),
                        );
                      });
                  }}
                >
                  <FileCode2 size={14} />
                  <span>{document.path.split('/').at(-1)}</span>
                  {document.content !== document.savedContent && (
                    <Circle size={7} fill="currentColor" />
                  )}
                </button>
                <IconButton
                  label={`Close ${document.path.split('/').at(-1)}`}
                  onClick={() =>
                    void run('Closing file', async () => {
                      if (document.content !== document.savedContent) await saveDocument(document);
                      const remaining = documents.filter((item) => item.path !== document.path);
                      setDocuments(remaining);
                      if (document.path === activePath) setActivePath(remaining[0]?.path ?? '');
                    })
                  }
                >
                  <X size={12} />
                </IconButton>
              </div>
            ))}
          </div>
          <div className="editor-toolbar">
            <div className="breadcrumb">
              <span>{activePath.split('/').slice(-2, -1)}</span>
              <ChevronRight size={12} />
              <strong>{activePath.split('/').at(-1) ?? 'No file open'}</strong>
            </div>
            <div className="editor-tools">
              <div className="segmented" role="group" aria-label="Editor mode">
                <IconButton
                  label="Code view"
                  active={viewMode === 'code'}
                  onClick={() => setViewMode('code')}
                >
                  <Code2 size={15} />
                </IconButton>
                <IconButton
                  label="Diff view"
                  active={viewMode === 'diff'}
                  onClick={() => setViewMode('diff')}
                >
                  <Columns2 size={15} />
                </IconButton>
              </div>
              <span className="context-divider" />
              <IconButton
                label="Save draft"
                disabled={!active || Boolean(busy)}
                onClick={() => void saveActive()}
              >
                <Save size={16} />
              </IconButton>
              <button
                type="button"
                className="command compact"
                disabled={
                  !client || isLocal || protectedBranch || !active || active.stale || Boolean(busy)
                }
                onClick={() => void stageActive(Boolean(conflict))}
              >
                <Plus size={14} />
                {conflict ? 'Resolve & stage' : 'Stage file'}
              </button>
            </div>
          </div>
          {protectedBranch && (
            <div className="inline-alert warning">
              <GitBranch size={15} />
              <span>Protected local branch: {workspace.branch}</span>
              <button type="button" onClick={() => setModal('branch')}>
                Create feature branch
              </button>
            </div>
          )}
          {active?.stale && (
            <div className="inline-alert warning">
              <GitCompareArrows size={15} />
              <span>Working file changed since this draft.</span>
              <button type="button" onClick={() => setViewMode('diff')}>
                Compare
              </button>
              <button type="button" onClick={() => updateDocument(active.path, { stale: false })}>
                Mark reconciled
              </button>
            </div>
          )}
          {conflict && (
            <div className="conflict-toolbar">
              <GitMerge size={15} />
              <span>Conflict</span>
              <select
                aria-label="Conflict original version"
                value={conflictVersion}
                onChange={(event) =>
                  setConflictVersion(event.target.value as keyof ConflictVersions)
                }
              >
                <option value="base">Base</option>
                <option value="ours">Ours</option>
                <option value="theirs">Theirs</option>
              </select>
              <button
                type="button"
                onClick={() => updateDocument(activePath, { content: conflict.ours, stale: false })}
              >
                Use ours
              </button>
              <button
                type="button"
                onClick={() =>
                  updateDocument(activePath, { content: conflict.theirs, stale: false })
                }
              >
                Use theirs
              </button>
            </div>
          )}
          <div className="editor-surface" data-testid="editor-surface">
            {active ? (
              viewMode === 'code' ? (
                <Editor
                  path={`${workspace.id}/${workspace.branch}/${active.path}`}
                  language={languageFor(active.path)}
                  value={active.content}
                  theme="branchlight"
                  loading={<div className="editor-loading">Loading editor...</div>}
                  onChange={(content) => updateDocument(active.path, { content: content ?? '' })}
                  options={{
                    fontFamily: 'IBM Plex Mono',
                    fontSize: 13,
                    lineHeight: 23,
                    minimap: { enabled: false },
                    padding: { top: 18 },
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    readOnly: Boolean(busy),
                    tabSize: 2,
                    wordWrap: 'on',
                    renderLineHighlight: 'line',
                    ariaLabel: 'Source code editor',
                  }}
                />
              ) : (
                <DiffEditor
                  original={
                    conflict
                      ? conflict[conflictVersion]
                      : active.stale
                        ? active.workingContent
                        : active.base
                  }
                  modified={active.content}
                  language={languageFor(active.path)}
                  theme="branchlight"
                  loading={<div className="editor-loading">Loading diff...</div>}
                  onMount={(editor) => {
                    editor.getModifiedEditor().onDidChangeModelContent(() => {
                      const content = editor.getModifiedEditor().getValue();
                      setDocuments((previous) =>
                        previous.map((document) =>
                          document.path === activePath ? { ...document, content } : document,
                        ),
                      );
                    });
                  }}
                  options={{
                    fontFamily: 'IBM Plex Mono',
                    fontSize: 12,
                    lineHeight: 22,
                    minimap: { enabled: false },
                    readOnly: Boolean(busy),
                    originalEditable: false,
                    automaticLayout: true,
                    renderSideBySide: true,
                    scrollBeyondLastLine: false,
                  }}
                />
              )
            ) : (
              <div className="empty-editor">
                <Braces size={38} />
                <span>No file open</span>
              </div>
            )}
          </div>
          <section className="bottom-panel">
            <div className="panel-tabs">
              <button
                type="button"
                className={bottomTab === 'changes' ? 'selected' : ''}
                onClick={() => setBottomTab('changes')}
              >
                Changes <span className="count">{workspace.changes.length}</span>
              </button>
              <button
                type="button"
                className={bottomTab === 'activity' ? 'selected' : ''}
                onClick={() => setBottomTab('activity')}
              >
                Activity
              </button>
              <span className="panel-spacer" />
              <span className="panel-caption">
                {busy || (isLocal ? 'Browser workspace' : 'Git working tree')}
              </span>
            </div>
            {bottomTab === 'changes' ? (
              <div className="bottom-changes">
                {workspace.changes.length ? (
                  workspace.changes.map((change) => (
                    <button
                      type="button"
                      key={change.path}
                      onClick={() => void run('Opening file', () => openFile(change.path))}
                    >
                      <FileCode2 size={14} />
                      <span>{change.path}</span>
                      <code>
                        {workspace.conflicts.includes(change.path)
                          ? 'CONFLICT'
                          : change.index === '?'
                            ? 'UNTRACKED'
                            : change.index.trim()
                              ? 'STAGED'
                              : 'MODIFIED'}
                      </code>
                    </button>
                  ))
                ) : (
                  <div className="clean-state">
                    <CheckCheck size={17} />
                    <span>{isLocal ? 'No Git repository connected' : 'Working tree clean'}</span>
                  </div>
                )}
              </div>
            ) : (
              <div className="activity-list">
                {events.length ? (
                  events.map((event, index) => (
                    <div key={`${index}-${event.time}`}>
                      <code>{event.time}</code>
                      <span>{event.message}</span>
                    </div>
                  ))
                ) : (
                  <div className="clean-state">
                    <History size={17} />
                    <span>No activity yet</span>
                  </div>
                )}
              </div>
            )}
          </section>
        </main>
        <aside className="release-sidebar">
          <div className="section-heading">
            <span>BRANCH WORKFLOW</span>
            <GitBranch size={15} />
          </div>
          <div className="workflow-branch">
            <span className="eyebrow">ACTIVE BRANCH</span>
            <strong>
              <GitBranch size={16} />
              {workspace.branch}
            </strong>
            <div>
              <span>{workspace.ahead} ahead</span>
              <span>{workspace.behind} behind</span>
            </div>
          </div>
          <div className="commit-section">
            <div className="subheading">
              <span>Commit</span>
              <span className="count">{staged.length} staged</span>
            </div>
            <textarea
              aria-label="Commit message"
              placeholder="Commit message"
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
              rows={3}
            />
            <button
              type="button"
              className="command primary full"
              disabled={
                !client ||
                isLocal ||
                protectedBranch ||
                !staged.length ||
                !commitMessage.trim() ||
                Boolean(busy) ||
                workspace.conflicts.length > 0
              }
              onClick={() =>
                void run('Committing', async () => {
                  const updated = await client!.action(workspace.id, 'commit', {
                    message: commitMessage,
                    branch: workspace.branch,
                    head: workspace.head,
                    indexTree: workspace.indexTree,
                  });
                  setWorkspace(updated);
                  setCommitMessage('');
                  record('Staged changes committed locally');
                })
              }
            >
              <GitCommitHorizontal size={16} />
              Commit staged
            </button>
          </div>
          <div className="remote-section">
            <div className="subheading">
              <span>Remote</span>
              {isLocal ? <CloudOff size={15} /> : <span className="subtle">origin</span>}
            </div>
            <div className="remote-actions">
              <button
                type="button"
                className="command secondary"
                disabled={!client || isLocal || Boolean(busy)}
                onClick={() => void gitAction('fetch')}
              >
                <RefreshCw size={14} />
                Fetch
              </button>
              <button
                type="button"
                className="command secondary"
                disabled={!client || isLocal || Boolean(busy)}
                onClick={() => void gitAction('pull')}
              >
                <ChevronDown size={14} />
                Pull
              </button>
            </div>
            <button
              type="button"
              className="command secondary full"
              disabled={!client || isLocal || protectedBranch || Boolean(busy)}
              onClick={() => void gitAction('push')}
            >
              <Upload size={15} />
              Push branch
            </button>
            <button
              type="button"
              className="command text full"
              disabled={!client || isLocal || protectedBranch || Boolean(busy)}
              onClick={() => setModal('merge')}
            >
              <GitMerge size={15} />
              Merge branch
            </button>
            {workspace.conflicts.length > 0 && (
              <button
                type="button"
                className="command text full danger-text"
                disabled={Boolean(busy)}
                onClick={() => void gitAction('abortMerge')}
              >
                <X size={15} />
                Abort merge
              </button>
            )}
          </div>
          <div className="review-section">
            <div className="subheading">
              <span>Review</span>
              <GitPullRequest size={15} />
            </div>
            <button
              type="button"
              className="command secondary full"
              disabled={!workspace.pullRequestUrl || protectedBranch || Boolean(busy)}
              onClick={() =>
                window.open(workspace.pullRequestUrl!, '_blank', 'noopener,noreferrer')
              }
            >
              <GitPullRequest size={15} />
              Open pull request
              <ExternalLink size={13} />
            </button>
            <span className="review-state">
              {workspace.pullRequestUrl ? 'GitHub compare view' : 'No GitHub repository'}
            </span>
          </div>
          <div className="release-section">
            <div className="subheading">
              <span>Salesforce</span>
              <LockKeyhole size={15} />
            </div>
            <div className="release-state">
              <span className="lock-icon">
                <LockKeyhole size={19} />
              </span>
              <div>
                <strong>Deployment disabled</strong>
                <span>No org connected</span>
              </div>
            </div>
            <button type="button" className="command secondary full" disabled>
              <ShieldCheck size={15} />
              Deploy approved release
            </button>
          </div>
          <div className="local-start">
            <button
              type="button"
              className="command text full"
              disabled={Boolean(busy)}
              onClick={() => {
                if (!client) {
                  setModal('connect');
                  return;
                }
                void run('Creating workspace', async () => {
                  const target = await client.request<WorkspaceView>('/starter', {});
                  setWorkspaceList(await client.list());
                  await activateWorkspace(target);
                  record('Local example Git workspace created');
                });
              }}
            >
              <Plus size={15} />
              Create local Git example
            </button>
          </div>
        </aside>
      </div>
      {(error || notice) && (
        <div className={`notification ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>
          {error ? <X size={15} /> : <Check size={15} />}
          <span>{error || notice}</span>
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => {
              setError('');
              setNotice('');
            }}
          >
            <X size={14} />
          </button>
        </div>
      )}
      <footer className="status-bar">
        <span>
          <GitBranch size={13} />
          {workspace.branch}
          {workspace.head && <code>{workspace.head.slice(0, 7)}</code>}
        </span>
        <span>
          <ShieldCheck size={13} />
          {dirty ? 'Unsaved draft' : active?.revision ? 'Draft saved locally' : 'No local changes'}
        </span>
        <div className="status-spacer" />
        <span>{active ? languageFor(active.path).toUpperCase() : ''}</span>
        <span>UTF-8</span>
        <span>
          <LockKeyhole size={12} />
          No org writes
        </span>
      </footer>
      {modal && (
        <div className="modal-backdrop" onClick={() => !busy && setModal(null)}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <h2 id="modal-title">
                {modal === 'connect'
                  ? 'Pair local Git service'
                  : modal === 'clone'
                    ? 'Connect GitHub repository'
                    : modal === 'branch'
                      ? 'Create feature branch'
                      : modal === 'newFile'
                        ? 'New source file'
                        : 'Merge branch'}
              </h2>
              <IconButton
                label="Close dialog"
                disabled={Boolean(busy)}
                onClick={() => setModal(null)}
              >
                <X size={18} />
              </IconButton>
            </div>
            <form onSubmit={(event) => void submitModal(event)}>
              {modal === 'connect' ? (
                <>
                  <label>
                    Backend URL
                    <input
                      required
                      value={apiUrl}
                      onChange={(event) => setApiUrl(event.target.value)}
                    />
                  </label>
                  <label>
                    Pairing token
                    <input
                      type="password"
                      required
                      autoComplete="off"
                      value={pairToken}
                      onChange={(event) => setPairToken(event.target.value)}
                    />
                  </label>
                </>
              ) : modal === 'clone' ? (
                <>
                  <label>
                    Private repository URL
                    <input
                      name="repository"
                      type="url"
                      required
                      placeholder="https://github.com/team/salesforce-source.git"
                    />
                  </label>
                  <div className="form-row">
                    <label>
                      Commit author
                      <input name="authorName" required />
                    </label>
                    <label>
                      Author email
                      <input name="authorEmail" type="email" required />
                    </label>
                  </div>
                </>
              ) : modal === 'branch' ? (
                <label>
                  Branch name
                  <input name="branch" required placeholder="feature/invoice-update" />
                </label>
              ) : modal === 'newFile' ? (
                <label>
                  Source path
                  <input
                    name="path"
                    required
                    placeholder="force-app/main/default/classes/Invoice.cls"
                  />
                </label>
              ) : (
                <label>
                  Source branch
                  <select
                    name="source"
                    defaultValue={workspace.branches.find((branch) => branch !== workspace.branch)}
                  >
                    {workspace.branches
                      .filter((branch) => branch !== workspace.branch)
                      .map((branch) => (
                        <option key={branch}>{branch}</option>
                      ))}
                  </select>
                </label>
              )}
              {error && (
                <div className="form-error" role="alert">
                  {error}
                </div>
              )}
              <div className="modal-actions">
                <button
                  type="button"
                  className="command secondary"
                  disabled={Boolean(busy)}
                  onClick={() => setModal(null)}
                >
                  Cancel
                </button>
                <button type="submit" className="command primary" disabled={Boolean(busy)}>
                  {modal === 'connect' ? (
                    <Plug size={15} />
                  ) : modal === 'merge' ? (
                    <GitMerge size={15} />
                  ) : (
                    <Plus size={15} />
                  )}
                  {busy ||
                    (modal === 'connect'
                      ? 'Pair service'
                      : modal === 'clone'
                        ? 'Clone repository'
                        : modal === 'merge'
                          ? 'Merge locally'
                          : 'Create')}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
