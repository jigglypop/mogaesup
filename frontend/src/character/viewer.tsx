import { Component, Suspense, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { createRoot, events, extend, useFrame, useThree } from '@react-three/fiber';
import { GaesupWorld, GaesupWorldContent, GaesupController, useGaesupStoreApi } from 'gaesup-world';
import { CuboidCollider, Physics, RigidBody, type RapierRigidBody } from '@react-three/rapier';
import { WebGPURenderer } from 'three/webgpu';
import * as THREE from 'three';

extend(THREE as unknown as Parameters<typeof extend>[0]);
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FaceEditor, type PaintSettings } from './face-editor';
import { captureRestPose } from './model-pose';
import { NativeWardrobe, type Tuck, type Wearable } from './native-wardrobe';
import { TextureExpressions } from './texture-expressions';
import { matteCharacter } from './matte-materials';
import { disposeObjectResources } from './assets/gpu-resources';

type Model = { gltf: GLTF; url: string; rigged: boolean; restorePose(): void };
export type CardView = 'front' | 'side' | 'back' | 'opposite';
type ViewProps = { model: Model; animation: number; hidden: Set<number>; editing: boolean; studio?: boolean; card?: boolean; cardView: CardView; onEditor(editor: FaceEditor | null): void; onPaint(count: number): void; onReady(): void; onError(error: Error): void; onWorld(position: { x: number; y: number; z: number }, meshes: number): void };
const worldMode = { type: 'character', controller: 'keyboard', control: 'thirdPerson' } as const;

const release = (gltf: GLTF) => disposeObjectResources(gltf.scenes);
/** Where the walking preview drops the character; one vector, so re-renders do not respawn it. */
const START = new THREE.Vector3(0, .12, 0);

class PreviewBoundary extends Component<{ children: ReactNode; onError(error: Error): void }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override componentDidCatch(error: Error) { this.props.onError(error); }
  override render() { return this.state.failed ? null : this.props.children; }
}

