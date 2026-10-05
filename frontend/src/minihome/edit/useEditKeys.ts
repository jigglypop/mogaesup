import { useEffect } from 'react';

import { Vector3 } from 'three';

import { groundAxes } from './objects';
import type { EditSession, EditTool } from './session';

/** Keys that move the view while held; arrows move a selected object instead. */
const VIEW_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
const ARROWS: Record<string, [forward: number, right: number]> = {
  ArrowUp: [1, 0],
  ArrowDown: [-1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
};
const TOOL_KEYS: Record<string, EditTool> = { Digit1: 'select', Digit2: 'place', Digit3: 'paint', Digit4: 'erase' };
const scratch = new Vector3();

const typing = (event: KeyboardEvent) => {
  const target = event.target;
  return target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !== null;
};
/** Keys a tablist moves between its tabs with (ui/tabs.ts); on a tab they are the tablist's, not the view's. */
const TAB_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);
const tabbing = (event: KeyboardEvent) =>
  TAB_KEYS.has(event.key) && event.target instanceof Element && event.target.closest('[role=tablist]') !== null;
/** A modal dialog over the island (매장 배치) has the keyboard to itself; its keys must not edit the island behind it. */
const modalOpen = () => document.querySelector('[aria-modal="true"]') !== null;

/**
 * The decorating shortcuts. They listen on the window's capture phase, ahead of the world's own key handling, and
 * cancel the keys they use: the engine skips a cancelled key, so arrows move the selection instead of turning the next
 * piece, and WASD moves the view while no player walks. The shortcut help takes only its own keys, and another modal
 * dialog none.
 */
export function useEditKeys(session: EditSession, actions: { save: () => void }) {
  const { save } = actions;
  useEffect(() => {
    const { history, held } = session;
    const down = (event: KeyboardEvent) => {
      const state = session.getState();
      if (!state.active || event.isComposing || typing(event) || tabbing(event)) return;
      const handled = () => event.preventDefault();

      if (state.help) {
        if (event.key === 'Escape' || event.key === '?') {
          session.setHelp(false);
          handled();
        }
        return;
      }
      if (modalOpen()) return;

      if (event.ctrlKey || event.metaKey) {
        // By key or by position, so a Korean input mode (ㅋ for Z) still undoes.
        const is = (letter: string) => event.key.toLowerCase() === letter || event.code === `Key${letter.toUpperCase()}`;
        if (is('z') && !event.shiftKey) history.undo();
        else if ((is('z') && event.shiftKey) || is('y')) history.redo();
        else if (is('s')) save();
        else if (is('d')) {
          if (!event.repeat) session.duplicateSelected();
        } else return;
        handled();
        return;
      }
      if (event.altKey) return;

      if (event.key === '?') {
        session.setHelp(true);
        return handled();
      }
      if (event.key === 'Escape') {
        if (state.selectedId) session.select(null);
        else if (state.tool !== 'select') session.setTool('select');
        else return;
        return handled();
      }
      if (event.key === 'Shift') {
        held.add('Shift');
        return;
      }
      const selected = session.selected();
      if (selected) {
        if (event.key === 'Delete' || event.key === 'Backspace') {
          session.deleteSelected();
          return handled();
        }
        if (event.code === 'KeyR') {
          session.turnSelected(event.shiftKey ? 45 : 90);
          return handled();
        }
        if (event.code === 'KeyF') {
          session.focusSelected();
          return handled();
        }
        const arrow = ARROWS[event.code];
        if (arrow) {
          const camera = session.view.camera;
          const direction = camera ? camera.getWorldDirection(scratch) : scratch.set(0, 0, -1);
          const { forward, right } = groundAxes(direction.x, direction.z);
          session.nudgeSelected(forward[0] * arrow[0] + right[0] * arrow[1], forward[1] * arrow[0] + right[1] * arrow[1]);
          return handled();
        }
      }
      if (VIEW_KEYS.has(event.code)) {
        held.add(event.code);
        return handled();
      }
      if (event.repeat) return;
      if (event.code === 'KeyT') {
        session.setTopDown(!state.topDown);
        return handled();
      }
      const tool = TOOL_KEYS[event.code];
      if (tool) {
        session.setTool(tool);
        return handled();
      }
    };
    const up = (event: KeyboardEvent) => {
      if (event.key === 'Shift') held.delete('Shift');
      held.delete(event.code);
    };
    const blur = () => held.clear();
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('blur', blur);
      held.clear();
    };
  }, [session, save]);
}
