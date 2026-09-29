import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot, events, extend, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Tile } from './api';

extend(THREE as unknown as Parameters<typeof extend>[0]);

export type TileShape = 'plane' | 'cube' | 'sphere';
export type TilePreviewProps = { tile: Tile; shape?: TileShape; repeat?: number; autoOrbit?: boolean };
type Props = { tile: Tile; shape: TileShape; repeat: number; autoOrbit: boolean };

function artifact(tile: Tile, name: string) {
  return tile.artifacts.find(item => item.name === name)?.url;
}

function Orbit({ autoRotate }: { autoRotate: boolean }) {
  const { camera, gl, invalidate } = useThree();
  const controls = useRef<OrbitControls | null>(null);
  useEffect(() => {
    const orbit = new OrbitControls(camera, gl.domElement);
    orbit.enableDamping = true;
    orbit.autoRotateSpeed = .7;
    orbit.minDistance = 2.2;
    orbit.maxDistance = 7;
    orbit.target.set(0, 0, 0);
    orbit.update();
    const changed = () => invalidate();
    orbit.addEventListener('change', changed);
    controls.current = orbit;
    return () => { orbit.removeEventListener('change', changed); controls.current = null; orbit.dispose(); };
  }, [camera, gl, invalidate]);
  useEffect(() => { if (controls.current) controls.current.autoRotate = autoRotate; }, [autoRotate]);
  useFrame(() => {
    if (controls.current?.update() || autoRotate) invalidate();
  });
  return null;
}

function PreviewMaterial({ tile, shape, repeat, onError }: Pick<Props, 'tile' | 'shape' | 'repeat'> & { onError(error: Error): void }) {
  const [maps, setMaps] = useState<{ albedo: THREE.Texture; normal: THREE.Texture; orm: THREE.Texture }>();
  const albedoUrl = artifact(tile, 'albedo.webp');
  const normalUrl = artifact(tile, 'normal.webp');
  const ormUrl = artifact(tile, 'orm.webp');
  useEffect(() => {
    let cancelled = false, failed = false;
    const loaded = new Set<THREE.Texture>();
    const loader = new THREE.TextureLoader();
    const urls = [albedoUrl, normalUrl, ormUrl];
    setMaps(undefined);
    if (urls.some(url => !url)) {
      onError(new Error('albedo.webp, normal.webp, orm.webp 파일이 모두 필요합니다.'));
      return;
    }
    const load = (url: string | undefined) => loader.loadAsync(url!).then(texture => {
      if (cancelled || failed) texture.dispose();
      else loaded.add(texture);
      return texture;
    });
    void Promise.all(urls.map(load)).then(([albedo, normal, orm]) => {
      if (cancelled || failed) return;
      albedo.colorSpace = THREE.SRGBColorSpace;
      normal.colorSpace = THREE.NoColorSpace;
      orm.colorSpace = THREE.NoColorSpace;
      for (const texture of loaded) {
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.generateMipmaps = true;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.anisotropy = 4;
        texture.needsUpdate = true;
      }
      setMaps({ albedo, normal, orm });
    }).catch(reason => {
      failed = true;
      loaded.forEach(texture => texture.dispose());
      loaded.clear();
      if (!cancelled) onError(reason instanceof Error ? reason : new Error(String(reason)));
    });
    return () => {
      cancelled = true;
      loaded.forEach(texture => texture.dispose());
      loaded.clear();
    };
  }, [albedoUrl, normalUrl, onError, ormUrl, tile.id]);
  useEffect(() => {
    if (!maps) return;
    for (const texture of Object.values(maps)) texture.repeat.set(repeat, repeat);
  }, [maps, repeat]);

  if (!maps) return null;
  const material = <meshStandardMaterial map={maps.albedo} normalMap={maps.normal}
    aoMap={maps.orm} roughnessMap={maps.orm} metalnessMap={maps.orm}
    roughness={1} metalness={1} normalScale={new THREE.Vector2(.75, .75)} />;
  if (shape === 'plane') return <mesh rotation={[-Math.PI/2, 0, 0]}>{material}<planeGeometry args={[3.6, 3.6, 1, 1]} /></mesh>;
  if (shape === 'sphere') return <mesh>{material}<sphereGeometry args={[1.25, 32, 20]} /></mesh>;
  return <mesh>{material}<boxGeometry args={[2.2, 2.2, 2.2]} /></mesh>;
}

function Scene(props: Props & { onTextureError(error: Error): void }) {
  return <>
    <color attach="background" args={['#14151a']} />
    <hemisphereLight args={['#ffffff', '#505767', 2.2]} />
    <directionalLight position={[3, 4, 3]} intensity={3} />
    <directionalLight position={[-3, 1, -2]} intensity={1.1} />
    <PreviewMaterial tile={props.tile} shape={props.shape} repeat={props.repeat} onError={props.onTextureError} />
    <Orbit autoRotate={props.autoOrbit} />
  </>;
}

