/**
 * WebGPU 渲染后端：编译 eye.wgsl，把颜料线性色与场景参数写入 uniform，
 * 离屏渲染到 rgba32float 纹理并读回 Float32Array（HDR，无 8 位截断）。
 */
import type { FloatImage, LightingScene, PaintScheme } from '../core/types';
import { pigmentLinear } from '../pigment/catalog';
import type { RenderBackend, RenderRequest } from './backend';
import { makeFloatImage } from '../core/image';

// 与 WGSL struct 布局严格对应（4 字节对齐，vec3 占 16 字节）
const PARAMS_FLOATS = 28;
const COLOR_VEC3 = 8;

export class GpuBackend implements RenderBackend {
  kind = 'webgpu' as const;

  private constructor(
    private device: GPUDevice,
    private pipeline: GPURenderPipeline,
    private shader: GPUShaderModule,
  ) {
    void this.shader;
  }

  static async create(): Promise<GpuBackend> {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('无可用 WebGPU 适配器');
    const device = await adapter.requestDevice();
    const shader = device.createShaderModule({ code: WGSL_SOURCE });
    // 着色器编译错误必须显式暴露，否则管线会静默产出全黑画面
    const compInfo = await shader.getCompilationInfo();
    const errs = compInfo.messages.filter((m) => m.type === 'error');
    if (errs.length > 0) {
      throw new Error(`WGSL 编译失败：${errs.map((m) => `第${m.lineNum}行 ${m.message}`).join('；')}`);
    }
    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: shader, entryPoint: 'vs' },
      fragment: {
        module: shader,
        entryPoint: 'fs',
        targets: [{ format: 'rgba32float' as GPUTextureFormat }],
      },
      primitive: { topology: 'triangle-list' },
    });
    return new GpuBackend(device, pipeline, shader);
  }

  async render(req: RenderRequest): Promise<FloatImage> {
    const { scheme, scene, size } = req;
    const pupilFraction = req.pupilFractionOverride ?? scheme.pupilFraction;
    const irisRadius = size * 0.27;
    const hlX = size / 2 + scene.lightDir[0] * irisRadius * 0.95 - irisRadius * 0.15;
    const hlY = size / 2 + scene.lightDir[1] * irisRadius * 0.95 - irisRadius * 0.25;
    const hlSigma = irisRadius * (0.16 - scheme.cornea.gloss * 0.07);

    const params = new Float32Array(PARAMS_FLOATS);
    const set = (i: number, v: number) => {
      params[i] = v;
    };
    set(0, size);
    set(1, irisRadius);
    set(2, pupilFraction);
    set(3, size / 2);
    set(4, size / 2);
    set(5, scheme.seed);
    set(6, scheme.cornea.gloss);
    set(7, scheme.wetness);
    set(8, scheme.base.opacity);
    set(9, scheme.fibers.coverage);
    set(10, scheme.fibers.opacity);
    set(11, scheme.collarette.coverage);
    set(12, scheme.collarette.opacity);
    set(13, scheme.spots.coverage);
    set(14, scheme.spots.opacity);
    set(15, scheme.scleraBase.coverage);
    set(16, scheme.vessels.coverage);
    set(17, scheme.vessels.opacity);
    set(18, hlX);
    set(19, hlY);
    set(20, hlSigma);
    set(21, scene.specularGain);
    set(22, scene.diffuseGain);

    const colorData = new Float32Array(COLOR_VEC3 * 4);
    const writeColor = (offset: number, hex: Parameters<typeof pigmentLinear>[0]) => {
      const c = pigmentLinear(hex);
      colorData[offset] = c[0];
      colorData[offset + 1] = c[1];
      colorData[offset + 2] = c[2];
    };
    writeColor(0, scheme.base.pigmentId);
    writeColor(4, scheme.fibers.pigmentId);
    writeColor(8, scheme.collarette.pigmentId);
    writeColor(12, scheme.spots.pigmentId);
    writeColor(16, scheme.scleraBase.pigmentId);
    writeColor(20, 'sclera-yellow');
    writeColor(24, scheme.vessels.pigmentId);
    colorData[28] = scene.whitePoint[0];
    colorData[29] = scene.whitePoint[1];
    colorData[30] = scene.whitePoint[2];

    const paramBuffer = this.device.createBuffer({
      size: params.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const colorBuffer = this.device.createBuffer({
      size: colorData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(paramBuffer, 0, params);
    this.device.queue.writeBuffer(colorBuffer, 0, colorData);

    const texture = this.device.createTexture({
      size: { width: size, height: size },
      format: 'rgba32float' as GPUTextureFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: paramBuffer } },
        { binding: 1, resource: { buffer: colorBuffer } },
      ],
    });

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: texture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6);
    pass.end();

    const readback = this.device.createBuffer({
      size: size * size * 16,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    encoder.copyTextureToBuffer(
      { texture },
      { buffer: readback, bytesPerRow: size * 16, rowsPerImage: size },
      { width: size, height: size },
    );
    this.device.queue.submit([encoder.finish()]);

    await readback.mapAsync(GPUMapMode.READ);
    const raw = new Float32Array(readback.getMappedRange().slice(0));
    readback.unmap();

    const out = makeFloatImage(size, size);
    for (let p = 0; p < size * size; p++) {
      out.data[p * 3] = raw[p * 4];
      out.data[p * 3 + 1] = raw[p * 4 + 1];
      out.data[p * 3 + 2] = raw[p * 4 + 2];
    }
    paramBuffer.destroy();
    colorBuffer.destroy();
    texture.destroy();
    readback.destroy();
    return out;
  }
}

// 通过 Vite 的 ?raw 内联 WGSL 源码
import shaderUrl from './shaders/eye.wgsl?raw';
const WGSL_SOURCE: string = shaderUrl;
