import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useFrame, useThree } from '@react-three/fiber';
import { BoxGeometry, Color, CylinderGeometry, Matrix4, MeshStandardMaterial, Quaternion, Vector3, type InstancedMesh } from 'three';

import { CORD, PLAQUE, PLAQUES, plaqueSpot } from './guestboard';
import { wind } from './sprigs';

// The lines of the island's guestbook as wooden plaques hanging on the 기념 방명록's rails (see guestboard), the newest
// first, each on a red cord, swinging a little in the wind. Pressing the frame opens the guestbook to leave one.

/** A line in the guestbook as a plaque: whose (its wood's shade comes from the name). */
export type GuestNote = { id: string; key: string };

const PLANK = new BoxGeometry(1, 1, 1);
const STRING = new CylinderGeometry(0.004, 0.004, 1, 4);
const plankMaterial = new MeshStandardMaterial({ roughness: 0.82 });
const cordMaterial = new MeshStandardMaterial({ color: '#b8322a', roughness: 0.7 });
/** Shades of wood a plaque is cut from. */
const WOODS = ['#d2a970', '#c4935a', '#dcb985', '#b88350', '#e0c194'];

const shadeOf = (key: string) => WOODS[[...key].reduce((sum, char) => sum + char.charCodeAt(0), 0) % WOODS.length]!;

const matrix = new Matrix4();
const turn = new Quaternion();
const axis = new Vector3(1, 0, 0);
const place = new Vector3();
const size = new Vector3();
const offset = new Vector3();
/** Where each plaque's cord meets its rail: the same every frame. */
const SPOTS = Array.from({ length: PLAQUES }, (_, index) => plaqueSpot(index));

/** The plaques on the frame standing at `at` (about the island's middle), facing `facing`. */
export function GuestPlaques({ at, facing, notes, onPress }: { at: readonly [number, number]; facing: number; notes: readonly GuestNote[]; onPress?: (() => void) | undefined }) {
  const plaques = useRef<InstancedMesh>(null);
  const cords = useRef<InstancedMesh>(null);
  const shown = useMemo(() => notes.slice(0, PLAQUES), [notes]);
  const canvas = useThree((state) => state.gl.domElement);
  const [hovered, setHovered] = useState(false);
  useEffect(() => {
    if (!hovered || !onPress) return undefined;
    canvas.style.cursor = 'pointer';
    return () => {
      canvas.style.cursor = '';
    };
  }, [hovered, canvas, onPress]);
  useLayoutEffect(() => {
    const mesh = plaques.current;
    if (!mesh) return;
    const color = new Color();
    shown.forEach((note, index) => mesh.setColorAt(index, color.set(shadeOf(note.key))));
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [shown]);
  /** The wind's time and the meshes the plaques were last hung at: a frame with neither changed (a still scene) has nothing to hang again. */
  const hung = useRef<{ time: number; plaques: InstancedMesh | null; cords: InstancedMesh | null }>({ time: NaN, plaques: null, cords: null });
  // Each hangs from its rail and swings about it, a little and at its own time.
  useFrame(() => {
    const plaqueMesh = plaques.current;
    const cordMesh = cords.current;
    if (!plaqueMesh || !cordMesh) return;
    const time = wind.value as number;
    const last = hung.current;
    if (last.time === time && last.plaques === plaqueMesh && last.cords === cordMesh) return;
    last.time = time;
    last.plaques = plaqueMesh;
    last.cords = cordMesh;
    for (let index = 0; index < shown.length; index++) {
      const spot = SPOTS[index]!;
      turn.setFromAxisAngle(axis, Math.sin(time * 1.3 + index * 1.7) * 0.08);
      offset.set(0, -CORD / 2, 0).applyQuaternion(turn);
      cordMesh.setMatrixAt(index, matrix.compose(place.set(spot[0], spot[1], spot[2]).add(offset), turn, size.set(1, CORD, 1)));
      offset.set(0, -CORD - PLAQUE[1] / 2, 0).applyQuaternion(turn);
      plaqueMesh.setMatrixAt(index, matrix.compose(place.set(spot[0], spot[1], spot[2]).add(offset), turn, size.set(PLAQUE[0], PLAQUE[1], PLAQUE[2])));
    }
    plaqueMesh.instanceMatrix.needsUpdate = true;
    cordMesh.instanceMatrix.needsUpdate = true;
  });
  return (
    <group
      position={[at[0], 0, at[1]]}
      rotation={[0, facing, 0]}
      onClick={(event) => {
        if (!onPress || event.delta > 6) return;
        event.stopPropagation();
        onPress();
      }}
      onPointerOver={(event) => {
        event.stopPropagation();
        setHovered(true);
      }}
      onPointerOut={() => setHovered(false)}
    >
      {/* What the pointer meets: the frame's face, not the thousand shapes of it. */}
      <mesh position={[0, 1.1, 0.04]} scale={[2.1, 2.3, 0.2]} visible={false}>
        <boxGeometry />
      </mesh>
      {shown.length > 0 && (
        <>
          <instancedMesh key={`plaques:${shown.length}`} ref={plaques} args={[PLANK, plankMaterial, shown.length]} castShadow receiveShadow />
          <instancedMesh key={`cords:${shown.length}`} ref={cords} args={[STRING, cordMaterial, shown.length]} />
        </>
      )}
    </group>
  );
}
