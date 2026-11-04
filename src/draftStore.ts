import { openDB } from 'idb';
import type { DBSchema } from 'idb';
import { draftKey, nextDraft } from './drafts.ts';
import type { Draft, DraftScope } from './drafts.ts';

interface DraftDatabase extends DBSchema {
  drafts: { key: string; value: Draft };
}

export function createDraftStore(name = 'branchlight-drafts-v1') {
  const database = openDB<DraftDatabase>(name, 1, {
    upgrade(connection) {
      connection.createObjectStore('drafts', { keyPath: 'key' });
    },
  });

  return {
    async read(scope: DraftScope) {
      return (await database).get('drafts', draftKey(scope));
    },
    async list(scope: Omit<DraftScope, 'path'>) {
      const drafts = await (await database).getAll('drafts');
      return drafts.filter(
        (draft) =>
          draft.repository === scope.repository &&
          draft.workspace === scope.workspace &&
          draft.branch === scope.branch,
      );
    },
    async save(scope: DraftScope, content: string, baseContent: string, expectedRevision: number) {
      const transaction = (await database).transaction('drafts', 'readwrite');
      const previous = await transaction.store.get(draftKey(scope));
      let draft: Draft;
      try {
        draft = nextDraft(scope, content, baseContent, previous, expectedRevision);
      } catch (error) {
        transaction.abort();
        await transaction.done.catch(() => undefined);
        throw error;
      }
      await transaction.store.put(draft);
      await transaction.done;
      return draft;
    },
    async close() {
      (await database).close();
    },
  };
}
