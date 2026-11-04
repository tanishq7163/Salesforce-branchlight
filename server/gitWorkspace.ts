import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { simpleGit } from 'simple-git';
import type { SimpleGit } from 'simple-git';
import type { ConflictVersions, SourceFile, WorkspaceView } from '../src/contracts.ts';

export class WorkspaceError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 409) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function validateBranch(branch: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,149}$/.test(branch) || /\.\.|\/\/|[/.]$/.test(branch)) {
    throw new WorkspaceError('Invalid branch name.', 400);
  }
}

export function validateSourcePath(path: string): void {
  if (
    !path ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.includes(':') ||
    path.split('/').some((part) => !part || part.startsWith('.')) ||
    !/\.(cls|trigger|js|ts|html|css|xml|cmp|app|evt|design|auradoc|svg|page|component|json|md)$/.test(
      path,
    )
  ) {
    throw new WorkspaceError(
      'Only supported source files inside the workspace can be accessed.',
      400,
    );
  }
}

export function githubCompareUrl(repository: string, branch: string): string | null {
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(repository);
  return match
    ? `https://github.com/${match[1]}/compare/${encodeURIComponent(branch)}?expand=1`
    : null;
}

export class GitWorkspace {
  root: string;
  id: string;
  repository: string;
  git: SimpleGit;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(root: string, id: string, repository: string) {
    this.root = resolve(root);
    this.id = id;
    this.repository = repository;
    this.git = simpleGit({
      baseDir: this.root,
      timeout: { block: 60_000 },
      unsafe: { allowUnsafeHooksPath: true, allowUnsafeFsMonitor: true },
      config: [
        'core.hooksPath=' + resolve(this.root, '..', 'disabled-hooks'),
        'core.fsmonitor=false',
        'commit.gpgSign=false',
      ],
    });
  }

