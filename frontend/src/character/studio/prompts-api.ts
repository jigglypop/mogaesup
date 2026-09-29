import { request } from '../api';

export type PromptItem = {
  id: string; key: string; title: string; value: string; default: string;
  max_length: number; customized: boolean;
};
export type PromptGroup = { id: string; title: string; rule: string; items: PromptItem[] };
export type PromptCatalog = { revision: string; updated_at?: string; can_save: boolean; groups: PromptGroup[] };

export const promptsApi = {
  list: (signal?: AbortSignal) => request<PromptCatalog>('/api/studio/prompts', { signal }),
  save: (changes: Record<string, string | null>, revision: string) => request<PromptCatalog>('/api/studio/prompts', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ changes, revision }),
  }),
};