function ActivePreview(props: Props) {
  const mount = useRef<HTMLDivElement>(null);
  const rootRef = useRef<ReturnType<typeof createRoot> | undefined>(undefined);
  const invalidateRef = useRef<() => void>(() => {});
  const latest = useRef(props);
  latest.current = props;
  const [backend, setBackend] = useState<'loading' | 'webgpu' | 'webgl-fallback' | 'error'>('loading');
  const [loadError, setLoadError] = useState('');
  const onTextureError = useCallback((error: Error) => setLoadError(`텍스처를 불러오지 못했습니다: ${error.message}`), []);
  const tileMapsKey = ['albedo.webp', 'normal.webp', 'orm.webp'].map(name => artifact(props.tile, name) || '').join('|');
  useEffect(() => {
    const container = mount.current!;
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-label', `${latest.current.tile.surface} 타일 3D 재질 미리보기`);
    container.append(canvas);
    let disposed = false, configured = false, inViewport = true;
    let root: ReturnType<typeof createRoot> | undefined;
    const renderer = new WebGPURenderer({ canvas, antialias: true, alpha: false });
    const size = () => ({ width: container.clientWidth, height: container.clientHeight, top: 0, left: 0 });
    const active = () => inViewport && !document.hidden;
    const resize = new ResizeObserver(() => {
      if (root && configured && !disposed) void root.configure({ size: size() }).then(() => invalidateRef.current());
    });
    const visibility = new IntersectionObserver(entries => {
      inViewport = entries.some(entry => entry.isIntersecting);
      if (root && configured && !disposed) void root.configure({ frameloop: active() ? 'demand' : 'never' }).then(() => {
        if (active()) invalidateRef.current();
      });
    });
    const documentVisibility = () => {
      if (root && configured && !disposed) void root.configure({ frameloop: active() ? 'demand' : 'never' }).then(() => {
        if (active()) invalidateRef.current();
      });
    };
    resize.observe(container);
    visibility.observe(container);
    document.addEventListener('visibilitychange', documentVisibility);
    void (async () => {
      await renderer.init();
      if (disposed) { renderer.dispose(); return; }
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.NeutralToneMapping;
      const mode = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl-fallback';
      container.dataset.renderer = mode;
      setBackend(mode);
      root = createRoot(canvas);
      await root.configure({ gl: renderer, size: size(), dpr: Math.min(devicePixelRatio, 1.5), events,
        frameloop: active() ? 'demand' : 'never',
        camera: { fov: 42, position: [3.1, 2.5, 3.8] }, onCreated: state => state.events.connect?.(canvas) });
      if (!disposed) {
        configured = true;
        rootRef.current = root;
        const store = root.render(<Scene {...latest.current} onTextureError={onTextureError} />);
        invalidateRef.current = () => store.getState().invalidate();
        if (active()) invalidateRef.current();
      }
    })().catch(() => { if (!disposed) setBackend('error'); });
    return () => {
      disposed = true;
      resize.disconnect(); visibility.disconnect();
      document.removeEventListener('visibilitychange', documentVisibility);
      rootRef.current = undefined;
      invalidateRef.current = () => {};
      root?.unmount();
      setTimeout(() => renderer.dispose(), 600);
      canvas.remove();
    };
  }, [onTextureError]);
  useEffect(() => {
    setLoadError('');
    const root = rootRef.current;
    if (!root) return;
    const store = root.render(<Scene {...props} onTextureError={onTextureError} />);
    invalidateRef.current = () => store.getState().invalidate();
    invalidateRef.current();
    const canvas = mount.current?.querySelector('canvas');
    canvas?.setAttribute('aria-label', `${props.tile.surface} 타일 3D 재질 미리보기`);
  }, [onTextureError, props.autoOrbit, props.repeat, props.shape, props.tile.id, tileMapsKey]);
  const label = backend === 'webgpu' ? 'WebGPU' : backend === 'webgl-fallback' ? 'WebGL 호환 렌더러' : backend === 'error' ? '렌더러 오류' : '렌더러 준비 중';
  return <div className="tile-material-viewport" ref={mount}>
    <span className="tile-renderer-label">{label}</span>
    {loadError && <span className="tile-load-error" role="alert">{loadError}</span>}
  </div>;
}

export function TilePreview({ tile, shape = 'plane', repeat = 3, autoOrbit = false }: TilePreviewProps) {
  const gate = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = gate.current!;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '120px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <div ref={gate} className="tile-preview-gate">{visible
    ? <ActivePreview tile={tile} shape={shape} repeat={repeat} autoOrbit={autoOrbit} />
    : <span>3D 미리보기 준비 중</span>}</div>;
}

export default TilePreview;
