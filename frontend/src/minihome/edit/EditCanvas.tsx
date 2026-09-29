import { useEffect, useState, useSyncExternalStore } from 'react';

import { useFrame, useThree } from '@react-three/fiber';
import {
  BoxGeometry,
  EdgesGeometry,
  LineBasicMaterial,
  MeshBasicMaterial,
  Plane,
  Raycaster,
  RingGeometry,
  Vector2,
  Vector3,
  type Camera,
} from 'three';

import { useBuildingStore, type PlacedObject } from 'gaesup-world/building';

import { boundsVersion, modelBounds, subscribeBounds } from './bounds';
import { useEditSession, useEditState } from './context';
import { pickBoxOf, pickObject, type LocalBox } from './objects';
import type { EditSession } from './session';

/** Editor helpers are not scenery: the camera's collision passes through them. */
const HELPER = { intangible: true };
const EDGES = new EdgesGeometry(new BoxGeometry(1, 1, 1));
const RING = new RingGeometry(0.84, 1, 48);
// Drawn over everything, so a selection behind a tree or a wall still shows.
const LOOKS = {
  selected: {
    line: new LineBasicMaterial({ color: '#ffb547', transparent: true, opacity: 0.95, depthTest: false, depthWrite: false }),
    ring: new MeshBasicMaterial({ color: '#ffb547', transparent: true, opacity: 0.85, depthTest: false, depthWrite: false }),
  },
  hover: {
    line: new LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.7, depthTest: false, depthWrite: false }),
    ring: new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.45, depthTest: false, depthWrite: false }),
  },
};
/** A press that moves farther than this is a drag, not a click (a finger gets a little more room). */
const DRAG_PX = { mouse: 4, touch: 10 };
/** View panning speed in meters a second at the default distance; farther views pan faster. */
const PAN_SPEED = 14;
const FORWARD = new Vector3();
const PAN_KEYS: Record<string, [forward: number, right: number]> = {
  KeyW: [1, 0],
  ArrowUp: [1, 0],
  KeyS: [-1, 0],
  ArrowDown: [-1, 0],
  KeyA: [0, -1],
  ArrowLeft: [0, -1],
  KeyD: [0, 1],
  ArrowRight: [0, 1],
};

function Outline({ object, box, look }: { object: PlacedObject; box: LocalBox; look: keyof typeof LOOKS }) {
  const size: [number, number, number] = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
  const center: [number, number, number] = [(box.max[0] + box.min[0]) / 2, (box.max[1] + box.min[1]) / 2, (box.max[2] + box.min[2]) / 2];
  const radius = Math.max(size[0], size[2]) * 0.6 + 0.15;
  const { line, ring } = LOOKS[look];
  return (
    <group position={[object.position.x, object.position.y, object.position.z]} rotation-y={object.rotation ?? 0} userData={HELPER}>
      <lineSegments geometry={EDGES} material={line} position={center} scale={size} renderOrder={1000} userData={HELPER} />
      <mesh geometry={RING} material={ring} position-y={0.04} rotation-x={-Math.PI / 2} scale={radius} renderOrder={1000} userData={HELPER} />
    </group>
  );
}

type Press = { pointerId: number; x: number; y: number; slop: number };
type Gesture =
  /** Dragging the selected object across the ground. */
  | (Press & { kind: 'move'; offset: { x: number; z: number }; height: number; release: (() => void) | null })
  /** Dragging the ground to move the view; a press that never moves is a click. */
  | (Press & { kind: 'pan'; view: Camera; start: { x: number; z: number }; from: { x: number; z: number }; height: number; moved: boolean; deselect: boolean })
  /** Two fingers: spreading zooms, moving together turns the view. */
  | { kind: 'pinch'; ids: [number, number]; distance: number; zoom: number }
  /** A finger left over from a pinch, ignored until it lifts. */
  | { kind: 'spent' };