function CharacterScene({ model, animation, hidden, onReady, onWorld }: ViewProps) {
  const gl = useThree(state => state.gl);
  const storeApi = useGaesupStoreApi();
  const body = useRef<RapierRigidBody>(null!);
  const outer = useRef<THREE.Group>(null!);
  const inner = useRef<THREE.Group>(null!);
  const mixer = useMemo(() => new THREE.AnimationMixer(model.gltf.scene), [model]);
  const playing = useRef(-2);
  const ready = useRef(false), sample = useRef(0);
  useEffect(() => { ready.current = false; playing.current = -2; }, [model]);
  const bounds = useMemo(() => new THREE.Box3().setFromObject(model.gltf.scene), [model]);
  const size = useMemo(() => bounds.getSize(new THREE.Vector3()), [bounds]);
  const origin = useMemo(() => [-((bounds.min.x + bounds.max.x) / 2), -bounds.min.y, -((bounds.min.z + bounds.max.z) / 2)] as [number, number, number], [bounds]);
  const excluded = useMemo(() => {
    const names: string[] = [];
    model.gltf.scene.traverse(node => { if (node instanceof THREE.Mesh) names.push(node.name); });
    return names;
  }, [model]);
  useEffect(() => {
    model.gltf.scene.traverse(node => {
      const index = model.gltf.parser.associations.get(node)?.nodes;
      if (index !== undefined) node.visible = !hidden.has(index);
    });
  }, [model, hidden]);
  useEffect(() => {
    const canvas = gl.domElement;
    canvas.tabIndex = 0; canvas.setAttribute('aria-label', '개숲월드 캐릭터 이동 영역');
    const activate = () => { canvas.focus(); storeApi.getState().setInteractionActive(true); };
    const deactivate = () => storeApi.getState().setInteractionActive(false);
    canvas.addEventListener('pointerdown', activate); canvas.addEventListener('blur', deactivate);
    deactivate();
    return () => { canvas.removeEventListener('pointerdown', activate); canvas.removeEventListener('blur', deactivate); deactivate(); };
  }, [gl, storeApi]);
  useEffect(() => {
    return () => { mixer.stopAllAction(); mixer.uncacheRoot(model.gltf.scene); };
  }, [mixer, model]);
  useFrame((_, delta) => {
    if (!body.current || !outer.current) return;
    const velocity = body.current.linvel(), speed = Math.hypot(velocity.x, velocity.z);
    const pattern = velocity.y > .8 ? /^jump$/i : velocity.y < -1 ? /^fall$/i : speed > 5 ? /run|running/i : speed > .1 ? /walk|walking/i : /idle|standing/i;
    const matched = animation >= 0 ? animation : model.gltf.animations.findIndex(clip => pattern.test(clip.name));
    // A missing airborne clip keeps the last real action playing. Never turn a
    // missing jump/fall into an unlabeled clip or a frozen rest pose.
    const requested = matched < 0 && playing.current >= 0 ? playing.current : matched;
    if (requested !== playing.current) {
      mixer.stopAllAction();
      const clip = requested >= 0 ? model.gltf.animations[requested] : undefined;
      if (clip) {
        const action = mixer.clipAction(clip).reset();
        action.setLoop(/^jump$|^fall$/i.test(clip.name) ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
        action.clampWhenFinished = true; action.fadeIn(.12).play();
      }
      playing.current = requested;
    }
    mixer.update(Math.min(delta, .1));
    if (!ready.current || ++sample.current % 12 === 0) {
      let count = 0;
      model.gltf.scene.traverseVisible(node => { if (node instanceof THREE.Mesh) count++; });
      onWorld(body.current.translation(), count);
      if (!ready.current && count > 0) { ready.current = true; onReady(); }
    }
  });
  return <GaesupController key={model.url} clickToMove={false} position={START}
    rigidBodyRef={body} outerGroupRef={outer} innerGroupRef={inner}
    colliderSize={{ height: Math.max(size.y, .3), radius: Math.max(.15, Math.min(size.x, size.z) * .3) }}
    excludeBaseNodes={excluded}>
    <group rotation={[0, Math.PI, 0]}><group position={origin}><primitive object={model.gltf.scene} dispose={null} /></group></group>
  </GaesupController>;
}

function EditingScene({ model, animation, editing, studio, hidden, onEditor, onPaint, onReady }: ViewProps) {
  const { camera, gl, invalidate } = useThree();
  const storeApi = useGaesupStoreApi();
  const controls = useRef<OrbitControls | null>(null);
  const group = useRef<THREE.Group>(null!);
  const mixer = useMemo(() => new THREE.AnimationMixer(model.gltf.scene), [model]);
  useEffect(() => {
    model.gltf.scene.traverse(node => {
      const index = model.gltf.parser.associations.get(node)?.nodes;
      if (index !== undefined) node.visible = !hidden.has(index);
    });
  }, [model, hidden]);
  useEffect(() => {
    storeApi.getState().setInteractionActive(false);
    model.restorePose();
    model.gltf.scene.updateMatrixWorld(true);
    let box = new THREE.Box3().setFromObject(model.gltf.scene);
    const initialCenter = box.getCenter(new THREE.Vector3());
    group.current.position.set(-initialCenter.x, -box.min.y, -initialCenter.z);
    group.current.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(model.gltf.scene);
    const center = box.getCenter(new THREE.Vector3()), height = Math.max(box.getSize(new THREE.Vector3()).y, .5);
    camera.position.copy(center).add(new THREE.Vector3(0, height * .1, height * 2.4)); camera.lookAt(center);
    const orbit = new OrbitControls(camera, gl.domElement); orbit.target.copy(center); orbit.enableDamping = true;
    orbit.mouseButtons = { LEFT: studio && !editing ? THREE.MOUSE.ROTATE : -1 as THREE.MOUSE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE }; orbit.update(); controls.current = orbit;
    const changed = () => invalidate();
    orbit.addEventListener('change', changed);
    const editor = editing ? new FaceEditor(model.gltf, gl.domElement, camera, onPaint, `atelier.faces:${model.url}`) : null; onEditor(editor); onReady();
    invalidate();
    return () => { editor?.dispose(); orbit.removeEventListener('change', changed); orbit.dispose(); controls.current = null; onEditor(null); };
  }, [model, editing, studio, camera, gl, onEditor, onPaint, onReady, storeApi]);
  useEffect(() => {
    mixer.stopAllAction();
    if (studio && animation >= 0 && model.gltf.animations[animation]) mixer.clipAction(model.gltf.animations[animation]).reset().play();
    else model.restorePose();
    return () => { mixer.stopAllAction(); mixer.uncacheRoot(model.gltf.scene); };
  }, [studio, animation, model, mixer]);
  useFrame((_, delta) => {
    controls.current?.update();
    if (studio && animation >= 0) { mixer.update(Math.min(delta, .1)); invalidate(); }
  });
  return <group ref={group}><primitive object={model.gltf.scene} dispose={null} /></group>;
}

function CardScene({ model, animation, hidden, cardView, onReady, onError }: ViewProps) {
  const { camera, gl, invalidate, size: viewport } = useThree();
  const controls = useRef<OrbitControls | null>(null);
  const group = useRef<THREE.Group>(null!);
  const mixer = useMemo(() => new THREE.AnimationMixer(model.gltf.scene), [model]);
  useEffect(() => {
    model.gltf.scene.traverse(node => {
      const index = model.gltf.parser.associations.get(node)?.nodes;
      if (index !== undefined) node.visible = !hidden.has(index);
    });
  }, [model, hidden]);
  useEffect(() => {
    mixer.stopAllAction();
    const clip = animation >= 0 ? model.gltf.animations[animation] : undefined;
    if (clip) mixer.clipAction(clip).reset().play();
    else model.restorePose();
    invalidate();
    return () => { mixer.stopAllAction(); mixer.uncacheRoot(model.gltf.scene); };
  }, [animation, model, mixer, invalidate]);
  useEffect(() => {
    model.restorePose();
    group.current.position.set(0, 0, 0);
    group.current.updateMatrixWorld(true);
    model.gltf.scene.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(model.gltf.scene);
    if (bounds.isEmpty()) {
      onError(new Error('모델의 표시 가능한 경계를 찾을 수 없습니다.'));
      return;
    }
    const center = bounds.getCenter(new THREE.Vector3());
    const dimensions = bounds.getSize(new THREE.Vector3());
    group.current.position.copy(center).multiplyScalar(-1);
    group.current.updateMatrixWorld(true);

    const perspective = camera as THREE.PerspectiveCamera;
    const aspect = Math.max(viewport.width / Math.max(viewport.height, 1), .1);
    perspective.aspect = aspect;
    const verticalFov = THREE.MathUtils.degToRad(perspective.fov);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * aspect);
    const profile = cardView === 'side' || cardView === 'opposite';
    const depth = profile ? dimensions.x : dimensions.z;
    const width = profile ? dimensions.z : dimensions.x;
    const distance = Math.max(
      depth / 2 + dimensions.y / (2 * Math.tan(verticalFov / 2)),
      depth / 2 + width / (2 * Math.tan(horizontalFov / 2)),
      .25,
    ) * 1.18;
    if (profile) perspective.position.set(cardView === 'side' ? distance : -distance, 0, 0);
    else perspective.position.set(0, 0, cardView === 'back' ? -distance : distance);
    perspective.near = Math.max(distance / 100, .001);
    perspective.far = Math.max(distance * 20, dimensions.length() * 10, 10);
    perspective.lookAt(0, 0, 0);
    perspective.updateProjectionMatrix();

    const orbit = new OrbitControls(perspective, gl.domElement);
    orbit.target.set(0, 0, 0);
    orbit.enableDamping = true;
    orbit.enablePan = false;
    orbit.enableZoom = true;
    orbit.minDistance = Math.max(distance * .2, .02);
    orbit.maxDistance = distance * 8;
    orbit.update();
    const changed = () => invalidate();
    orbit.addEventListener('change', changed);
    controls.current = orbit;
    onReady();
    invalidate();
    return () => {
      orbit.removeEventListener('change', changed);
      orbit.dispose();
      controls.current = null;
    };
  }, [camera, cardView, gl, invalidate, model, onError, onReady, viewport.height, viewport.width]);
  useFrame((_, delta) => {
    if (animation >= 0 && model.gltf.animations[animation]) { mixer.update(Math.min(delta, .1)); invalidate(); }
    if (controls.current?.update()) invalidate();
  });
  return <group ref={group}><primitive object={model.gltf.scene} dispose={null} /></group>;
}

