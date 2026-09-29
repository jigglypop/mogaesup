import { api } from './api';
import { usePolling } from './use-polling';

// Uploads refresh this list directly; the poll only picks up changes from other tabs.
export function useLiveCharacters() {
  const result = usePolling(api.list, 15000);
  return { characters: result.value?.characters || [], failure: result.error, loading: result.loading, refresh: result.refresh };
}
