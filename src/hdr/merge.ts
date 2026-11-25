/**
 * HDR 辐照合并（Debevec 加权对数平均）。
 *
 * ln E_i = Σ w(Z_ij)·(g(Z_ij) - ln t_j) / Σ w(Z_ij)
 *
 * - 权重沿用响应曲线恢复的三角权重，z=0/255 自动为 0，死黑/过曝样本不参与；
 * - 高光掩膜内像素在所有帧权重清零，亮斑绝不污染虹膜辐照；
 * - 某像素被全部剔除时回退到最暗帧的未饱和值并标注，由上层给警告；
 * - 输出为线性 scene-linear Float32，全流程不做 8 位截断。
 */
import type { FloatImage, LdrImage, MaskImage, ResponseCurve } from '../core/types';
import { makeFloatImage } from '../core/image';
import { debevecWeight } from './response';

export interface MergeResult {
  hdr: FloatImage;
  /** 无任何有效样本、使用回退值的像素数 */
  fallbackPixels: number;
}

export function mergeRadiance(
  images: LdrImage[],
  alignedLinear: Float32Array[],
  curve: ResponseCurve,
  specularMask: MaskImage,
): MergeResult {
  const w = images[0].width;
  const h = images[0].height;
  const n = w * h;
  const hdr = makeFloatImage(w, h);
  const logT = images.map((im) => im.exposure * Math.LN2);
  let fallbackPixels = 0;

  // 最暗帧索引（回退用）
  let darkest = 0;
  for (let j = 1; j < images.length; j++) {
    if (images[j].exposure < images[darkest].exposure) darkest = j;
  }

  for (let p = 0; p < n; p++) {
    const isSpecular = specularMask.data[p] === 1;
    for (let ch = 0; ch < 3; ch++) {
      let num = 0;
      let den = 0;
      for (let j = 0; j < images.length; j++) {
        const z = images[j].data[p * 4 + ch];
        let weight = debevecWeight(z);
        if (isSpecular) weight = 0;
        if (weight <= 0) continue;
        num += weight * (curve.g[ch * 256 + z] - logT[j]);
        den += weight;
      }
      const i = p * 3 + ch;
      if (den > 0) {
        hdr.data[i] = Math.exp(num / den);
      } else {
        // 回退：用最暗帧线性值反推（至少不会是饱和值），并标记
        const linVal = alignedLinear[darkest][i];
        hdr.data[i] = linVal / Math.max(2 ** images[darkest].exposure, 1e-9);
        if (ch === 0) fallbackPixels++;
      }
    }
  }

  return { hdr, fallbackPixels };
}
