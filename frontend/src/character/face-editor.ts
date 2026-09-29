import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';

export type FaceSelection = { node_index: number; primitive_index: number; role: string; faces: number[] };
export type PaintSettings = { role: string; radius: number; erase: boolean };

/** Paint source triangles; export stable glTF node/primitive/face IDs, never world coordinates. */
export class FaceEditor {
  settings: PaintSettings = { role: 'hair', radius: .04, erase: false };
  private assignments = new Map<string, Map<number, string>>();
  private meshes = new Map<string, THREE.Mesh>();
  private overlays: THREE.Mesh[] = [];
  private history: FaceSelection[][] = [];
  private ray = new THREE.Raycaster();
  private drawing = false;
  private height: number;
  constructor(private gltf: GLTF, private canvas: HTMLCanvasElement, private camera: THREE.Camera,
    private changed: (count: number) => void, private storageKey: string) {
    this.height = new THREE.Box3().setFromObject(gltf.scene).getSize(new THREE.Vector3()).y;
    gltf.scene.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      const association = gltf.parser.associations.get(object) as { meshes?: number; primitives?: number } | undefined;
      let parent: THREE.Object3D | null = object, node: number | undefined;
      while (parent && node === undefined) { node = gltf.parser.associations.get(parent)?.nodes; parent = parent.parent; }
      if (node !== undefined && association?.meshes !== undefined) this.meshes.set(`${node}:${association.primitives ?? 0}`, object);
    });
    try { this.restore(JSON.parse(sessionStorage.getItem(storageKey) || '[]')); } catch { /* stale draft */ }
    canvas.addEventListener('pointerdown', this.down, true);
    canvas.addEventListener('pointermove', this.move, true);
    canvas.addEventListener('pointerup', this.up, true);
    canvas.addEventListener('pointercancel', this.up, true);
    canvas.style.cursor = 'crosshair';
  }
  private down = (event: PointerEvent) => {
    if (event.button !== 0) return;
    event.stopImmediatePropagation(); event.preventDefault();
    this.history.push(this.export()); if (this.history.length > 30) this.history.shift();
    this.drawing = true; this.canvas.setPointerCapture(event.pointerId); this.paint(event);
  };
  private move = (event: PointerEvent) => { if (this.drawing) { event.stopImmediatePropagation(); this.paint(event); } };
  private up = (event: PointerEvent) => { if (this.drawing) { event.stopImmediatePropagation(); this.drawing = false; this.canvas.releasePointerCapture(event.pointerId); } };
  private paint(event: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    this.ray.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), this.camera);
    const hits = this.ray.intersectObjects([...this.meshes.values()].filter(mesh => mesh.visible), false);
    const hit = hits[0]; if (!hit || hit.faceIndex === undefined) return;
    const mesh = hit.object as THREE.Mesh;
    const key = [...this.meshes].find(([, value]) => value === mesh)?.[0]; if (!key) return;
    const selection = this.assignments.get(key) ?? new Map<number, string>(); this.assignments.set(key, selection);
    const positions = mesh.geometry.attributes.position, indices = mesh.geometry.index;
    const count = (indices?.count ?? positions.count) / 3;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), center = new THREE.Vector3(), normal = new THREE.Vector3();
    for (let face = 0; face < count; face++) {
      mesh.getVertexPosition(indices?.getX(face * 3) ?? face * 3, a); a.applyMatrix4(mesh.matrixWorld);
      mesh.getVertexPosition(indices?.getX(face * 3 + 1) ?? face * 3 + 1, b); b.applyMatrix4(mesh.matrixWorld);
      mesh.getVertexPosition(indices?.getX(face * 3 + 2) ?? face * 3 + 2, c); c.applyMatrix4(mesh.matrixWorld);
      center.copy(a).add(b).add(c).multiplyScalar(1 / 3);
      if (face !== hit.faceIndex && center.distanceTo(hit.point) > this.height * this.settings.radius) continue;
      normal.subVectors(b, a).cross(c.clone().sub(a));
      if (normal.dot(this.ray.ray.direction) >= 0 && face !== hit.faceIndex) continue;
      if (this.settings.erase || event.altKey) selection.delete(face); else selection.set(face, this.settings.role);
    }
    this.refresh();
  }
  export(): FaceSelection[] {
    const result: FaceSelection[] = [];
    for (const [key, values] of this.assignments) {
      const [node_index, primitive_index] = key.split(':').map(Number);
      const roles = new Set(values.values());
      for (const role of roles) result.push({ node_index, primitive_index, role, faces: [...values].filter(([, r]) => r === role).map(([face]) => face).sort((a, b) => a - b) });
    }
    return result;
  }
  private restore(values: FaceSelection[]) {
    this.assignments.clear();
    for (const value of values) {
      const key = `${value.node_index}:${value.primitive_index}`; if (!this.meshes.has(key)) continue;
      const assigned = this.assignments.get(key) ?? new Map<number, string>();
      for (const face of value.faces) assigned.set(face, value.role); this.assignments.set(key, assigned);
    }
    this.refresh();
  }
  undo() { const values = this.history.pop(); if (values) this.restore(values); }
  clear() { this.history.push(this.export()); this.restore([]); }
  private removeOverlays() { for (const mesh of this.overlays) { mesh.removeFromParent(); mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); } this.overlays = []; }
  private refresh() {
    this.removeOverlays();
    const colors: Record<string, number> = { hair: 0xab73ff, head: 0xffcf80, hat: 0x65b5ff, body: 0xffa596, top: 0x4ddbce, pants: 0x70a0ff, skirt: 0xef83c4 };
    for (const selection of this.export()) {
      const mesh = this.meshes.get(`${selection.node_index}:${selection.primitive_index}`)!;
      const geometry = new THREE.BufferGeometry();
      // Shared vertex attributes are not copied or edited by the selection overlay.
      for (const [name, attribute] of Object.entries(mesh.geometry.attributes)) geometry.setAttribute(name, attribute);
      const index = mesh.geometry.index;
      geometry.setIndex(selection.faces.flatMap(face => [0, 1, 2].map(i => index?.getX(face * 3 + i) ?? face * 3 + i)));
      const material = new THREE.MeshBasicMaterial({ color: colors[selection.role] ?? 0xd7ed91, transparent: true, opacity: .55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      const overlay = mesh instanceof THREE.SkinnedMesh ? new THREE.SkinnedMesh(geometry, material) : new THREE.Mesh(geometry, material);
      if (overlay instanceof THREE.SkinnedMesh && mesh instanceof THREE.SkinnedMesh) { overlay.bind(mesh.skeleton, mesh.bindMatrix); overlay.bindMode = mesh.bindMode; }
      overlay.userData.editorOverlay = true; overlay.frustumCulled = false;
      mesh.add(overlay); this.overlays.push(overlay);
    }
    const values = this.export(); sessionStorage.setItem(this.storageKey, JSON.stringify(values));
    this.changed(values.reduce((sum, item) => sum + item.faces.length, 0));
  }
  dispose() {
    this.removeOverlays();
    this.canvas.removeEventListener('pointerdown', this.down, true); this.canvas.removeEventListener('pointermove', this.move, true);
    this.canvas.removeEventListener('pointerup', this.up, true); this.canvas.removeEventListener('pointercancel', this.up, true); this.canvas.style.cursor = '';
  }
}
