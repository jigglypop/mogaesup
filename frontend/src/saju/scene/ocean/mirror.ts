import {
  Color,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  OrthographicCamera,
  Plane,
  RenderTarget,
  Vector3,
  Vector4,
  WebGLCoordinateSystem,
  type CoordinateSystem,
  type Light,
  type LightShadow,
  type Object3D,
  type Scene,
  type Texture,
} from 'three';
import type { WebGPURenderer } from 'three/webgpu';

import { WATER_LEVEL } from '../mood';

// What stands over the water, mirrored in it: the scene drawn a second time from the camera's reflection under the
// surface, into a picture of its own at a fraction of the canvas's size. Only what stands above the water is mirrored:
// the mirror's near plane is laid on the surface itself, so the islands' banks under the water are cut away.

const inverse = new Matrix4();
const corner = new Vector4();
const clipped = new Vector4();

/**
 * Moves the near plane of `projection` onto `plane` (a plane in the camera's own space, its normal toward what is kept),
 * keeping the far plane through the far corner of the old frustum (Lengyel's oblique frustum). Works for any projection:
 * written for depth from -1 to 1 (WebGL) or from 0 to 1 (WebGPU), and for depth drawn the other way round.
 */
export function clipNear(projection: Matrix4, plane: Vector4, system: CoordinateSystem, reversed = false): void {
  inverse.copy(projection).invert();
  // The plane in clip space tells which corner of the far face lies furthest behind it.
  clipped.copy(plane).applyMatrix4(inverse.clone().transpose());
  const far = reversed ? 0 : 1;
  corner.set(Math.sign(clipped.x) || 1, Math.sign(clipped.y) || 1, far, 1).applyMatrix4(inverse);
  const e = projection.elements;
  const lastRow = e[3]! * corner.x + e[7]! * corner.y + e[11]! * corner.z + e[15]! * corner.w;
  const across = plane.dot(corner);
  if (Math.abs(across) < 1e-12) return;
  const gl = system === WebGLCoordinateSystem;
  const scale = ((gl ? 2 : 1) * lastRow) / across;
  // The third row becomes the plane, scaled to put the far plane through that corner; for depth from -1 the last row is
  // taken off it again, and for depth drawn backwards the plane is taken off the last row.
  const row = [plane.x * scale, plane.y * scale, plane.z * scale, plane.w * scale];
  if (gl) for (let index = 0; index < 4; index++) row[index]! -= e[index * 4 + 3]!;
  if (reversed) for (let index = 0; index < 4; index++) row[index] = e[index * 4 + 3]! - row[index]!;
  e[2] = row[0]!;
  e[6] = row[1]!;
  e[10] = row[2]!;
  e[14] = row[3]!;
}

/** Only what stands above the water is mirrored in it. */
const SURFACE = new Plane(new Vector3(0, 1, 0), -WATER_LEVEL);
const surfaceInView = new Plane();
const viewPlane = new Vector4();
const ahead = new Vector3();
const eye = new Vector3();
/** From clip space to the mirror's picture, as the node materials read a picture: x from 0 at the left, y from 0 at the top. */
const TO_PICTURE = new Matrix4().set(0.5, 0, 0, 0.5, 0, -0.5, 0, 0.5, 0, 0, 1, 0, 0, 0, 0, 1);

/** A light that casts shadows, and how its shadow was to be cast before the mirror borrowed it. */
type Caster = Light & { shadow: LightShadow };
type Saved = { light: Caster; auto: boolean; needs: boolean };

export class Mirror {
  readonly target: RenderTarget;
  /** From the world to the mirror's picture, as it was last drawn: the surface finds what it mirrors by it. */
  readonly matrix = new Matrix4();
  private readonly camera = new OrthographicCamera();
  private readonly clear = new Color();
  private readonly lights: Caster[] = [];
  private readonly saved: Saved[] = [];
  private drawn = 0;
  private lightsFound = -Infinity;

  constructor() {
    this.target = new RenderTarget(4, 4, { type: HalfFloatType, generateMipmaps: true, minFilter: LinearMipmapLinearFilter, magFilter: LinearFilter, depthBuffer: true });
  }

