// The admin page's 3D preview. It loads on first use, so /admin itself stays light.
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useState } from 'react';
import { normalizeImportedMaterials, useRendererRecovery } from 'gaesup-world';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { disposeObjectResources } from '../../character/assets/gpu-resources';
import { createWorldRenderer } from '../../rendering/worldRenderer';

type Loaded = { gltf: GLTF; center: THREE.Vector3; size: THREE.Vector3; triangles: number; restoreMaterials(): void };
type Backend = 'webgpu' | 'webgl-fallback';

function release(loaded: Loaded) {
  loaded.restoreMaterials();
  disposeObjectResources(loaded.gltf.scenes);
}

function measure(gltf: GLTF): Loaded {
  gltf.scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(gltf.scene);
  let triangles = 0;
  gltf.scene.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const geometry = node.geometry as THREE.BufferGeometry;
    triangles += Math.floor((geometry.index?.count ?? geometry.getAttribute('position')?.count ?? 0) / 3);
  });
  const empty = box.isEmpty();
  return {
    gltf,
    center: empty ? new THREE.Vector3() : box.getCenter(new THREE.Vector3()),
    size: empty ? new THREE.Vector3(1, 1, 1) : box.getSize(new THREE.Vector3()),
    triangles,
    restoreMaterials: normalizeImportedMaterials(gltf.scene, 'figure'),
  };
}

/** Idle first, as the island shows a standing 미니미. */
const firstClip = (clips: THREE.AnimationClip[]) => {
  const idle = clips.findIndex((clip) => /idle|standing/i.test(clip.name));
  return idle >= 0 ? idle : clips.length ? 0 : -1;
};

function Figure({ loaded, clip }: { loaded: Loaded; clip: number }) {
  const mixer = useMemo(() => new THREE.AnimationMixer(loaded.gltf.scene), [loaded]);
  useEffect(() => {
    const animation = loaded.gltf.animations[clip];
    if (!animation) return;
    const action = mixer.clipAction(animation).reset().play();
    return () => {
      action.stop();
    };
  }, [mixer, loaded, clip]);
  useEffect(
    () => () => {
      mixer.stopAllAction();
      mixer.uncacheRoot(loaded.gltf.scene);
    },
    [mixer, loaded],
  );
  useFrame((_, delta) => mixer.update(Math.min(delta, 0.1)));
  return <primitive object={loaded.gltf.scene} dispose={null} />;
}

/** Drag to turn and pinch or scroll to zoom around the figure; it turns slowly on its own when `spin` is on. */
function Orbit({ target, distance, spin }: { target: THREE.Vector3; distance: number; spin: boolean }) {
  const camera = useThree((state) => state.camera);
  const element = useThree((state) => state.gl.domElement);
  const controls = useMemo(() => new OrbitControls(camera, element), [camera, element]);
  useEffect(() => {
    controls.target.copy(target);
    controls.enablePan = false;
    controls.enableDamping = true;
    controls.minDistance = distance * 0.2;
    controls.maxDistance = distance * 4;
    controls.update();
  }, [controls, target, distance]);
  useEffect(() => {
    controls.autoRotate = spin;
    controls.autoRotateSpeed = 1.2;
  }, [controls, spin]);
  useEffect(() => () => controls.dispose(), [controls]);
  useFrame((_, delta) => controls.update(delta));
  return null;
}

/** A turntable for one GLB: drag to turn, pinch or scroll to zoom, and play its clips. Meshopt files load too. */
export default function ModelPreview({ url }: { url: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [problem, setProblem] = useState('');
  const [clip, setClip] = useState(-1);
  const [spin, setSpin] = useState(true);
  const [renderer, setRenderer] = useState<{ key: number; backend: Backend } | null>(null);
  const canvasKey = useRendererRecovery();
  const backend = renderer?.key === canvasKey ? renderer.backend : null;

  useEffect(() => {
    let alive = true;
    let held: Loaded | null = null;
    setLoaded(null);
    setProblem('');
    new GLTFLoader()
      .setMeshoptDecoder(MeshoptDecoder)
      .loadAsync(url)
      .then(
        (gltf) => {
          if (!alive) return disposeObjectResources(gltf.scenes);
          held = measure(gltf);
          setLoaded(held);
          setClip(firstClip(gltf.animations));
        },
        (error: unknown) => alive && setProblem(error instanceof Error ? error.message : String(error)),
      );
    return () => {
      alive = false;
      if (held) release(held);
    };
  }, [url]);

  if (problem) {
    return (
      <p className="mg-error" role="alert">
        미리보기를 불러오지 못했어요. ({problem})
      </p>
    );
  }
  if (!loaded) return <p className="mg-empty">모델을 불러오는 중…</p>;
  const { center, size } = loaded;
  const reach = Math.max(size.y, size.x, 0.2);
  // Far enough that the whole figure fits the 35° view with some air around it.
  const distance = (reach / 2 / Math.tan(THREE.MathUtils.degToRad(35 / 2))) * 1.35;
  const animations = loaded.gltf.animations;
  return (
    <div className="mg-admin-preview" data-renderer={backend ?? 'initializing'}>
      <div className="mg-admin-stage">
        <Canvas
          key={canvasKey}
          gl={createWorldRenderer}
          dpr={[1, 1.5]}
          camera={{ fov: 35, near: distance / 100, far: distance * 20, position: [center.x, center.y + reach * 0.08, center.z + distance] }}
          onCreated={({ gl }) => {
            gl.outputColorSpace = THREE.SRGBColorSpace;
            gl.toneMapping = THREE.NeutralToneMapping;
            gl.setClearColor(0x000000, 0);
            const device = (gl as unknown as { backend?: { isWebGPUBackend?: boolean } }).backend;
            setRenderer({ key: canvasKey, backend: device?.isWebGPUBackend ? 'webgpu' : 'webgl-fallback' });
          }}
        >
          <ambientLight intensity={0.65} />
          <hemisphereLight args={[0xfffaf2, 0xe0d3c1, 2.4]} />
          <directionalLight position={[2, 4, 6]} intensity={1.9} />
          <directionalLight position={[-4, 2, 4]} intensity={0.85} />
          <directionalLight position={[0, 3, -5]} intensity={0.9} />
          <Figure loaded={loaded} clip={clip} />
          <Orbit target={center} distance={distance} spin={spin} />
        </Canvas>
      </div>
      {backend && backend !== 'webgpu' && <span className="mg-chip is-soft">WebGL 호환 모드</span>}
      <p className="mg-admin-fineprint">
        삼각형 {loaded.triangles.toLocaleString('ko-KR')} · 높이 {size.y.toFixed(2)} m · 애니메이션 {animations.length}개
      </p>
      <div className="mg-admin-chips" role="group" aria-label="애니메이션">
        <button type="button" className="mg-chip" aria-pressed={spin} onClick={() => setSpin(!spin)}>
          자동 회전
        </button>
        <button type="button" className="mg-chip" aria-pressed={clip < 0} onClick={() => setClip(-1)}>
          멈춤
        </button>
        {animations.map((animation, index) => (
          <button key={`${animation.name}-${index}`} type="button" className="mg-chip" aria-pressed={clip === index} onClick={() => setClip(index)}>
            {animation.name || `애니메이션 ${index + 1}`}
          </button>
        ))}
      </div>
    </div>
  );
}
