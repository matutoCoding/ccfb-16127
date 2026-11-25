// 成像链路：线性 HDR → 场景 WB → 曝光 → 相机响应曲线 → 8bit 照片码值。
// 比对双方（健侧反演 / 义眼渲染）走完全相同的一条链。
import { clamp, whiteBalanceGainsFromKelvin, type RGB } from './color';
import { makeEncoder } from './camera';
import type { LdrImage, ResponseCurve, RgbImage, SceneDef } from './types';

// 相机自动 WB 是“部分色适应”：strength=1 完全中和光源，0 完全不校正。
export function sceneWbGains(scene: SceneDef, strength = 0.72): RGB {
  const full = whiteBalanceGainsFromKelvin(scene.kelvin);
  return [Math.pow(full[0], strength), Math.pow(full[1], strength), Math.pow(full[2], strength)];
}

export interface EncodeOptions {
  curve: ResponseCurve;
  wb: RGB;
  gain: number; // 全局曝光/尺度标量
  evOffset?: number;
  quantize?: boolean;
  noiseSigma?: number;
  rng?: { gaussian: (m?: number, s?: number) => number };
}

export function encodeRadiance(img: RgbImage, opts: EncodeOptions): LdrImage {
  const { width, height, data } = img;
  const out: LdrImage = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  const encoder = makeEncoder(opts.curve);
  const mul = opts.gain * Math.pow(2, opts.evOffset ?? 0);
  const q = opts.quantize !== false;
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    for (let c = 0; c < 3; c++) {
      let x = Math.max(1e-8, data[i * 3 + c] * opts.wb[c] * mul);
      let code = encoder(Math.log(x));
      if (opts.noiseSigma && opts.rng) code += opts.rng.gaussian(0, opts.noiseSigma);
      code = clamp(code, 0, 255);
      out.data[o + c] = q ? Math.round(code) : code;
    }
    out.data[o + 3] = 255;
  }
  return out;
}

// 码值经同一条响应曲线反演回曝光空间线性 RGB，再进 Lab。
export function decodeCodeLinear(code: number, curve: ResponseCurve): RGB {
  const z = clamp(Math.round(code), 0, 255);
  const lx = curve.g[z];
  const x = Math.exp(clamp(lx, -20, 20));
  return [x, x, x]; // 单通道调用方自行替换
}
export function decodeCodesRGB(codes: RGB, curve: ResponseCurve): RGB {
  return codes.map((code) => {
    const z = clamp(Math.round(code), 0, 255);
    return Math.exp(clamp(curve.g[z], -20, 20));
  }) as RGB;
}
