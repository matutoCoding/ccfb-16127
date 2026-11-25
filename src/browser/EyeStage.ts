// 虹膜绘制页主舞台：优先 WebGPU rgba16float HDR 渲染，失败/关闭时回退 CPU 同链路。
import { EyeGpuRenderer } from '../webgpu/eyeGpu';
import { renderEyeLinear } from '../core/eyeRenderer';
import { encodeRadiance } from '../core/pipeline';
import { sceneById } from '../core/scenes';
import type { RGB } from '../core/color';
import type { EyeGeometry, IrisScheme, ResponseCurve } from '../core/types';
import { h } from '../ui/dom';

export interface StageOptions {
  size?: number;
  geom: EyeGeometry;
  curve: ResponseCurve;
  gain: number;
  wb: RGB;
  irisDiameterMm: number;
  prefer: 'auto' | 'webgpu' | 'cpu';
}

export class EyeStage {
  el: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private gpu: EyeGpuRenderer | null = null;
  private backend: 'webgpu' | 'cpu' | 'initializing' = 'initializing';
  private opts: StageOptions;
  private badge: HTMLSpanElement;

  private constructor(opts: StageOptions) {
    this.opts = opts;
    this.el = h('div', { style: 'position:relative;width:100%;max-width:520px' });
    this.canvas = h('canvas', { width: opts.size ?? 420, height: opts.size ?? 420, style: 'width:100%;border-radius:50%;display:block' }) as HTMLCanvasElement;
    this.badge = h('span', { class: 'pill' }, '初始化渲染器…');
    const tag = h('div', { class: 'overlay-badges' }, this.badge);
    this.el.append(this.canvas, tag);
  }

  static async mount(container: HTMLElement, opts: StageOptions): Promise<EyeStage> {
    const stage = new EyeStage(opts);
    container.appendChild(stage.el);
    const wantGpu = opts.prefer !== 'cpu' && EyeGpuRenderer.isSupported();
    if (wantGpu && opts.prefer !== 'cpu') {
      stage.gpu = await EyeGpuRenderer.create(stage.canvas, opts.size ?? 420);
    }
    stage.backend = stage.gpu ? 'webgpu' : 'cpu';
    stage.badge.textContent = stage.gpu ? 'WebGPU · rgba16float HDR' : 'CPU 线性 HDR 参考渲染';
    stage.badge.className = `pill ${stage.gpu ? 'good' : ''}`;
    return stage;
  }

  get backendName() { return this.backend; }

  update(scheme: IrisScheme) {
    const o = this.opts;
    const gain = scheme.fitGain ?? o.gain;
    const scene = sceneById('clinic');
    if (this.gpu) {
      this.gpu.render(scheme, { scene, curve: o.curve, gain, wb: o.wb, geom: o.geom });
      return;
    }
    const size = o.size ?? 420;
    const lin = renderEyeLinear(scheme, o.geom, { size, scene, irisDiameterMm: o.irisDiameterMm });
    const ldr = encodeRadiance(lin, { curve: o.curve, wb: o.wb, gain });
    const ctx = this.canvas.getContext('2d')!;
    this.canvas.width = size; this.canvas.height = size;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(ldr.data), size, size), 0, 0);
  }
}
