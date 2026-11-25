// 相机响应曲线：合成时使用一条已知的 log-logistic 响应作为“真值”，
// 验收时只用 Debevec 反演出的曲线做正向编码，证明链路不依赖真值。
import { clamp } from './color';
import type { ResponseCurve } from './types';

// 真值响应：z = 255 / (1 + exp(-(ln X - u0)/s))
export function trueResponseCode(lnX: number, u0 = 0.35, s = 0.52): number {
  return 255 / (1 + Math.exp(-(lnX - u0) / s));
}
export function trueResponseLogX(z: number, u0 = 0.35, s = 0.52): number {
  const zz = clamp(z, 0.027, 254.973) / 255;
  return u0 + s * Math.log(zz / (1 - zz));
}

// 由反演曲线构造正向编码器：lnX -> 0..255 code（浮点，未量化）
export function makeEncoder(curve: ResponseCurve): (lnX: number) => number {
  const g = curve.g;
  // g[z] 单调递增；建立分段线性反查
  return (lnX: number) => {
    if (lnX <= g[0]) return 0;
    if (lnX >= g[255]) return 255;
    // 二分
    let lo = 0, hi = 255;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (g[mid] <= lnX) lo = mid;
      else hi = mid;
    }
    const g0 = g[lo], g1 = g[lo + 1];
    const t = (lnX - g0) / (g1 - g0 || 1e-9);
    return clamp(lo + t, 0, 255);
  };
}

// 量化到 8bit（可加确定性噪声）
export function quantizeCode(code: number, noiseSigma = 0, rng?: { gaussian: (m?: number, s?: number) => number }): number {
  let v = code;
  if (noiseSigma > 0 && rng) v += rng.gaussian(0, noiseSigma);
  return Math.round(clamp(v, 0, 255));
}

// 把一条恢复出的 g 强制单调，消除最小二乘噪声造成的非单调点
export function enforceMonotonic(g: number[]): number[] {
  const out = g.slice();
  for (let i = 1; i < out.length; i++) {
    if (out[i] < out[i - 1] + 1e-4) out[i] = out[i - 1] + 1e-4;
  }
  for (let i = out.length - 2; i >= 0; i--) {
    if (out[i] > out[i + 1] - 1e-4) out[i] = out[i + 1] - 1e-4;
  }
  return out;
}