function Garden() {
  const extent = 48;
  return <>
    <color attach="background" args={['#dce9e2']} />
    <fog attach="fog" args={['#dce9e2', 40, 110]} />
    <ambientLight intensity={.85} />
    <hemisphereLight args={[0xfffaf0, 0xe2dfc6, 2.6]} />
    <directionalLight position={[4, 9, 5]} intensity={2.3} />
    <directionalLight position={[-3, 3, 5]} intensity={.6} />
    <RigidBody type="fixed" colliders="cuboid">
      <mesh position={[0, -.2, 0]} receiveShadow><boxGeometry args={[extent * 2, .4, extent * 2]} /><meshStandardMaterial color="#abc8ae" roughness={.95} /></mesh>
    </RigidBody>
    <RigidBody type="fixed" colliders={false}>
      <CuboidCollider args={[extent, 2, .25]} position={[0, 1.8, -extent]} />
      <CuboidCollider args={[extent, 2, .25]} position={[0, 1.8, extent]} />
      <CuboidCollider args={[.25, 2, extent]} position={[-extent, 1.8, 0]} />
      <CuboidCollider args={[.25, 2, extent]} position={[extent, 1.8, 0]} />
    </RigidBody>
    <gridHelper args={[extent * 2, 48, '#8aaa93', '#a1bea5']} position={[0, .005, 0]} />
    {[-1, 1].flatMap(x => [-1, 1].map(z => <group key={`${x}:${z}`} position={[x * 7, 0, z * 7]}>
      <RigidBody type="fixed" colliders="cuboid"><mesh position={[0, .8, 0]}><cylinderGeometry args={[.22, .3, 1.6, 8]} /><meshStandardMaterial color="#958071" /></mesh></RigidBody>
      <mesh position={[0, 2.4, 0]}><icosahedronGeometry args={[1.5, 1]} /><meshStandardMaterial color={x > 0 ? '#739e82' : '#93b58a'} roughness={1} /></mesh>
    </group>))}
  </>;
}

