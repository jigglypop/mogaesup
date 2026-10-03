import { createLegacyRenderer, createRenderer, isWebGPUAvailable } from 'gaesup-world';
import { WebGPURenderer } from 'three/webgpu';

type RendererProps = Parameters<typeof createRenderer>[0];
type CanvasRenderer = Awaited<ReturnType<typeof createRenderer>>;

/**
 * The island's renderer: WebGPU where the browser has an adapter, else the same node renderer on WebGL2. The engine's
 * own fallback is a classic WebGLRenderer, which draws its node materials (grass, water, ground cover) through older
 * GLSL paths in other colours, so a visitor without WebGPU saw another island. The classic renderer stays the last
 * resort for browsers without WebGL2.
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
  // React Three Fiber calls forceContextLoss() when the canvas goes; the node renderer only has dispose().
  let disposed = false;
  const dispose = renderer.dispose.bind(renderer);
  const once = () => {
    if (disposed) return;
    disposed = true;
    dispose();
  };
  Object.defineProperties(renderer, {
    dispose: { configurable: true, writable: true, value: once },
    forceContextLoss: { configurable: true, writable: true, value: once },
  });
  return renderer as unknown as CanvasRenderer;
}
