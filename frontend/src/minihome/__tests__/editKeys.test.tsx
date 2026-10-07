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

  it('Ctrl·⌘+S는 어디에서 눌러도 브라우저의 페이지 저장을 막고, 대화상자가 없으면 섬을 저장한다', async () => {
    const session = fakeSession();
    const save = vi.fn();
    const { unmount } = await mount(<Keys session={session as unknown as EditSession} save={save} />);
    const send = (target: EventTarget, init: KeyboardEventInit) => {
      const event = new KeyboardEvent('keydown', { key: 's', code: 'KeyS', bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    // Typing in a field (the drawer's search, a resident's line) and a Korean input mode (ㄴ on the S key) too.
    const field = document.body.appendChild(document.createElement('input'));
    await act(async () => {
      expect(send(field, { ctrlKey: true })).toBe(true);
      expect(send(document.body, { metaKey: true, key: 'ㄴ' })).toBe(true);
    });
    expect(save).toHaveBeenCalledTimes(2);
    // Held down, it saves once.
    await act(async () => {
      expect(send(document.body, { ctrlKey: true, repeat: true })).toBe(true);
    });
    expect(save).toHaveBeenCalledTimes(2);

    const modal = document.body.appendChild(document.createElement('div'));
    modal.setAttribute('aria-modal', 'true');
    await act(async () => {
      expect(send(modal, { ctrlKey: true })).toBe(true);
    });
    expect(save).toHaveBeenCalledTimes(2);
    modal.remove();
    field.remove();
    // A plain S moves the view; it does not save.
    await act(async () => {
      send(document.body, {});
    });
    expect(save).toHaveBeenCalledTimes(2);
    await unmount();
  });
});