/** Soft light for matte characters: a warm fill from below and the front keeps faces bright. */
function SoftLights() {
  return <>
    <ambientLight intensity={.65} />
    <hemisphereLight args={[0xfffaf2, 0xe0d3c1, 2.4]} />
    <directionalLight position={[2, 4, 6]} intensity={1.9} />
    <directionalLight position={[-4, 2, 4]} intensity={.85} />
    <directionalLight position={[0, 3, -5]} intensity={.9} />
  </>;
}

function CharacterViewport(props: ViewProps) {
  const urls = useMemo(() => ({ characterUrl: props.model.url }), [props.model.url]);
  const cameraOption = useMemo(() => {
    const height = Math.max(new THREE.Box3().setFromObject(props.model.gltf.scene).getSize(new THREE.Vector3()).y, 1);
    return { type: 'thirdPerson' as const, xDistance: 0, yDistance: height * 1.6, zDistance: height * 3.6,
      distance: height * 3.6, maxDistance: height * 7, fov: 40, zoom: 1, enableZoom: true,
      minZoom: .75, maxZoom: 1.6, zoomSpeed: .001, enableCollision: false,
      smoothing: { position: .14, rotation: .14, fov: .12 }, bounds: { minX: -54, maxX: 54, minY: .35, maxY: 24, minZ: -54, maxZ: 54 } };
  }, [props.model]);
  if (props.card) return <GaesupWorld urls={urls}>
    <PreviewBoundary onError={props.onError}>
      <SoftLights />
      <CardScene {...props} />
    </PreviewBoundary>
  </GaesupWorld>;
  if (props.studio) return <GaesupWorld urls={urls}>
    <PreviewBoundary onError={props.onError}>
      <color attach="background" args={['#191f17']} />
      <SoftLights />
      <gridHelper args={[20, 40, '#3d4b32', '#293222']} position={[0, -.02, 0]} />
      <EditingScene {...props} />
    </PreviewBoundary>
  </GaesupWorld>;
  return <GaesupWorld urls={urls} mode={worldMode} cameraOption={cameraOption}>
    <PreviewBoundary onError={props.onError}>
        <Suspense fallback={null}>
          <Physics gravity={[0, -9.81, 0]}>
            {props.editing || !props.model.rigged ? <><Garden /><EditingScene {...props} /></> : <GaesupWorldContent showGrid={false} showAxes={false}>
              <Garden />
              <CharacterScene {...props} />
            </GaesupWorldContent>}
          </Physics>
        </Suspense>
    </PreviewBoundary>
  </GaesupWorld>;
}

