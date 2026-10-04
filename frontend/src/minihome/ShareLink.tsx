import { shareUrl } from '../api/endpoints';
import { Icon } from '../ui/icons';

export type Shared = 'copied' | 'failed';

/** Puts `text` on the clipboard: the Clipboard API, else a selected field copied the old way (in-app browsers). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Not offered here, or refused: try the old way.
  }
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.append(field);
  field.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    field.remove();
  }
}

/** A phone or tablet, where the system's share sheet reaches the chat apps. */
const touchDevice = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

/**
 * 링크 복사: the island's share link ({@link shareUrl}), whose page link previews read. A touch device opens its share
 * sheet; elsewhere, or when the sheet is not there, the link is copied and `onShared` hears how that went.
 */
export function ShareLink({ username, onShared }: { username: string; onShared: (result: Shared) => void }) {
  const share = async () => {
    const url = shareUrl(username);
    if (typeof navigator.share === 'function' && touchDevice()) {
      try {
        await navigator.share({ url });
        return;
      } catch (problem) {
        // Closing the sheet is an answer; anything else falls back to copying.
        if ((problem as { name?: unknown } | null)?.name === 'AbortError') return;
      }
    }
    onShared((await copyText(url)) ? 'copied' : 'failed');
  };
  return (
    <button className="mg-icon-btn" aria-label="링크 복사" onClick={() => void share()}>
      <Icon name="link" />
    </button>
  );
}

/** What became of the last 링크 복사, for a moment. */
export function SharedToast({ shared }: { shared: Shared | null }) {
  if (shared === 'copied') {
    return (
      <p className="mg-toast mg-glass" role="status">
        <Icon name="check" /> 링크를 복사했어요
      </p>
    );
  }
  return shared === 'failed' ? <p className="mg-toast mg-glass mg-error" role="alert">링크를 복사하지 못했어요</p> : null;
}
