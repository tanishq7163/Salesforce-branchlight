export type DraftScope = {
  repository: string;
  workspace: string;
  branch: string;
  path: string;
};

export type Draft = DraftScope & {
  key: string;
  content: string;
  baseContent: string;
  revision: number;
  savedAt: string;
};

export function draftKey(scope: DraftScope): string {
  return JSON.stringify([scope.repository, scope.workspace, scope.branch, scope.path]);
}

export function nextDraft(
  scope: DraftScope,
  content: string,
  baseContent: string,
  previous: Draft | undefined,
  expectedRevision: number,
): Draft {
  const key = draftKey(scope);
  if (previous && previous.key !== key) {
    throw new Error('Draft belongs to a different workspace or branch.');
  }
  if ((previous?.revision ?? 0) !== expectedRevision) {
    throw new Error('This draft changed in another tab. Reload it before saving.');
  }
  return {
    ...scope,
    key,
    content,
    baseContent: previous?.baseContent ?? baseContent,
    revision: expectedRevision + 1,
    savedAt: new Date().toISOString(),
  };
}
