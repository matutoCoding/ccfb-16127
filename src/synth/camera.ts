/**
 * 虚拟相机（合成数据专用，同时是成像比对的前向模型）。
 *
 * 已知真值响应曲线 g_true，与 Debevec 恢复算法采用同一锚定 g(128)=0，
 * 因此恢复出的辐照度与造图真值同尺度，可直接做相对误差比对。
 *
 * OECF（光电转换函数，单调）：
 *   q(u) = 0.82·u^γ + 0.18·u，u∈[0,1]，γ=0.45（高光压缩的典型相机风格）
 *   g(z) = ln( q(u_z) / q(0.5) )，u_z = z/255
 * 成像方程：
 *   u = q⁻¹( q(0.5) · E · t )，t = 2^EV，E 为 scene-linear 辐照度
 *   加读出噪声 → 量化 → 裁剪到 0..255
 */
import type { FloatImage, LdrImage } from '../core/types';
import { makeLdrImage } from '../core/image';
import type { ResponseCurve } from '../core/types';
import { finalizeCurve } from '../hdr/response';
import { mulberry32 } from '../core/rng';

const GAMMA = 0.45;
const MIX = 0.82;
/** 噪底：物理相机黑电平不为零，避免 q(0)=0 导致 ln 发散污染整条响应曲线 */
const NOISE_FLOOR = 0.002;

function q(u: number): number {
  return NOISE_FLOOR + (1 - NOISE_FLOOR) * (MIX * Math.pow(Math.max(0, u), GAMMA) + (1 - MIX) * u);
}

const Q_HALF = q(0.5);

/** q 的反函数（牛顿迭代，初值用 γ 分支） */
function qInverse(y: number): number {
  if (y <= 0) return 0;
  let u = Math.pow(Math.max(0, y) / MIX, 1 / GAMMA);
  for (let i = 0; i < 12; i++) {
    const f = q(u) - y;
    const dq = MIX * GAMMA * Math.pow(u + 1e-9, GAMMA - 1) + (1 - MIX);
    const step = f / dq;
    u -= step;
    if (u < 0) u = 0;
    if (u > 1) u = 1;
    if (Math.abs(step) < 1e-7) break;
  }
  return u;
}

/** 构造真值响应曲线（结构与恢复结果一致，测试可逐值比对） */
export function trueResponseCurve(): ResponseCurve {
  const g = new Float32Array(3 * 256);
  for (let ch = 0; ch < 3; ch++) {
    for (let z = 0; z < 256; z++) {
      g[ch * 256 + z] = Math.log(q(z / 255) / Q_HALF);
    }
  }
  return finalizeCurve(g);
}

/** 标准高斯噪声采样（Box-Muller，确定性 PRNG） */
function gaussian(rand: () => number): number {
  const u = Math.max(1e-12, rand());
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface ShootOptions {
  /** 曝光 EV（档），t = 2^EV */
  ev: number;
  seed: number;
  /** 读出噪声标准差（u 域），默认 0.6/255（现代传感器较干净的水平） */
  noiseSigma?: number;
  /** 整图平移（模拟手抖），像素 */
  shiftX?: number;
  shiftY?: number;
}

/**
 * 对线性 HDR 场景拍一张 LDR 照片。
 * @param scene 真值 scene-linear 辐照度（q(0.5) 归一尺度）
 */
export function shoot(scene: FloatImage, opts: ShootOptions): LdrImage {
  const { width: w, height: h } = scene;
  const out = makeLdrImage(w, h, opts.ev);
  const t = 2 ** opts.ev;
  const sigma = opts.noiseSigma ?? 0.6 / 255;
  const rand = mulberry32(opts.seed);
  const sx = opts.shiftX ?? 0;
  const sy = opts.shiftY ?? 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // 手抖：场景反向平移采样（边缘钳制）
      const sxPos = Math.min(w - 1, Math.max(0, x + sx));
      const syPos = Math.min(h - 1, Math.max(0, y + sy));
      const x0 = Math.floor(sxPos);
      const y0 = Math.floor(syPos);
      const fx = sxPos - x0;
      const fy = syPos - y0;
      const i00 = (y0 * w + x0) * 3;
      const i10 = (y0 * w + Math.min(w - 1, x0 + 1)) * 3;
      const i01 = (Math.min(h - 1, y0 + 1) * w + x0) * 3;
      const i11 = (Math.min(h - 1, y0 + 1) * w + Math.min(w - 1, x0 + 1)) * 3;
      const oi = (y * w + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const e =
          scene.data[i00 + ch] * (1 - fx) * (1 - fy) +
          scene.data[i10 + ch] * fx * (1 - fy) +
          scene.data[i01 + ch] * (1 - fx) * fy +
          scene.data[i11 + ch] * fx * fy;
        let u = qInverse(Q_HALF * e * t);
        u += gaussian(rand) * sigma;
        out.data[oi + ch] = Math.min(255, Math.max(0, Math.round(u * 255)));
      }
      out.data[oi + 3] = 255;
    }
  }
  return out;
}

/** 无噪声前向成像（成像比对页"过同一条响应曲线"用），支持自定义曝光与白点 */
export function renderThroughCurve(
  scene: FloatImage,
  curve: ResponseCurve,
  ev: number,
  whiteScale: [number, number, number] = [1, 1, 1],
): LdrImage {
  const { width: w, height: h } = scene;
  const out = makeLdrImage(w, h, ev);
  const logT = ev * Math.LN2;
  for (let p = 0; p < w * h; p++) {
    for (let ch = 0; ch < 3; ch++) {
      const e = scene.data[p * 3 + ch] * whiteScale[ch];
      out.data[p * 4 + ch] = applyCurveValue(curve, e, logT, ch);
    }
    out.data[p * 4 + 3] = 255;
  }
  return out;
}

import { applyResponseCurve } from '../hdr/response';
function applyCurveValue(curve: ResponseCurve, linear: number, logT: number, ch: number): number {
  return applyResponseCurve(curve, linear, logT, ch);
}
