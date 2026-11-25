/**
 * 渲染后端适配：优先 WebGPU（GPU 并行片元着色），不可用或失败时回退 CPU 参考渲染器。
 * 两条路径都输出 scene-linear HDR Float32，绝不在着色器里压成 8 位。
 * CPU 路径（renderEye）是数值基准，WGSL 移植同一套分层数学。
 */
import type { FloatImage, LightingScene, PaintScheme } from '../core/types';
import { renderEye } from './eyeModel';

export interface RenderRequest {
  scheme: PaintScheme;
  scene: LightingScene;
  size: number;
  pupilFractionOverride?: number;
}

export interface RenderBackend {
  kind: 'webgpu' | 'cpu';
  render(req: RenderRequest): Promise<FloatImage>;
}

/** 探测 WebGPU 是否可用（无 navigator/gpu 或无适配器时返回 false） */
export async function detectWebGpu(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.gpu) return false;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

/** CPU 后端：直接调用参考渲染器，始终可用 */
class CpuBackend implements RenderBackend {
  kind = 'cpu' as const;
  async render(req: RenderRequest): Promise<FloatImage> {
    return renderEye(req.scheme, req.scene, {
      size: req.size,
      pupilFractionOverride: req.pupilFractionOverride,
    }).hdr;
  }
}

let backendPromise: Promise<RenderBackend> | null = null;

/**
 * 获取渲染后端（单例）。preferWebGpu=false 时强制 CPU；
 * WebGPU 初始化失败也安全回退，保证任何环境都能出图。
 */
export async function getRenderBackend(preferWebGpu = true): Promise<RenderBackend> {
  if (backendPromise) return backendPromise;
  backendPromise = (async () => {
    if (preferWebGpu && (await detectWebGpu())) {
      try {
        const { GpuBackend } = await import('./gpuBackend');
        return await GpuBackend.create();
      } catch (err) {
        console.warn('WebGPU 初始化失败，回退 CPU 渲染：', err);
      }
    }
    return new CpuBackend();
  })();
  return backendPromise;
}

/** 重置单例（设置页切换偏好时调用） */
export function resetRenderBackend(): void {
  backendPromise = null;
}
