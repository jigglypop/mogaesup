import { useEffect, useMemo, useRef } from 'react';

import { useFrame, useThree } from '@react-three/fiber';
import {
  Color,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  OrthographicCamera,
  Plane,
  PlaneGeometry,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector3,
  WebGLRenderTarget,
  type Mesh,
  type Texture,
} from 'three';

import { rippleTexture, WATER_LEVEL, type Mood } from './mood';
import { useStill } from './parts';

// The lake the islands stand in. It is drawn as still water is seen: the scene mirrored in it (drawn a second time,
// from below, into a picture of its own), smeared and broken by ripples, over the sky's own colour where nothing
// stands, and a little see-through so a shore shows going under.

const SURFACE = new PlaneGeometry(1200, 1200);
/** Only what stands above the water is mirrored in it. */
const ABOVE_WATER = [new Plane(new Vector3(0, 1, 0), -WATER_LEVEL)];
/** Drawn before the frame itself (the composer draws at 1) and after everything has moved. */
const MIRROR_PRIORITY = 0.5;

const VERTEX = /* glsl */ `
  uniform mat4 uMirror;
  varying vec4 vMirror;
  varying vec3 vWorld;
  #include <common>
  #include <fog_pars_vertex>
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vMirror = uMirror * world;
    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const FRAGMENT = /* glsl */ `
  uniform sampler2D tMirror;
  uniform sampler2D tRipple;
  uniform sampler2D tSky;
  uniform float uTime;
  uniform float uBend;
  uniform float uSmear;
  uniform vec3 uDeep;
  uniform vec3 uToCamera;
  varying vec4 vMirror;
  varying vec3 vWorld;
  #include <common>
  #include <fog_pars_fragment>

  vec2 skyUv(vec3 direction) {
    return vec2(atan(direction.z, direction.x) * RECIPROCAL_PI2 + 0.5, asin(clamp(direction.y, -1.0, 1.0)) * RECIPROCAL_PI + 0.5);
  }

  void main() {
    vec2 place = vWorld.xz;
    // Three sizes of ripple drifting three ways.
    vec2 broad = texture2D(tRipple, place * 0.045 + uTime * vec2(0.006, 0.004)).xy - 0.5;
    vec2 mid = texture2D(tRipple, place * 0.13 + uTime * vec2(-0.011, 0.008)).xy - 0.5;
    vec2 fine = texture2D(tRipple, place * 0.37 + uTime * vec2(0.009, -0.017)).xy - 0.5;
    vec2 lean = broad * 0.55 + mid * 0.4 + fine * 0.22;
    vec3 normal = normalize(vec3(-lean.x, 1.0, -lean.y));

    // The sky where the water looks, with clouds passing; still water at dusk gives it back darker than it is.
    vec3 away = reflect(-uToCamera, normal);
    away.y = abs(away.y);
    vec3 sky = texture2D(tSky, skyUv(away)).rgb;
    float cloud = texture2D(tRipple, place * 0.011 + uTime * vec2(0.0016, 0.0009)).z;
    sky *= mix(0.42, 0.86, smoothstep(0.34, 0.72, cloud));

    // What stands over the water, mirrored: bent by the ripples and drawn out toward the viewer.
    vec2 at = vMirror.xy / vMirror.w + lean * uBend;
    vec4 mirrored = texture2D(tMirror, at, 0.6) * 0.4
      + texture2D(tMirror, at + vec2(0.0, uSmear), 1.4) * 0.25
      + texture2D(tMirror, at - vec2(0.0, uSmear), 1.4) * 0.15
      + texture2D(tMirror, at + vec2(0.0, uSmear * 2.4), 2.2) * 0.2;
    vec3 seen = mix(sky, mirrored.rgb, clamp(mirrored.a, 0.0, 1.0) * 0.9);

    float facing = clamp(dot(normal, uToCamera), 0.0, 1.0);
    float shine = mix(0.7, 1.0, pow(1.0 - facing, 3.0));
    vec3 color = mix(uDeep, seen, shine);

    gl_FragColor = vec4(color, 0.9);
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

/**
 * The lake, about the place the camera looks at. `sky` is the sky as one picture (see mood); `scale` is how large the
 * mirrored picture is drawn against the canvas (smaller is cheaper and softer), and it is drawn afresh `every` so
 * many frames.
 */
export function Lake({ mood, sky, scale = 0.5, every = 2 }: { mood: Mood; sky: Texture; scale?: number; every?: number }) {
  const lake = useRef<Mesh>(null);
  const size = useThree((state) => state.size);
  const dpr = useThree((state) => state.viewport.dpr);
  const still = useStill();
  const drawn = useRef(0);
  const made = useMemo(() => {
    const target = new WebGLRenderTarget(4, 4, { type: HalfFloatType, generateMipmaps: true, minFilter: LinearMipmapLinearFilter, magFilter: LinearFilter, samples: 2 });
    const material = new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      fog: true,
      uniforms: UniformsUtils.merge([
        UniformsLib.fog,
        {
          tMirror: { value: null },
          tRipple: { value: null },
          tSky: { value: null },
          uMirror: { value: new Matrix4() },
          uTime: { value: 0 },
          uBend: { value: 0.02 },
          uSmear: { value: 0.01 },
          uDeep: { value: new Color() },
          uToCamera: { value: new Vector3(0, 1, 0) },
        },
      ]),
    });
    material.uniforms['tMirror']!.value = target.texture;
    material.uniforms['tRipple']!.value = rippleTexture();
    return { target, material, mirror: new OrthographicCamera(), eye: new Vector3(), ahead: new Vector3(), clear: new Color() };
  }, []);
  useEffect(
    () => () => {
      made.target.dispose();
      made.material.dispose();
    },
    [made],
  );
  useEffect(() => {
    const uniforms = made.material.uniforms;
    uniforms['tSky']!.value = sky;
    (uniforms['uDeep']!.value as Color).set(mood.deep);
  }, [made, mood, sky]);
  useEffect(() => {
    made.target.setSize(Math.max(4, Math.round(size.width * dpr * scale)), Math.max(4, Math.round(size.height * dpr * scale)));
  }, [made, size, dpr, scale]);

  useFrame(({ gl, scene, camera, clock }) => {
    const mesh = lake.current;
    if (!mesh) return;
    const view = camera as OrthographicCamera;
    const { mirror, eye, ahead, material, target, clear } = made;
    const uniforms = material.uniforms;
    // The lake lies wherever the camera looks.
    view.getWorldDirection(ahead);
    view.getWorldPosition(eye);
    const reach = (eye.y - WATER_LEVEL) / -ahead.y;
    mesh.position.set(eye.x + ahead.x * reach, WATER_LEVEL, eye.z + ahead.z * reach);
    (uniforms['uToCamera']!.value as Vector3).copy(ahead).negate();
    uniforms['uTime']!.value = still ? 0 : clock.elapsedTime;
    // A ripple bends what it mirrors by the same stretch of water whatever the zoom.
    uniforms['uBend']!.value = (0.55 * view.zoom) / size.height;
    uniforms['uSmear']!.value = (0.38 * view.zoom) / size.height;

    // What stands still is mirrored the same from one frame to the next: the mirror is drawn afresh only now and then.
    drawn.current += 1;
    if (drawn.current > 2 && drawn.current % every !== 0) return;

    // The camera as the water mirrors it: below the surface, looking up at the same things.
    mirror.position.set(eye.x, 2 * WATER_LEVEL - eye.y, eye.z);
    mirror.up.set(0, 1, 0).applyQuaternion(view.quaternion);
    mirror.up.y = -mirror.up.y;
    mirror.lookAt(mirror.position.x + ahead.x, mirror.position.y - ahead.y, mirror.position.z + ahead.z);
    mirror.near = view.near;
    mirror.far = view.far;
    mirror.updateMatrixWorld();
    mirror.projectionMatrix.copy(view.projectionMatrix);
    mirror.projectionMatrixInverse.copy(view.projectionMatrixInverse);
    (uniforms['uMirror']!.value as Matrix4).set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1).multiply(mirror.projectionMatrix).multiply(mirror.matrixWorldInverse);

    const before = { target: gl.getRenderTarget(), shadows: gl.shadowMap.autoUpdate, planes: gl.clippingPlanes, alpha: gl.getClearAlpha() };
    gl.getClearColor(clear);
    mesh.visible = false;
    // The shadows the frame before left are near enough for the mirror; the very first picture has to cast its own.
    gl.shadowMap.autoUpdate = false;
    if (drawn.current === 1) gl.shadowMap.needsUpdate = true;
    gl.clippingPlanes = ABOVE_WATER;
    gl.setRenderTarget(target);
    gl.setClearColor(0x000000, 0);
    gl.clear();
    gl.render(scene, mirror);
    gl.setRenderTarget(before.target);
    gl.setClearColor(clear, before.alpha);
    gl.clippingPlanes = before.planes;
    gl.shadowMap.autoUpdate = before.shadows;
    mesh.visible = true;
  }, MIRROR_PRIORITY);

  return <mesh ref={lake} geometry={SURFACE} material={made.material} rotation={[-Math.PI / 2, 0, 0]} renderOrder={-1} />;
}
