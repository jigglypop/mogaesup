import { Vector3, type Camera } from 'three';

import { CAMERA_CONTROLLER_MODE_OPTIONS, type CameraOptionType, type GaesupRuntime } from 'gaesup-world';
import { createBuildingScopeId, type PlacedObject } from 'gaesup-world/building';

import { modelBounds } from './bounds';
import type { EditHistory } from './history';
import {
  freeSpotNear,
  isSpotFree,
  pickBoxOf,
  positionAt,
  radiansOf,
  resized,
  snapToGrid,
  turnable,
  turned,
} from './objects';

/** 선택 picks and changes placed objects; the other tools are the engine's, working on the drawer's part. */
export type EditTool = 'select' | 'place' | 'paint' | 'erase';
export type EditPart = 'object' | 'tile' | 'wall';

export type EditState = {
  /** The decorating screen is open and the island has loaded. */
  active: boolean;
  tool: EditTool;
  part: EditPart;
  selectedId: string | null;
  topDown: boolean;
  help: boolean;
  /** A short word after an action that did nothing, such as moving onto a taken spot. */
  notice: string | null;
};

type ControlType = ReturnType<GaesupRuntime['store']['getState']>['mode']['control'];

/** How far from the island's middle the view may travel, in meters: the island is 56 m across. */
const PAN_LIMIT = 44;
const clampPan = (value: number) => Math.min(PAN_LIMIT, Math.max(-PAN_LIMIT, value));
const NOTICE_MS = 2400;
/** How far out the view may zoom while decorating: most of the island at once. */
const EDIT_MAX_ZOOM = 3.2;
/** A phone held upright sees a narrow strip of the island; decorating there starts this far out. */
const PHONE_ZOOM = 2.2;

export type EditSession = ReturnType<typeof createEditSession>;

/**
 * One home's decorating session: the tool, the selection and the view, over the runtime's building store. Object
 * changes go through the store's own actions, so the history records them and the saver sees them.
 */
