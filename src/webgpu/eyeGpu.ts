// WebGPU 线性 HDR 义眼渲染器：
// Pass1 程序化分层眼睛 -> rgba16float HDR 纹理（全程不压 8bit）
// Pass2 WB×曝光×相机响应曲线 LUT -> 交换链（最终码值）
// 任何初始化/编译失败都返回 null，由页面回退到 CPU 参考渲染器。
import { kelvinToLinear, type RGB } from '../core/color';
import { pigmentById } from '../core/pigments';
import type { EyeGeometry, IrisScheme, ResponseCurve, SceneDef } from '../core/types';

const EYE_WGSL = /* wgsl */ `
struct U {
  res: vec4f,
  p: vec4f,
  light: vec4f,
  scene: vec4f,
  hl: vec4f,
  opt: vec4f,
  coll: vec4f,
  band: array<vec4f, 8>,
  radialColor: vec4f,
  collColor: vec4f,
  spotColor: vec4f,
};
@group(0) @binding(0) var<uniform> u: U;

fn hash2(x: f32, y: f32) -> f32 {
  return fract(sin(x * 127.1 + y * 311.7) * 43758.5453123);
}
fn vnoise(x: f32, y: f32) -> f32 {
  let ix = floor(x); let iy = floor(y);
  let fx = x - ix; let fy = y - iy;
  let sx = fx * fx * (3.0 - 2.0 * fx);
  let sy = fy * fy * (3.0 - 2.0 * fy);
  let a = hash2(ix, iy);
  let b = hash2(ix + 1.0, iy);
  let c = hash2(ix, iy + 1.0);
  let d = hash2(ix + 1.0, iy + 1.0);
  return mix(mix(a, b, sx), mix(c, d, sx), sy);
}
fn fbm(x: f32, y: f32) -> f32 {
  var v = 0.0; var amp = 0.5; var f = 1.0;
  for (var i = 0; i < 3; i++) {
    v += amp * vnoise(x * f, y * f);
    f *= 2.07; amp *= 0.5;
  }
  return v;
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pos[vi], 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let S = u.res.x;
  let cx = u.res.z;
  let cy = u.res.w;
  let irisPx = u.p.x;
  let pupilRatio = u.p.y;
  let seed = u.p.w;

  let dx = frag.x - cx;
  let dy = frag.y - cy;
  let dist = length(vec2f(dx, dy));
  let rRel = dist / irisPx;
  let theta = atan2(dy, dx);
  let nx = frag.x / S;
  let ny = frag.y / S;

  // 皮肤底
  let skinN = fbm(nx * 5.0 + seed, ny * 5.0, 3);
  var col = vec3f(0.78 + (skinN - 0.5) * 0.05, 0.55 + (skinN - 0.5) * 0.04, 0.43 + (skinN - 0.5) * 0.035);

  let eyeHW = irisPx * 1.38;
  let eyeHH = irisPx * 1.04;
  let ex = dx / eyeHW;
  var inEye = false;
  var lidT = 0.5;
  if (abs(ex) < 1.0) {
    let arc = sqrt(max(0.0, 1.0 - ex * ex));
    let top = -eyeHH * arc * 0.95 - eyeHH * 0.05;
    let bottom = eyeHH * arc * 1.08;
    if (dy > top && dy < bottom) {
      inEye = true;
      lidT = clamp((dy - top) / (bottom - top), 0.0, 1.0);
    }
  }

  if (inEye) {
    // 巩膜
    let sphere = 0.82 + 0.18 * sqrt(max(0.0, 1.0 - ex * ex * 0.7 - pow(dy / (eyeHH * 1.2), 2.0) * 0.7));
    var scl = vec3f(0.86, 0.84, 0.78) * sphere + vec3f(0.015);
    let canthus = smoothstep(0.25, 1.0, abs(ex));
    let yellow = 0.14 + 0.22 * canthus;
    scl = mix(scl, vec3f(0.78, 0.66, 0.42), clamp(yellow, 0.0, 0.5));
    col = scl;

    if (dist <= irisPx) {
      let rpPx = pupilRatio * irisPx;
      let t = clamp((dist - rpPx) / (irisPx - rpPx), 0.0, 1.0);
      let bf = t * 8.0;
      let bi = min(7, i32(floor(bf)));
      let fr = smoothstep(0.0, 1.0, fract(bf));
      let c0 = u.band[bi].rgb;
      let c1 = u.band[min(7, bi + 1)].rgb;
      var iris = mix(c0, c1, fr);

      // 放射纹
      let fibN = u.p.z;
      let af = ((theta + 3.14159265) / 6.2831853) * fibN;
      let i0 = i32(floor(af));
      let ff = fract(af);
      let sm = ff * ff * (3.0 - 2.0 * ff);
      let h0 = hash2(f32((i0 % i32(fibN) + i32(fibN)) % i32(fibN)), seed);
      let h1 = hash2(f32((i0 + 1) % i32(fibN)), seed);
      let fh = mix(h0, h1, sm);
      let brk = 0.7 + 0.55 * fbm(rRel * 6.5, f32(i0 % 97) * 0.37 + seed, 3);
      let sig = (fh - 0.5) * 2.0 * brk;
      let m = u.opt.x;
      if (sig < 0.0) {
        let a = clamp(-sig * 0.5 * m * u.opt.z, 0.0, 0.85);
        iris = mix(iris, u.radialColor.rgb, a);
      } else {
        let a = clamp(sig * 0.28 * m * u.opt.z, 0.0, 0.5);
        iris = mix(iris, min(vec3f(1.0), iris * 1.4 + 0.1), a);
      }

      // 卷缩轮
      let wave = fbm(cos(theta) * 2.2 + 4.0, sin(theta) * 2.2 + 4.0, u.coll.w * 100.0) - 0.5;
      let rc = u.coll.x + wave * u.coll.y * 0.16;
      let dd = rRel - rc;
      let cw = max(0.012, u.coll.y);
      let ridge = exp(-pow(dd - cw * 0.9, 2.0) / (2.0 * pow(cw * 0.55, 2.0)));
      let groove = exp(-pow(dd + cw * 0.25, 2.0) / (2.0 * pow(cw * 0.5, 2.0)));
      let ca = clamp((ridge * 0.55 + groove * 0.5) * u.coll.z, 0.0, 0.8);
      iris = mix(iris, u.collColor.rgb, ca * 0.75);
      iris *= 1.0 - 0.28 * u.opt.y * groove * u.coll.z;

      // 色素斑（程序化暗斑）
      let spotN = fbm(cos(theta) * 6.0 + rRel * 3.0, sin(theta) * 6.0 + rRel * 5.0, seed + 31.0);
      let spotMask = smoothstep(0.62, 0.82, spotN) * u.coll.w;
      iris = mix(iris, u.spotColor.rgb, clamp(spotMask * 0.5, 0.0, 0.6) * u.coll.w);

      // 瞳孔
      if (dist < rpPx) {
        let pupN = fbm(nx * 22.0, ny * 22.0, 31.0);
        iris = vec3f(0.012 + pupN * 0.012 * (dist / rpPx));
      } else {
        let pupAo = exp(-pow(rRel - pupilRatio, 2.0) / (2.0 * 0.012 * 0.012));
        iris *= 1.0 - 0.4 * u.opt.y * pupAo;
      }

      // 缘环 + 体积
      let lim = smoothstep(0.8, 1.0, rRel);
      iris *= 1.0 - lim * 0.4;
      iris *= 0.9 + 0.1 * smoothstep(1.0, 0.25, rRel);

      col = iris * u.light.rgb * u.light.a;
    }

    // Fresnel
    let rn = clamp(dist / (irisPx * 1.02), 0.0, 1.0);
    let fres = pow(1.0 - sqrt(max(0.0, 1.0 - rn * rn)), 3.0) * u.hl.w;
    col += vec3f(fres * 0.35 * u.light.a);

    // 锐利角膜高光
    let hdx = frag.x - u.hl.x;
    let hdy = frag.y - u.hl.y;
    let sharp = exp(-(hdx * hdx + hdy * hdy) / (2.0 * u.hl.z * u.hl.z));
    let add = sharp * u.hl.a + u.scene.z * 6.0 * u.light.a;
    col += vec3f(add);

    // 巩膜湿润光泽
    if (dist > irisPx * 1.02) {
      let wx = dx - u.scene.x * eyeHW * 0.2;
      let wy = dy - u.scene.y * eyeHH * 0.4 - eyeHH * 0.15;
      let sheen = exp(-(wx * wx) / (2.0 * pow(eyeHW * 0.5, 2.0)) - (wy * wy) / (2.0 * pow(eyeHH * 0.32, 2.0)));
      col += vec3f(sheen * u.scene.w * 0.5 * u.light.a * (1.0 + u.scene.z * 1.5));
    }
  }

  let finalCol = max(col, vec3f(0.0));
  let inBand = dist >= pupilRatio * irisPx && dist <= irisPx;
  if (!inBand) { finalCol *= u.res.y; }
  return vec4f(finalCol, 1.0);
}
`;

