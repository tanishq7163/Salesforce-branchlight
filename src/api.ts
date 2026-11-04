import type { ConflictVersions, SourceFile, WorkspaceView } from './contracts.ts';

export function validateApiUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('The preview only connects to a loopback HTTP Git service.');
  }
  return url.origin;
}

export class ApiClient {
  base: string;
  private token: string;
  constructor(base: string, token: string) {
    this.base = validateApiUrl(base);
    this.token = token;
  }
  async request<Result>(path: string, body?: unknown): Promise<Result> {
    const response = await fetch(`${this.base}/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'The Git operation failed.');
    return result as Result;
  }
  list() {
    return this.request<{ id: string; repository: string }[]>('/workspaces');
  }
  view(id: string) {
    return this.request<WorkspaceView>(`/workspaces/${id}`);
  }
  file(id: string, path: string, branch: string) {
    return this.request<SourceFile>(
      `/workspaces/${id}/file?${new URLSearchParams({ path, branch })}`,
    );
  }
  conflict(id: string, path: string, branch: string) {
    return this.request<ConflictVersions>(
      `/workspaces/${id}/conflict?${new URLSearchParams({ path, branch })}`,
    );
  }
  action(id: string, action: string, body: unknown) {
    return this.request<WorkspaceView>(`/workspaces/${id}/${action}`, body);
  }
}
