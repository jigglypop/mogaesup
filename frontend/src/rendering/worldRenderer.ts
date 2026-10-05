import { createLegacyRenderer, createRenderer, isWebGPUAvailable, RENDERER_LOST_EVENT } from 'gaesup-world';
import { WebGPURenderer } from 'three/webgpu';

type RendererProps = Parameters<typeof createRenderer>[0];
type CanvasRenderer = Awaited<ReturnType<typeof createRenderer>>;

/**
 * Tells the canvases a renderer lost its device, as the engine's own renderer does: `useRendererRecovery` hears it and
 * remounts its canvas with a fresh renderer.
 */
export function announceRendererLost(info: unknown): void {
  console.warn('WebGL2 context lost', info);
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(RENDERER_LOST_EVENT, { detail: info }));
}

/**
 * The island's renderer: WebGPU where the browser has an adapter, else the same node renderer on WebGL2. The engine's
 * own fallback is a classic WebGLRenderer, which draws its node materials (grass, water, ground cover) through older
 * GLSL paths in other colours, so a visitor without WebGPU saw another island. Where the node renderer will not start
 * on WebGL2 either, the classic renderer is used after all. A lost context is announced like the engine's lost device,
 * so the canvas comes back.
 */
export async function createWorldRenderer(props: RendererProps): Promise<CanvasRenderer> {
  if (await isWebGPUAvailable()) return createRenderer(props);
  const { canvas, alpha, antialias, powerPreference, preserveDrawingBuffer, depth, stencil, logarithmicDepthBuffer } =
    props as RendererProps & Record<string, unknown>;
  const renderer = new WebGPURenderer({
    canvas: canvas as HTMLCanvasElement,
    alpha: alpha as boolean | undefined,
    antialias: (antialias as boolean | undefined) ?? true,
    powerPreference: powerPreference as GPUPowerPreference | undefined,
    depth: depth as boolean | undefined,
    stencil: stencil as boolean | undefined,
    logarithmicDepthBuffer: logarithmicDepthBuffer as boolean | undefined,
    forceWebGL: true,
  });
  void preserveDrawingBuffer;
  try {
    await renderer.init();
  } catch {
    renderer.dispose();
    return createLegacyRenderer(props);
  }
  // The WebGL2 backend calls this from the canvas's `webglcontextlost`.
  renderer.onDeviceLost = announceRendererLost;
  // React Three Fiber calls forceContextLoss() when the canvas goes; the node renderer only has dispose(). Disposing
  // loses the context on purpose, which is no loss to announce.
  let disposed = false;
  const dispose = renderer.dispose.bind(renderer);
  const once = () => {
    if (disposed) return;
    disposed = true;
    renderer.onDeviceLost = () => {};
    dispose();
  };
  Object.defineProperties(renderer, {
    dispose: { configurable: true, writable: true, value: once },
    forceContextLoss: { configurable: true, writable: true, value: once },
  });
  return renderer as unknown as CanvasRenderer;
}