export function createEditSession(runtime: GaesupRuntime, history: EditHistory, labels: ReadonlyMap<string, string>) {
  let state: EditState = { active: false, tool: 'select', part: 'object', selectedId: null, topDown: false, help: false, notice: null };
  const listeners = new Set<() => void>();
  /** Where the view pivot (the player's last spot) was before editing; leaving puts it back, so the player respawns there. */
  let home: Vector3 | null = null;
  let savedCamera: { control: ControlType; option: CameraOptionType } | null = null;
  /** The play view's zoom limits; decorating may look from farther away, and leaving gives the play view back. */
  let playZoom: { zoom: number | undefined; maxZoom: number | undefined } | null = null;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  const held = new Set<string>();
  const building = () => runtime.buildingStore.getState();

  const set = (patch: Partial<EditState>) => {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };

  /** Tells the engine what a click does: the select tool leaves it inert (painting objects does nothing, and shows no preview). */
  const applyTool = () => {
    if (!state.active) return;
    const store = building();
    if (state.tool === 'select') {
      store.setEditMode('object');
      store.setBuildingTool('paint');
      return;
    }
    store.setEditMode(state.part);
    store.setBuildingTool(state.tool === 'paint' && state.part === 'object' ? 'place' : state.tool);
  };

  const notice = (text: string) => {
    if (noticeTimer !== undefined) clearTimeout(noticeTimer);
    set({ notice: text });
    noticeTimer = setTimeout(() => set({ notice: null }), NOTICE_MS);
  };

  const selected = (): PlacedObject | null => {
    const id = state.selectedId;
    return id ? (building().objects.find((object) => object.id === id) ?? null) : null;
  };

  // A selection whose object went away (undo, erase, another load) ends.
  const unwatch = runtime.buildingStore.subscribe((next, previous) => {
    if (next.objects === previous.objects || !state.selectedId) return;
    if (!next.objects.some((object) => object.id === state.selectedId)) set({ selectedId: null });
  });

  const pivot = () => runtime.stateManager.getActiveState().position;
  const setPivot = (x: number, z: number) => {
    const current = pivot();
    runtime.stateManager.updateActiveState({ position: new Vector3(clampPan(x), current.y, clampPan(z)) });
  };

  const restoreCamera = () => {
    if (!savedCamera) return;
    const store = runtime.store.getState();
    store.setMode({ control: savedCamera.control });
    store.replaceCameraOption(savedCamera.option);
    savedCamera = null;
  };

  /** Moves `object` to (x, z) when no other object stands there; `tell` says so when one does. */
  const moveTo = (object: PlacedObject, x: number, z: number, tell: boolean) => {
    const { objects, tileGroups } = building();
    if (Math.abs(object.position.x - x) < 1e-6 && Math.abs(object.position.z - z) < 1e-6) return false;
    if (!isSpotFree(objects, x, z, object.id)) {
      if (tell) notice('그 자리엔 이미 다른 물건이 있어요');
      return false;
    }
    building().updateObject(object.id, { position: positionAt(object, x, z, tileGroups.values()) });
    return true;
  };

  return {
    runtime,
    history,
    labels,
    /** The canvas's camera, for moving things relative to the view. */
    view: { camera: null as Camera | null },
    /** Keys held for moving the view (KeyW…, ArrowUp…), read every frame by the canvas. */
    held,
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    selected,

    enter() {
      if (state.active) return;
      home = pivot().clone();
      // The view pivot is the player's spot, so arrival rules would fire as the view pans over the island.
      runtime.gameplayEvents.suspend();
      const camera = runtime.store.getState();
      const { zoom, maxZoom } = camera.cameraOption;
      playZoom = { zoom, maxZoom };
      // A phone shows little of the island at the play distance, so decorating there starts farther out.
      const narrow = typeof matchMedia === 'function' && matchMedia('(max-width: 720px)').matches;
      camera.setCameraOption({ maxZoom: Math.max(maxZoom ?? 2.4, EDIT_MAX_ZOOM), ...(narrow ? { zoom: Math.max(zoom ?? 1, PHONE_ZOOM) } : {}) });
      set({ active: true, selectedId: null, notice: null });
      applyTool();
    },
    exit() {
      if (!state.active) return;
      restoreCamera();
      if (playZoom) {
        runtime.store.getState().setCameraOption({ zoom: playZoom.zoom ?? 1, maxZoom: playZoom.maxZoom });
        playZoom = null;
      }
      if (home) {
        runtime.stateManager.updateActiveState({ position: home });
        // Take the player's area back while rules are off, so leaving does not announce an arrival.
        runtime.gameplayAreas.update(home);
      }
      runtime.gameplayEvents.resume();
      home = null;
      held.clear();
      const store = building();
      store.setBuildingTool('place');
      store.setEditMode('none');
      set({ active: false, selectedId: null, topDown: false, help: false, notice: null });
    },

    setTool(tool: EditTool) {
      if (tool === 'paint' && state.part === 'object') return;
      set({ tool, selectedId: tool === 'select' ? state.selectedId : null });
      applyTool();
    },
    setPart(part: EditPart) {
      set({ part, tool: state.tool === 'paint' && part === 'object' ? 'place' : state.tool });
      applyTool();
    },
    select(id: string | null) {
      if (id === state.selectedId) return;
      const toSelect = id !== null && state.tool !== 'select';
      set({ selectedId: id, ...(toSelect ? { tool: 'select' as const } : {}) });
      if (toSelect) applyTool();
    },

    /** Moves the selection to the grid spot nearest (x, z) if it is free; a drag passes taken spots quietly. */
    moveSelectedTo(x: number, z: number) {
      const object = selected();
      return object ? moveTo(object, snapToGrid(x), snapToGrid(z), false) : false;
    },
    /** Moves the selection by whole grid steps along the world axes. */
    nudgeSelected(dx: number, dz: number) {
      const object = selected();
      return object ? moveTo(object, object.position.x + dx, object.position.z + dz, true) : false;
    },
    turnSelected(degrees: number) {
      const object = selected();
      if (object && turnable(object)) building().updateObject(object.id, { rotation: turned(object.rotation, degrees) });
    },
    setSelectedRotation(degrees: number) {
      const object = selected();
      if (object && turnable(object)) building().updateObject(object.id, { rotation: radiansOf(degrees) });
    },
    resizeSelected(size: number) {
      const object = selected();
      const config = object && resized(object, size);
      if (object && config) building().updateObject(object.id, { config });
    },
    /** Copies the selection to the nearest free spot beside it, a footprint away, and selects the copy. */
    duplicateSelected() {
      const object = selected();
      if (!object) return null;
      const { objects, tileGroups } = building();
      const box = pickBoxOf(object, modelBounds);
      const step = Math.max(1, Math.ceil(Math.max(box.max[0] - box.min[0], box.max[2] - box.min[2]) - 0.01));
      const spot =
        freeSpotNear(objects, object.position.x, object.position.z, step, 2) ??
        freeSpotNear(objects, object.position.x, object.position.z, 1, 4);
      if (!spot) {
        notice('옆에 빈자리가 없어요');
        return null;
      }
      const copy: PlacedObject = {
        ...structuredClone(object),
        id: createBuildingScopeId('obj'),
        position: positionAt(object, spot.x, spot.z, tileGroups.values()),
      };
      building().addObject(copy);
      set({ selectedId: copy.id });
      return copy.id;
    },
    deleteSelected() {
      const object = selected();
      if (!object) return;
      building().removeObject(object.id);
      set({ selectedId: null });
    },

    pivot,
    setPivot,
    panBy(dx: number, dz: number) {
      const current = pivot();
      setPivot(current.x + dx, current.z + dz);
    },
    /** Brings the view to the selection. */
    focusSelected() {
      const object = selected();
      if (object) setPivot(object.position.x, object.position.z);
    },
    setTopDown(on: boolean) {
      if (!state.active || on === state.topDown) return;
      if (on) {
        const store = runtime.store.getState();
        savedCamera = { control: store.mode.control, option: store.cameraOption };
        store.setMode({ control: 'topDown' });
        // Collision has to be off explicitly: the stored option wins over the controller's default.
        store.setCameraOption({ ...CAMERA_CONTROLLER_MODE_OPTIONS.topDown, enableCollision: false });
      } else {
        restoreCamera();
      }
      set({ topDown: on });
    },
    setHelp(help: boolean) {
      set({ help });
    },
    notice,
    dispose() {
      unwatch();
      if (noticeTimer !== undefined) clearTimeout(noticeTimer);
    },
  };
}