  private exclusive<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }

  private async assertBranch(expectedBranch: string, editing = false) {
    const status = await this.git.status();
    if (status.current !== expectedBranch) {
      throw new WorkspaceError('The active branch changed. Refresh the workspace first.');
    }
    if (editing && ['main', 'master'].includes(expectedBranch)) {
      throw new WorkspaceError('Create a feature branch before staging, committing or pushing.');
    }
    return status;
  }

  private async safePath(path: string): Promise<string> {
    validateSourcePath(path);
    const target = resolve(this.root, path);
    const relativePath = relative(this.root, target);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new WorkspaceError('Path is outside the workspace.', 400);
    }
    let cursor = this.root;
    for (const part of path.split('/')) {
      cursor = resolve(cursor, part);
      try {
        if ((await lstat(cursor)).isSymbolicLink()) {
          throw new WorkspaceError('Symbolic links are not supported.', 400);
        }
        const actual = await realpath(cursor);
        const actualRelative = relative(await realpath(this.root), actual);
        if (actualRelative.startsWith('..') || isAbsolute(actualRelative)) {
          throw new WorkspaceError('Path is outside the workspace.', 400);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return target;
  }

  private async readCurrent(path: string): Promise<string> {
    const target = await this.safePath(path);
    try {
      const info = await lstat(target);
      if (!info.isFile() || info.size > 2_000_000)
        throw new WorkspaceError('Source file is too large or is not a regular file.', 400);
      const content = await readFile(target, 'utf8');
      if (content.includes('\0')) throw new WorkspaceError('Binary files are not supported.', 400);
      return content;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    }
  }

  async view(): Promise<WorkspaceView> {
    return this.exclusive(async () => {
      const status = await this.git.status();
      const branches = await this.git.branch(['-a']);
      const listing = await this.git.raw([
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
      ]);
      const files = [...new Set(listing.split('\0').filter(Boolean))]
        .filter((path) => {
          try {
            validateSourcePath(path);
            return true;
          } catch {
            return false;
          }
        })
        .sort();
      const history = await this.git.log({ maxCount: 25 });
      const branch = status.current ?? 'HEAD';
      return {
        id: this.id,
        repository: this.repository,
        branch,
        branches: [
          ...new Set(
            branches.all
              .filter((name) => !name.includes('HEAD'))
              .map((name) => name.replace(/^remotes\/origin\//, '')),
          ),
        ].sort(),
        head: (await this.git.revparse(['HEAD'])).trim(),
        indexTree: status.conflicted.length ? null : (await this.git.raw(['write-tree'])).trim(),
        files,
        changes: status.files.map((file) => ({
          path: file.path,
          index: file.index,
          working: file.working_dir,
        })),
        conflicts: status.conflicted,
        history: history.all.map((entry) => ({
          hash: entry.hash,
          message: entry.message,
          author: entry.author_name,
          date: entry.date,
        })),
        ahead: status.ahead,
        behind: status.behind,
        pullRequestUrl: githubCompareUrl(this.repository, branch),
      };
    });
  }

  async file(path: string, branch: string): Promise<SourceFile> {
    return this.exclusive(async () => {
      await this.assertBranch(branch);
      const content = await this.readCurrent(path);
      const base = await this.git.show([`HEAD:${path}`]).catch(() => '');
      return { path, content, hash: contentHash(content), base };
    });
  }

  async stage(
    path: string,
    content: string,
    expectedHash: string,
    branch: string,
    resolveConflict = false,
  ) {
    return this.exclusive(async () => {
      const status = await this.assertBranch(branch, true);
      if (status.conflicted.includes(path) && !resolveConflict) {
        throw new WorkspaceError('Use Resolve conflict to stage this file.');
      }
      if (resolveConflict && /^(<<<<<<< |=======\s*$|>>>>>>> )/m.test(content)) {
        throw new WorkspaceError('Remove all conflict markers before resolving.');
      }
      if (contentHash(await this.readCurrent(path)) !== expectedHash) {
        throw new WorkspaceError(
          'The working file changed since you opened it. Reload and compare before staging.',
        );
      }
      const target = await this.safePath(path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
      await this.git.add(['--', path]);
    });
  }

  async unstage(path: string, branch: string) {
    return this.exclusive(async () => {
      await this.assertBranch(branch, true);
      await this.safePath(path);
      await this.git.raw(['restore', '--staged', '--', path]);
    });
  }

  async commit(message: string, branch: string, head: string, indexTree: string) {
    return this.exclusive(async () => {
      const status = await this.assertBranch(branch, true);
      if (status.conflicted.length)
        throw new WorkspaceError('Resolve every conflict before committing.');
      if (
        (await this.git.revparse(['HEAD'])).trim() !== head ||
        (await this.git.raw(['write-tree'])).trim() !== indexTree
      ) {
        throw new WorkspaceError(
          'The staged snapshot changed. Refresh and review it before committing.',
        );
      }
      if (!(await this.git.diff(['--cached', '--name-only'])).trim())
        throw new WorkspaceError('No staged changes to commit.');
      if (!message.trim()) throw new WorkspaceError('Enter a commit message.', 400);
      await this.git.commit(message.trim());
    });
  }

  async checkout(branch: string, expectedBranch: string, create = false) {
    return this.exclusive(async () => {
      validateBranch(branch);
      const status = await this.assertBranch(expectedBranch);
      if (!status.isClean())
        throw new WorkspaceError(
          'Commit your Git working changes before switching branches. Browser drafts are preserved.',
        );
      if (create) await this.git.checkoutLocalBranch(branch);
      else await this.git.checkout(branch);
    });
  }

  async push(branch: string) {
    return this.exclusive(async () => {
      const status = await this.assertBranch(branch, true);
      if (status.conflicted.length) throw new WorkspaceError('Resolve conflicts before pushing.');
      await this.git.push('origin', branch, ['--set-upstream', '--porcelain']);
    });
  }

  async fetch() {
    return this.exclusive(async () => {
      await this.git.fetch('origin');
    });
  }

  async pull(branch: string) {
    return this.exclusive(async () => {
      const status = await this.assertBranch(branch);
      if (!status.isClean()) throw new WorkspaceError('Commit working changes before pulling.');
      await this.git.pull('origin', branch, ['--ff-only']);
    });
  }

  async merge(source: string, branch: string) {
    return this.exclusive(async () => {
      validateBranch(source);
      const status = await this.assertBranch(branch, true);
      if (!status.isClean()) throw new WorkspaceError('Commit working changes before merging.');
      try {
        await this.git.merge(['--no-edit', '--', source]);
      } catch (error) {
        if (!(await this.git.status()).conflicted.length) throw error;
      }
    });
  }

  async abortMerge(branch: string) {
    return this.exclusive(async () => {
      await this.assertBranch(branch, true);
      await this.git.raw(['merge', '--abort']);
    });
  }

  async conflict(path: string, branch: string): Promise<ConflictVersions> {
    return this.exclusive(async () => {
      const status = await this.assertBranch(branch);
      await this.safePath(path);
      if (!status.conflicted.includes(path))
        throw new WorkspaceError('This file has no merge conflict.');
      const [base, ours, theirs] = await Promise.all(
        [1, 2, 3].map((stage) => this.git.show([`:${stage}:${path}`]).catch(() => '')),
      );
      return { base: base!, ours: ours!, theirs: theirs! };
    });
  }
}
