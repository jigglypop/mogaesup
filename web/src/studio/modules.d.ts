/**
 * The character studio's sources (gaesup-character/frontend/src) come in through the `@studio` alias and are type-checked
 * in their own project against its own engine versions. The app declares only what its adapted viewer calls.
 */
declare module '@studio/face-editor' {
  import type { Camera } from 'three';
  import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';

  export type PaintSettings = { role: string; radius: number; erase: boolean };
  export type FaceSelection = { node_index: number; primitive_index: number; role: string; faces: number[] };
  export class FaceEditor {
    settings: PaintSettings;
    constructor(gltf: GLTF, canvas: HTMLCanvasElement, camera: Camera, onPaint: (count: number) => void, storageKey: string);
    export(): FaceSelection[];
    undo(): void;
    clear(): void;
    dispose(): void;
  }
}

declare module '@studio/model-pose' {
  import type { Object3D } from 'three';

  export function captureRestPose(root: Object3D): () => void;
}

declare module '@studio/native-wardrobe' {
  import type { Object3D, Texture } from 'three';

  export type Wearable = { id: string; slot: string; url: string; sha256: string };
  export type Tuck = { anchors: Record<string, Int32Array>; moves: Record<string, Float32Array>; keys: string[] };
  export class NativeWardrobe {
    constructor(body: Object3D, primitiveKeys?: Map<Object3D, string>);
    equip(parts: Wearable[]): Promise<boolean>;
    diagnostics(): unknown;
    setHairColor(color: string | null): void;
    hideTriangles(hidden: Record<string, Uint8Array> | null): void;
    tuckUnder(slot: string, tuck: Tuck | null, outer: Record<string, Uint8Array> | null): void;
    setRegionColors(slot: string, index: number, mask: Texture, lights: number[], colors: (string | null)[]): void;
    dispose(): void;
  }
}

declare module '@studio/texture-expressions' {
  import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';

  export class TextureExpressions {
    constructor(gltf: GLTF);
    clear(): void;
    dispose(): void;
    saved(maps: { material: number; url: string; sha256: string }[]): Promise<boolean>;
  }
}

declare module '@studio/matte-materials' {
  import type { Object3D } from 'three';

  export function matteCharacter(root: Object3D): void;
}

declare module '@studio/assets/gpu-resources' {
  import type { Object3D, Skeleton } from 'three';

  export function disposeObjectResources(roots: readonly Object3D[], extraSkeletons?: Iterable<Skeleton>): void;
}

/** Screens the app mounts as they are. */
declare module '@studio/studio/Workspace' {
  export function Workspace(): import('react').JSX.Element;
}
declare module '@studio/studio/Wardrobe' {
  const Wardrobe: () => import('react').JSX.Element;
  export default Wardrobe;
}