/**
 * The decorating tools inside the canvas. With the 선택 tool a press on a placed object picks it and a drag moves it; a
 * drag anywhere else (or with Shift) moves the view, with a finger as with a mouse; two fingers zoom and turn the view.
 * Objects are picked by their boxes (a GLB's real bounds once measured), since the engine merges placed models into
 * shared meshes that cannot tell which object a triangle belongs to.
 */
function ActiveEditCanvas({ session }: { session: EditSession }) {
  const { gl, camera } = useThree();
  const objects = useBuildingStore((state) => state.objects);
  const selectedId = useEditState(session, (state) => state.selectedId);
  const tool = useEditState(session, (state) => state.tool);
  const [hoverId, setHoverId] = useState<string | null>(null);
  // Re-renders the outlines as model bounds get measured.
  useSyncExternalStore(subscribeBounds, boundsVersion);

  useEffect(() => {
    session.view.camera = camera;
    return () => {
      if (session.view.camera === camera) session.view.camera = null;
    };
  }, [session, camera]);

  useEffect(() => {
    if (tool !== 'select') setHoverId(null);
  }, [tool]);

  useEffect(() => {
    const canvas = gl.domElement;
    const raycaster = new Raycaster();
    const pointer = new Vector2();
    const plane = new Plane(new Vector3(0, 1, 0), 0);
    const hit = new Vector3();
    const touches = new Map<number, { x: number; y: number }>();
    let gesture: Gesture | null = null;
    let hoverFrame = 0;
    let hoverEvent: PointerEvent | null = null;
    let swallowTimer: ReturnType<typeof setTimeout> | undefined;

    const rayFor = (event: { clientX: number; clientY: number }, view: Camera = camera) => {
      const rect = canvas.getBoundingClientRect();
      pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, view);
      return raycaster.ray;
    };
    /** Where the pointer meets the level ground at `height`. */
    const ground = (event: PointerEvent, height: number, view?: Camera) => {
      plane.constant = -height;
      return rayFor(event, view).intersectPlane(plane, hit) ? { x: hit.x, z: hit.z } : null;
    };
    const pick = (event: PointerEvent) => {
      const { origin, direction } = rayFor(event);
      return pickObject(
        { origin: [origin.x, origin.y, origin.z], direction: [direction.x, direction.y, direction.z] },
        session.runtime.buildingStore.getState().objects,
        modelBounds,
      );
    };
    const moved = (event: PointerEvent, press: Press) => Math.hypot(event.clientX - press.x, event.clientY - press.y) > press.slop;
    const selecting = () => session.getState().active && session.getState().tool === 'select';
    const press = (event: PointerEvent): Press => ({
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      slop: event.pointerType === 'touch' ? DRAG_PX.touch : DRAG_PX.mouse,
    });

    const swallow = (event: MouseEvent) => {
      event.stopPropagation();
      event.preventDefault();
    };
    /** The click that ends a view drag must not paint or erase what it was released over. */
    const swallowClick = () => {
      canvas.addEventListener('click', swallow, { capture: true, once: true });
      clearTimeout(swallowTimer);
      swallowTimer = setTimeout(() => canvas.removeEventListener('click', swallow, { capture: true }), 400);
    };

    /** The camera turns on a right-button drag and knows no touch, so two fingers drive it as that drag would. */
    const orbit = (type: 'mousedown' | 'mousemove' | 'mouseup', x: number, y: number) => {
      const init = { clientX: x, clientY: y, button: 2, buttons: type === 'mouseup' ? 0 : 2, bubbles: true, cancelable: true };
      (type === 'mousedown' ? canvas : window).dispatchEvent(new MouseEvent(type, init));
    };
    const midpoint = (ids: readonly number[]) => {
      const points = ids.map((id) => touches.get(id)!);
      return { x: (points[0]!.x + points[1]!.x) / 2, y: (points[0]!.y + points[1]!.y) / 2 };
    };
    const spread = (ids: readonly number[]) => {
      const [a, b] = ids.map((id) => touches.get(id)!);
      return Math.hypot(a!.x - b!.x, a!.y - b!.y);
    };

    /** Ends the current gesture; a drag that moved an object records it as one undo step. */
    const finish = (cancelled: boolean, event?: PointerEvent) => {
      const ended = gesture;
      gesture = null;
      canvas.style.cursor = '';
      if (!ended) return;
      if (ended.kind === 'move') ended.release?.();
      else if (ended.kind === 'pan') {
        if (ended.moved) swallowClick();
        else if (ended.deselect && !cancelled) session.select(null);
      } else if (ended.kind === 'pinch') {
        const mid = touches.size >= 2 ? midpoint(ended.ids) : { x: event?.clientX ?? 0, y: event?.clientY ?? 0 };
        orbit('mouseup', mid.x, mid.y);
      }
      if (event && canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };

    const hover = (event: PointerEvent) => {
      hoverEvent = event;
      if (hoverFrame) return;
      hoverFrame = requestAnimationFrame(() => {
        hoverFrame = 0;
        if (!hoverEvent || gesture || !selecting()) return;
        const id = pick(hoverEvent)?.id ?? null;
        setHoverId(id);
        canvas.style.cursor = id ? 'pointer' : '';
      });
    };

    const startPan = (event: PointerEvent, deselect: boolean) => {
      // A frozen copy of the camera keeps the grabbed ground under the pointer while the real view glides after it.
      const view = camera.clone();
      const height = session.pivot().y;
      const start = ground(event, height, view);
      if (!start) return;
      const pivot = session.pivot();
      gesture = { ...press(event), kind: 'pan', view, start, from: { x: pivot.x, z: pivot.z }, height, moved: false, deselect };
    };

    const down = (event: PointerEvent) => {
      if (!session.getState().active) return;
      if (event.pointerType === 'touch') {
        touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (touches.size === 2) {
          // A second finger turns whatever the first one started into a pinch.
          finish(true);
          const ids = [...touches.keys()] as [number, number];
          const mid = midpoint(ids);
          const zoom = session.runtime.store.getState().cameraOption.zoom ?? 1;
          gesture = { kind: 'pinch', ids, distance: Math.max(1, spread(ids)), zoom };
          orbit('mousedown', mid.x, mid.y);
          return;
        }
        if (touches.size > 2 || gesture) return;
      } else if (event.button !== 0 || gesture) return;

      if (event.shiftKey) {
        startPan(event, false);
        // No mousedown follows, so neither placing nor the camera's own drag starts on this press.
        if (gesture) event.preventDefault();
      } else if (selecting()) {
        const object = pick(event);
        if (object) {
          session.select(object.id);
          const at = ground(event, object.position.y);
          gesture = {
            ...press(event),
            kind: 'move',
            offset: at ? { x: at.x - object.position.x, z: at.z - object.position.z } : { x: 0, z: 0 },
            height: object.position.y,
            release: null,
          };
        } else startPan(event, true);
      } else {
        // Placing, painting and erasing keep their click; a drag moves the view (the engine ignores a moved press).
        startPan(event, false);
      }
      if (gesture) canvas.setPointerCapture(event.pointerId);
    };

    const move = (event: PointerEvent) => {
      if (event.pointerType === 'touch' && touches.has(event.pointerId)) touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (!gesture) {
        if (event.pointerType !== 'touch' && selecting()) hover(event);
        return;
      }
      if (gesture.kind === 'pinch') {
        if (!gesture.ids.includes(event.pointerId) || touches.size < 2) return;
        const store = session.runtime.store.getState();
        const { minZoom = 0.45, maxZoom = 2.4 } = store.cameraOption;
        // Zoom is a distance multiplier: spreading the fingers brings the view closer.
        const zoom = Math.min(maxZoom, Math.max(minZoom, (gesture.zoom * gesture.distance) / Math.max(1, spread(gesture.ids))));
        store.setCameraOption({ zoom });
        const mid = midpoint(gesture.ids);
        orbit('mousemove', mid.x, mid.y);
        return;
      }
      if (gesture.kind === 'spent' || event.pointerId !== gesture.pointerId) return;
      if (gesture.kind === 'pan') {
        if (!gesture.moved && !moved(event, gesture)) return;
        if (!gesture.moved) {
          gesture.moved = true;
          canvas.style.cursor = 'move';
          setHoverId(null);
        }
        const at = ground(event, gesture.height, gesture.view);
        if (at) session.setPivot(gesture.from.x + gesture.start.x - at.x, gesture.from.z + gesture.start.z - at.z);
        return;
      }
      if (!gesture.release) {
        if (!moved(event, gesture)) return;
        // The whole drag is one undo step.
        gesture.release = session.history.hold();
        canvas.style.cursor = 'grabbing';
        setHoverId(null);
      }
      const at = ground(event, gesture.height);
      if (at) session.moveSelectedTo(at.x - gesture.offset.x, at.z - gesture.offset.z);
    };

    const end = (event: PointerEvent, cancelled: boolean) => {
      if (event.pointerType === 'touch') {
        const pinching = gesture?.kind === 'pinch' && gesture.ids.includes(event.pointerId);
        if (pinching) finish(cancelled, event);
        touches.delete(event.pointerId);
        if (pinching && touches.size > 0) gesture = { kind: 'spent' };
        else if (gesture?.kind === 'spent' && touches.size === 0) gesture = null;
        if (pinching || !gesture) return;
      }
      if (!gesture || gesture.kind === 'pinch' || gesture.kind === 'spent' || event.pointerId !== gesture.pointerId) return;
      finish(cancelled, event);
    };
    const up = (event: PointerEvent) => end(event, false);
    const cancel = (event: PointerEvent) => end(event, true);
    const leave = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || gesture) return;
      setHoverId(null);
      canvas.style.cursor = '';
    };

    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', cancel);
    canvas.addEventListener('pointerleave', leave);
    return () => {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', cancel);
      canvas.removeEventListener('pointerleave', leave);
      canvas.removeEventListener('click', swallow, { capture: true });
      cancelAnimationFrame(hoverFrame);
      clearTimeout(swallowTimer);
      finish(true);
    };
  }, [gl, camera, session]);

  useFrame((_, delta) => {
    if (session.held.size === 0 || !session.getState().active) return;
    let ahead = 0;
    let side = 0;
    for (const key of session.held) {
      const [f, r] = PAN_KEYS[key] ?? [0, 0];
      ahead += f;
      side += r;
    }
    if (ahead === 0 && side === 0) return;
    const forward = camera.getWorldDirection(FORWARD);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    // Right of the view on the ground: forward × up.
    const rightX = -forward.z;
    const rightZ = forward.x;
    const pivot = session.pivot();
    const reach = Math.max(0.5, camera.position.distanceTo(pivot) / 15);
    const step = PAN_SPEED * reach * Math.min(delta, 0.1) * (session.held.has('Shift') ? 2.5 : 1);
    const length = Math.hypot(ahead, side);
    session.panBy(((forward.x * ahead + rightX * side) / length) * step, ((forward.z * ahead + rightZ * side) / length) * step);
  });

  const selected = selectedId ? objects.find((object) => object.id === selectedId) : undefined;
  const hovered = hoverId && hoverId !== selectedId ? objects.find((object) => object.id === hoverId) : undefined;
  return (
    <>
      {selected && <Outline object={selected} box={pickBoxOf(selected, modelBounds)} look="selected" />}
      {hovered && <Outline object={hovered} box={pickBoxOf(hovered, modelBounds)} look="hover" />}
    </>
  );
}

/** Mount inside the island's canvas; it does nothing unless the owner is decorating. */
export function EditCanvas() {
  const session = useEditSession();
  const active = useEditState(session, (state) => state.active);
  return session && active ? <ActiveEditCanvas session={session} /> : null;
}
