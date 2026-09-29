import { createContext, useContext, useSyncExternalStore } from 'react';

import type { EditHistory } from './history';
import type { IslandSaver, SaverState } from './save';
import type { EditSession, EditState } from './session';

/** The owner's decorating session; the canvas reads it too, through the React context R3F bridges into it. */
export const EditContext = createContext<EditSession | null>(null);
export const useEditSession = () => useContext(EditContext);

const IDLE: EditState = { active: false, tool: 'select', part: 'object', selectedId: null, topDown: false, help: false, notice: null };
const never = () => () => {};

/** A slice of the session's state; `pick` should return a primitive or a stable part, as with any store selector. */
export function useEditState<T>(session: EditSession | null, pick: (state: EditState) => T): T {
  return useSyncExternalStore(session ? session.subscribe : never, () => pick(session ? session.getState() : IDLE));
}

export function useHistory(history: EditHistory) {
  useSyncExternalStore(history.subscribe, history.version);
  return { canUndo: history.canUndo(), canRedo: history.canRedo(), undo: history.undo, redo: history.redo };
}

export const useSaver = (saver: IslandSaver): SaverState => useSyncExternalStore(saver.subscribe, saver.getState);
