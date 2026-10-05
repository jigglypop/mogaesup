import { act } from 'react';

import { describe, expect, it, vi } from 'vitest';

import { mount } from '../../__tests__/mount';
import type { EditSession } from '../edit/session';
import { useEditKeys } from '../edit/useEditKeys';

/** A decorating session with one object selected, recording what the keys do to it. */
function fakeSession() {
  const state = { active: true, help: false, selectedId: 'chair', tool: 'select', topDown: false };
  return {
    getState: () => state,
    history: { undo: vi.fn(), redo: vi.fn() },
    held: new Set<string>(),
    selected: () => ({ id: 'chair' }),
    deleteSelected: vi.fn(),
    turnSelected: vi.fn(),
    setTool: vi.fn(),
    setHelp: vi.fn(),
    select: vi.fn(),
    view: { camera: null },
  };
}

function Keys({ session, save }: { session: EditSession; save: () => void }) {
  useEditKeys(session, { save });
  return null;
}

const press = (key: string, code: string, init: KeyboardEventInit = {}) =>
  act(async () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...init }));
  });

describe('꾸미기 단축키', () => {
  it('모달 대화상자가 열린 동안에는 뒤의 섬을 바꾸지 않는다', async () => {
    const session = fakeSession();
    const save = vi.fn();
    const { unmount } = await mount(<Keys session={session as unknown as EditSession} save={save} />);
    const modal = document.body.appendChild(document.createElement('div'));
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    await press('Delete', 'Delete');
    await press('r', 'KeyR');
    await press('z', 'KeyZ', { ctrlKey: true });
    await press('s', 'KeyS', { ctrlKey: true });
    await press('?', 'Slash', { shiftKey: true });
    await press('2', 'Digit2');
    await press('w', 'KeyW');
    expect(session.deleteSelected).not.toHaveBeenCalled();
    expect(session.turnSelected).not.toHaveBeenCalled();
    expect(session.history.undo).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(session.setHelp).not.toHaveBeenCalled();
    expect(session.setTool).not.toHaveBeenCalled();
    expect(session.held.size).toBe(0);

    modal.remove();
    await press('Delete', 'Delete');
    expect(session.deleteSelected).toHaveBeenCalledTimes(1);
    await unmount();
  });
});
