export type FileChange = { path: string; index: string; working: string };
export type CommitInfo = { hash: string; message: string; author: string; date: string };
export type WorkspaceView = {
  id: string;
  repository: string;
  branch: string;
  branches: string[];
  head: string;
  indexTree: string | null;
  files: string[];
  changes: FileChange[];
  conflicts: string[];
  history: CommitInfo[];
  ahead: number;
  behind: number;
  pullRequestUrl: string | null;
};
export type SourceFile = { path: string; content: string; hash: string; base: string };
export type ConflictVersions = { base: string; ours: string; theirs: string };