function pigmentLinear(id: string): RGB {
  try { return pigmentById(id).lin; } catch { return [0.1, 0.05, 0.03]; }
}const POST_WGSL = /* wgsl */ `
struct H {
  wbGain: vec4f,
  ev: vec4f,
};
@group(0) @binding(0) var<uniform> h: H;
@group(0) @binding(1) var<storage, read> lut: array<f32>;
@group(0) @binding(2) var hdrTex: texture_2d<f32>;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pos[vi], 0.0, 1.0);
}

fn lutG(z: i32) -> f32 {
  return lut[clamp(z, 0, 255)];
}

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let tc = vec2i(frag.xy);
  let lin = textureLoad(hdrTex, tc, 0).rgb;
  let mul = h.wbGain.a * exp2(h.ev.x);
  var x = max(lin * h.wbGain.rgb * mul, vec3f(1e-8));
  // 逐通道反演响应曲线 g(Z)=lnX（二分 8 次）
  var outCode = vec3f(0.0);
  for (var c = 0; c < 3; c++) {
    let lnX = log(x[c]);
    var lo = 0;
    var hi = 255;
    for (var k = 0; k < 8; k++) {
      let mid = (lo + hi) / 2;
      if (lutG(mid) <= lnX) { lo = mid; } else { hi = mid; }
    }
    let g0 = lutG(lo);
    let g1 = lutG(min(255, lo + 1));
    let t = clamp((lnX - g0) / max(1e-6, g1 - g0), 0.0, 1.0);
    outCode[c] = (f32(lo) + t) / 255.0;
  }
  return vec4f(outCode, 1.0);
}
`;