  get texture(): Texture {
    return this.target.texture;
  }

  setSize(width: number, height: number) {
    const w = Math.max(4, Math.round(width));
    const h = Math.max(4, Math.round(height));
    if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);
  }

  /** The lights whose shadows the mirror borrows from the frame instead of casting its own; looked for now and then. */
  private shadowLights(scene: Scene): Caster[] {
    if (this.drawn - this.lightsFound < 120) return this.lights;
    this.lightsFound = this.drawn;
    this.lights.length = 0;
    scene.traverse((object) => {
      const light = object as Light & { shadow?: LightShadow };
      if (light.isLight && light.castShadow && light.shadow) this.lights.push(light as Caster);
    });
    return this.lights;
  }

  /** Stands the mirror's camera for `view` (the camera the frame is drawn with) and works out {@link matrix}. */
  aim(view: OrthographicCamera): OrthographicCamera {
    const mirror = this.camera;
    view.getWorldDirection(ahead);
    view.getWorldPosition(eye);
    // The camera as the water mirrors it: below the surface, looking up at the same things.
    mirror.position.set(eye.x, 2 * WATER_LEVEL - eye.y, eye.z);
    mirror.up.set(0, 1, 0).applyQuaternion(view.quaternion);
    mirror.up.y = -mirror.up.y;
    mirror.lookAt(mirror.position.x + ahead.x, mirror.position.y - ahead.y, mirror.position.z + ahead.z);
    mirror.near = view.near;
    mirror.far = view.far;
    mirror.coordinateSystem = view.coordinateSystem;
    mirror.updateMatrixWorld();
    // Its right is the view's left: a picture drawn off the canvas's middle (the page's panels) lies off it the other
    // way in the mirror.
    mirror.projectionMatrix.copy(view.projectionMatrix);
    mirror.projectionMatrix.elements[12] *= -1;
    surfaceInView.copy(SURFACE).applyMatrix4(mirror.matrixWorldInverse);
    viewPlane.set(surfaceInView.normal.x, surfaceInView.normal.y, surfaceInView.normal.z, surfaceInView.constant);
    clipNear(mirror.projectionMatrix, viewPlane, view.coordinateSystem, view.reversedDepth);
    mirror.projectionMatrixInverse.copy(mirror.projectionMatrix).invert();
    this.matrix.multiplyMatrices(TO_PICTURE, mirror.projectionMatrix).multiply(mirror.matrixWorldInverse);
    return mirror;
  }

  /**
   * Draws the mirror for `view`, the camera the frame is drawn with, leaving `surface` (the water itself) out of it. The
   * shadows are those the frame casts; the very first picture casts its own, as there are none yet.
   */
  draw(renderer: WebGPURenderer, scene: Scene, view: OrthographicCamera, surface: Object3D): void {
    // The view's projection is only the renderer's once it has drawn with it.
    if (view.coordinateSystem !== renderer.coordinateSystem) return;
    const mirror = this.aim(view);
    const lights = this.shadowLights(scene);
    const first = this.drawn === 0;
    this.saved.length = 0;
    if (!first) {
      for (const light of lights) {
        this.saved.push({ light, auto: light.shadow.autoUpdate, needs: light.shadow.needsUpdate });
        light.shadow.autoUpdate = false;
        light.shadow.needsUpdate = false;
      }
    }
    const before = { target: renderer.getRenderTarget(), alpha: renderer.getClearAlpha(), background: scene.background, autoClear: renderer.autoClear };
    renderer.getClearColor(this.clear);
    surface.visible = false;
    scene.background = null;
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = true;
    renderer.render(scene, mirror);
    renderer.setRenderTarget(before.target);
    renderer.setClearColor(this.clear, before.alpha);
    renderer.autoClear = before.autoClear;
    scene.background = before.background;
    surface.visible = true;
    for (const { light, auto, needs } of this.saved) {
      light.shadow.autoUpdate = auto;
      light.shadow.needsUpdate = needs;
    }
    this.drawn += 1;
  }

  dispose() {
    this.target.dispose();
  }
}