/** DOM workspace bridge; React/R3F own the canvas, render loop, camera and model scene. */
export class ModelViewer {
  private expressions?: TextureExpressions;
  private expressionError = '';
  private wardrobe?: NativeWardrobe;
  private root?: ReturnType<typeof createRoot>;
  private mount = document.createElement('div');
  private canvas = document.createElement('canvas');
  private observer: ResizeObserver;
  private visibilityObserver: IntersectionObserver;
  private inViewport = true;
  private initializing?: Promise<void>;
  private badge = document.createElement('span');
  private model: Model | null = null;
  private retired: GLTF[] = [];
  private animation = -1;
  private cardView: CardView = 'front';
  private editing = false;
  private editor: FaceEditor | null = null;
  private paintSettings: PaintSettings = { role: 'hair', radius: .04, erase: false };
  private paintCount: (count: number) => void = () => {};
  private onEditor = (editor: FaceEditor | null) => { this.editor = editor; if (editor) editor.settings = this.paintSettings; };
  private onPaint = (count: number) => this.paintCount(count);
  private hidden = new Set<number>();
  private generation = 0;
  private disposed = false;
  private request?: AbortController;
  private renderers = new Set<WebGPURenderer>();
  private finish?: () => void;
  private fail?: (error: Error) => void;
  constructor(private container: HTMLElement, private presentation: 'world' | 'studio' | 'card' = 'world') {
    this.mount.className = 'r3f-viewport'; this.badge.className = 'renderer-badge';
    this.badge.textContent = 'WebGPU 초기화 중';
    container.append(this.mount, this.badge);
    this.mount.append(this.canvas);
    this.observer = new ResizeObserver(() => { if (this.root && !this.disposed) void this.root.configure({ size: this.size() }); });
    this.observer.observe(container);
    this.visibilityObserver = new IntersectionObserver(entries => {
      this.inViewport = entries.some(entry => entry.isIntersecting);
      this.updateVisibility();
    });
    this.visibilityObserver.observe(container);
    document.addEventListener('visibilitychange', this.updateVisibility);
  }
  private frameLoop() {
    return document.hidden || !this.inViewport ? 'never' : this.presentation === 'world' ? 'always' : 'demand';
  }
  private updateVisibility = () => {
    if (this.root && !this.disposed) void this.root.configure({ frameloop: this.frameLoop() }).then(() => this.render());
  };
  private size() { return { width: this.container.clientWidth, height: this.container.clientHeight, top: 0, left: 0 }; }
  private initialize() {
    if (this.initializing) return this.initializing;
    const pending = (async () => {
      const renderer = new WebGPURenderer({ canvas: this.canvas, antialias: true, alpha: true });
      try {
        await renderer.init();
        if (this.disposed) { renderer.dispose(); return; }
        this.renderers.add(renderer);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.NeutralToneMapping;
        renderer.setClearColor(0x000000, 0);
        const backend = renderer.backend as { isWebGPUBackend?: boolean };
        this.onBackend(backend.isWebGPUBackend ? 'webgpu' : 'webgl-fallback');
        // Initialize before creating an R3F root so a removed panel cannot finish an async Canvas mount.
        this.root = createRoot(this.canvas);
        await this.root.configure({ gl: renderer, size: this.size(), dpr: Math.min(devicePixelRatio, 1.5),
          frameloop: this.frameLoop(),
          camera: { fov: 42, position: [0, 3, 7] }, events,
          onCreated: state => state.events.connect?.(this.canvas) });
        if (this.disposed) this.root.unmount();
      } catch (error) {
        try { this.root?.unmount(); } catch { /* best-effort cleanup after configure failure */ }
        this.root = undefined;
        this.renderers.delete(renderer);
        renderer.dispose();
        throw error;
      }
    })();
    this.initializing = pending;
    void pending.catch(() => { if (this.initializing === pending) this.initializing = undefined; });
    return pending;
  }
  private onBackend = (value: string) => {
    if (this.disposed) return;
    this.container.dataset.renderer = value;
    this.badge.textContent = value === 'webgpu' ? 'WebGPU · gaesup-world' : 'WebGL 호환 모드 · gaesup-world';
  };
  private onWorld = (position: { x: number; y: number; z: number }, meshes: number) => {
    this.container.dataset.world = 'gaesup-world';
    this.container.dataset.characterPosition = JSON.stringify(position);
    this.container.dataset.characterMeshes = String(meshes);
  };
  private onReady = () => {
    this.retired.forEach(release); this.retired = [];
    this.finish?.(); this.finish = undefined; this.fail = undefined;
  };
  private onError = (error: Error) => {
    this.container.dataset.renderer = 'error'; this.badge.textContent = '렌더러 오류';
    this.fail?.(new Error(`3D 렌더러 오류: ${error.message}`)); this.fail = undefined; this.finish = undefined;
  };
  private render() {
    if (!this.model || this.disposed || !this.root) return;
    const store = this.root.render(<CharacterViewport model={this.model} animation={this.animation} hidden={this.hidden} editing={this.editing} studio={this.presentation === 'studio'} card={this.presentation === 'card'} cardView={this.cardView}
      onEditor={this.onEditor} onPaint={this.onPaint}
      onReady={this.onReady} onError={this.onError} onWorld={this.onWorld} />);
    store.getState().invalidate();
  }
  async load(url: string, options: { sha256?: string; wardrobe?: boolean } = {}) {
    const token = ++this.generation;
    this.request?.abort(); this.finish?.();
    this.request = new AbortController();
    const response = await fetch(url, { signal: AbortSignal.any([this.request.signal, AbortSignal.timeout(20000)]) });
    if (!response.ok) throw new Error('모델 파일을 불러올 수 없습니다.');
    const content = await response.arrayBuffer();
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', content))).map(value => value.toString(16).padStart(2, '0')).join('');
    if (options.sha256 && options.sha256 !== digest) throw new Error('모델이 고정한 몸 버전과 다릅니다.');
    const gltf = await new GLTFLoader().parseAsync(content, '');
    if (this.disposed || token !== this.generation) { release(gltf); return []; }
    matteCharacter(gltf.scene);
    let wardrobe: NativeWardrobe | undefined;
    if (options.wardrobe) {
      // "mesh:primitive" of each body mesh, matching the server's coverage keys.
      const keys = new Map<THREE.Object3D, string>();
      gltf.scene.traverse(object => {
        // GLTFLoader stores {meshes, primitives} per primitive mesh; the typings omit primitives.
        const mapping = gltf.parser.associations.get(object as THREE.Mesh) as { meshes?: number; primitives?: number } | undefined;
        if (mapping?.meshes !== undefined && mapping.primitives !== undefined) keys.set(object, `${mapping.meshes}:${mapping.primitives}`);
      });
      try { wardrobe = new NativeWardrobe(gltf.scene, keys); }
      catch (error) { release(gltf); throw error; }
    }
    if (this.model) this.retired.push(this.model.gltf);
    this.expressions?.dispose(); this.expressions = undefined; this.expressionError = '';
    if (options.wardrobe) {
      try { this.expressions = new TextureExpressions(gltf); }
      catch (e) { this.expressionError = (e as Error).message; }
    }
    this.wardrobe?.dispose(); this.wardrobe = wardrobe;
    let rigged = false; gltf.scene.traverse(object => { if (object instanceof THREE.SkinnedMesh) rigged = true; });
    this.model = { gltf, rigged, restorePose: captureRestPose(gltf.scene), url: `${url}${url.includes('?') ? '&' : '?'}sha256=${digest}` }; this.animation = -1; this.hidden = new Set();
    this.container.dataset.modelSha256 = digest;
    await this.initialize();
    if (this.disposed || token !== this.generation) return [];
    await new Promise<void>((resolve, reject) => { this.finish = resolve; this.fail = reject; this.render(); });
    return gltf.animations.map((clip, index) => ({ index, name: clip.name || `Animation ${index + 1}` }));
  }
  play(index: number) { this.animation = index; this.render(); }
  setCardView(view: CardView) { if (this.presentation === 'card') { this.cardView = view; this.render(); } }
  setWireframe(enabled: boolean) {
    this.model?.gltf.scene.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if ('wireframe' in material) {
          material.wireframe = enabled;
          material.needsUpdate = true;
        }
      }
    });
    this.render();
  }
  async clearExpression() {
    this.expressions?.clear(); this.render();
    return !this.disposed;
  }
  async savedExpression(maps: { material: number; url: string; sha256: string }[]) {
    if (!this.expressions) throw new Error(this.expressionError || '표정 텍스쳐가 준비되지 않았습니다.');
    const expressions = this.expressions;
    const applied = await expressions.saved(maps);
    if (!applied || this.disposed || expressions !== this.expressions) return false;
    this.render();
    return true;
  }
  wear(parts: Wearable[]) {
    if (!this.wardrobe) return Promise.reject(new Error('공용 골격 옷장이 준비되지 않았습니다.'));
    return this.wardrobe.equip(parts).then(applied => { if (applied) this.render(); return applied; });
  }
  wardrobeDiagnostics() { return this.wardrobe?.diagnostics(); }
  setHairColor(color: string | null) { this.wardrobe?.setHairColor(color); this.render(); }
  setHiddenBodyTriangles(hidden: Record<string, Uint8Array> | null) { this.wardrobe?.hideTriangles(hidden); this.render(); }
  setTucked(slot: string, tuck: Tuck | null, outer: Record<string, Uint8Array> | null) { this.wardrobe?.tuckUnder(slot, tuck, outer); this.render(); }
  setPartColors(slot: string, material: number, mask: THREE.Texture, lights: number[], colors: (string | null)[]) { this.wardrobe?.setRegionColors(slot, material, mask, lights, colors); this.render(); }
  setEditing(enabled: boolean, onCount: (count: number) => void) { this.editing = enabled; this.paintCount = onCount; this.render(); }
  setPaint(settings: PaintSettings) { this.paintSettings = settings; if (this.editor) this.editor.settings = settings; }
  selections() { return this.editor?.export() ?? []; }
  undoPaint() { this.editor?.undo(); }
  clearPaint() { this.editor?.clear(); }
  setVisible(index: number, visible: boolean) {
    this.hidden = new Set(this.hidden);
    if (visible) this.hidden.delete(index); else this.hidden.add(index);
    this.render();
  }
  dispose() {
    this.expressions?.dispose(); this.expressions = undefined;
    this.wardrobe?.dispose(); this.wardrobe = undefined;
    this.disposed = true; this.generation++; this.request?.abort(); this.finish?.();
    this.observer.disconnect(); this.visibilityObserver.disconnect();
    document.removeEventListener('visibilitychange', this.updateVisibility); this.root?.unmount();
    // R3F completes its canvas cleanup on a deferred callback; release the WebGPU device afterwards.
    const renderers = this.renderers;
    setTimeout(() => { renderers.forEach(renderer => renderer.dispose()); renderers.clear(); }, 600);
    if (this.model) release(this.model.gltf);
    this.retired.forEach(release); this.retired = [];
    this.mount.remove(); this.badge.remove(); delete this.container.dataset.renderer;
  }
}