export class EyeGpuRenderer {
  private device!: GPUDevice;
  private context!: GPUCanvasContext;
  private format!: GPUTextureFormat;
  private eyePipeline!: GPURenderPipeline;
  private postPipeline!: GPURenderPipeline;
  private hdrTexture!: GPUTexture;
  private eyeBindGroup!: GPUBindGroup;
  private postBindGroup!: GPUBindGroup;
  private lutBuffer!: GPUBuffer;
  private uniformBuffer!: GPUBuffer;
  private headerBuffer!: GPUBuffer;
  readonly size!: number;

  private constructor(init: {
    device: GPUDevice; context: GPUCanvasContext; format: GPUTextureFormat; size: number;
    eyePipeline: GPURenderPipeline; postPipeline: GPURenderPipeline; hdrTexture: GPUTexture;
    eyeBindGroup: GPUBindGroup; postBindGroup: GPUBindGroup;
    lutBuffer: GPUBuffer; uniformBuffer: GPUBuffer; headerBuffer: GPUBuffer;
  }) {
    Object.assign(this, init);
  }

  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && 'gpu' in navigator;
  }

  static async create(canvas: HTMLCanvasElement, size = 420): Promise<EyeGpuRenderer | null> {
    try {
      if (!EyeGpuRenderer.isSupported()) return null;
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) return null;
      const device = await adapter.requestDevice();
      const context = canvas.getContext('webgpu') as GPUCanvasContext | null;
      if (!context) return null;
      const format = navigator.gpu.getPreferredCanvasFormat();
      canvas.width = size; canvas.height = size;
      context.configure({ device, format, alphaMode: 'opaque' });

      const eyeModule = device.createShaderModule({ code: EYE_WGSL });
      const postModule = device.createShaderModule({ code: POST_WGSL });
      const eyePipeline = await device.createRenderPipelineAsync({
        layout: 'auto',
        vertex: { module: eyeModule, entryPoint: 'vs' },
        fragment: { module: eyeModule, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
        primitive: { topology: 'triangle-list' },
      });
      const postPipeline = await device.createRenderPipelineAsync({
        layout: 'auto',
        vertex: { module: postModule, entryPoint: 'vs' },
        fragment: { module: postModule, entryPoint: 'fs', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      });

      const hdrTexture = device.createTexture({
        size: [size, size], format: 'rgba16float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      const uniformBuffer = device.createBuffer({ size: 18 * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const lutBuffer = device.createBuffer({ size: 256 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      const headerBuffer = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

      const eyeBindGroup = device.createBindGroup({
        layout: eyePipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
      });
      const postBindGroup = device.createBindGroup({
        layout: postPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: headerBuffer } },
          { binding: 1, resource: { buffer: lutBuffer } },
          { binding: 2, resource: hdrTexture.createView() },
        ],
      });

      return new EyeGpuRenderer({
        device, context, format, size, eyePipeline, postPipeline, hdrTexture,
        eyeBindGroup, postBindGroup, lutBuffer, uniformBuffer, headerBuffer,
      });
    } catch (err) {
      console.warn('[WebGPU] 初始化失败，回退 CPU 渲染：', err);
      return null;
    }
  }

  render(
    scheme: IrisScheme,
    opts: { scene: SceneDef; curve: ResponseCurve; gain: number; wb: RGB; evOffset?: number; geom?: EyeGeometry },
  ) {
    const S = this.size;
    const g = opts.geom ?? { cx: 0.5, cy: 0.515, irisR: 0.335, pupilR: 0.1 };
    const cx = g.cx * S, cy = g.cy * S, irisPx = g.irisR * S;
    let pupilRatio = g.pupilR / g.irisR;
    if (scheme.pupilDiameterMm != null) pupilRatio = Math.min(0.6, Math.max(0.18, scheme.pupilDiameterMm / 12));
    const light = kelvinToLinear(opts.scene.kelvin);

    const u = new Float32Array(18 * 4);
    const set4 = (i: number, a: number, b: number, c: number, d: number) => { u[i * 4] = a; u[i * 4 + 1] = b; u[i * 4 + 2] = c; u[i * 4 + 3] = d; };
    set4(0, S, scheme.hdrScale ?? 1, cx, cy);
    set4(1, irisPx, pupilRatio, scheme.radial.count, scheme.radial.seed % 1000);
    set4(2, light[0], light[1], light[2], opts.scene.intensity);
    set4(3, opts.scene.lightDir[0], opts.scene.lightDir[1], opts.scene.flash, scheme.sclera.wetness);
    const hlx = cx + (scheme.cornea.highlightX - 0.5) * 2 * irisPx;
    const hly = cy + (scheme.cornea.highlightY - 0.5) * 2 * irisPx;
    set4(4, hlx, hly, irisPx * (0.16 - 0.11 * scheme.cornea.gloss), scheme.cornea.highlightHdr * (0.5 + 1.1 * scheme.cornea.gloss) * (1 + opts.scene.flash * 2.4));
    set4(5, scheme.radial.coverage * scheme.radial.opacity, scheme.depth, scheme.radial.opacity, scheme.radial.contrast);
    set4(6, scheme.collarette.radius, scheme.collarette.irregularity, scheme.collarette.coverage * scheme.collarette.opacity, scheme.spots.enabled ? 1 : 0);
    for (let b = 0; b < 8; b++) {
      const c = scheme.bandRGB[b] ?? [0.1, 0.05, 0.03];
      set4(7 + b, c[0], c[1], c[2], 1);
    }
    // 颜料色由 CPU 侧目录给出
    const rad = pigmentLinear(scheme.radial.pigment);
    const col = pigmentLinear(scheme.collarette.pigment);
    const spot = pigmentLinear(scheme.spots.pigment);
    set4(15, rad[0], rad[1], rad[2], 1);
    set4(16, col[0], col[1], col[2], 1);
    set4(17, spot[0], spot[1], spot[2], 1);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, u);
    this.device.queue.writeBuffer(this.lutBuffer, 0, new Float32Array(opts.curve.g));

    const h = new Float32Array(8);
    h[0] = opts.wb[0]; h[1] = opts.wb[1]; h[2] = opts.wb[2]; h[3] = opts.gain;
    h[4] = opts.evOffset ?? 0;
    this.device.queue.writeBuffer(this.headerBuffer, 0, h);

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.hdrTexture.createView(),
        loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    pass.setPipeline(this.eyePipeline);
    pass.setBindGroup(0, this.eyeBindGroup);
    pass.draw(3);
    pass.end();

    const post = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    post.setPipeline(this.postPipeline);
    post.setBindGroup(0, this.postBindGroup);
    post.draw(3);
    post.end();
    this.device.queue.submit([encoder.finish()]);
  }
}

