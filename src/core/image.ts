/**
 * 浮点 / 8 位图像工具。
 */
import type { FloatImage, LdrImage, MaskImage } from './types';
import { srgb8ToLinear, linearToSrgb } from './color';

export function makeFloatImage(width: number, height: number): FloatImage {
  return { width, height, data: new Float32Array(width * height * 3) };
}

export function makeLdrImage(width: number, height: number, exposure = 0): LdrImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4), exposure };
}

export function makeMask(width: number, height: number): MaskImage {
  return { width, height, data: new Uint8Array(width * height) };
}

export function cloneFloatImage(img: FloatImage): FloatImage {
  return { width: img.width, height: img.height, data: new Float32Array(img.data) };
}

/** LDR(sRGB 字节) → 线性浮点（不含曝光反推，仅解码） */
export function ldrToLinear(img: LdrImage): FloatImage {
  const out = makeFloatImage(img.width, img.height);
  const n = img.width * img.height;
  for (let i = 0; i < n; i++) {
    out.data[i * 3] = srgb8ToLinear(img.data[i * 4]);
    out.data[i * 3 + 1] = srgb8ToLinear(img.data[i * 4 + 1]);
    out.data[i * 3 + 2] = srgb8ToLinear(img.data[i * 4 + 2]);
  }
  return out;
}

/** 线性浮点 → LDR(sRGB 字节)，仅用于展示，绝不回灌 HDR 管线 */
export function linearToLdr(img: FloatImage): LdrImage {
  const out = makeLdrImage(img.width, img.height);
  const n = img.width * img.height;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const v = linearToSrgb(img.data[i * 3 + c]);
      out.data[i * 4 + c] = Math.min(255, Math.max(0, Math.round(v * 255)));
    }
    out.data[i * 4 + 3] = 255;
  }
  return out;
}

/** 双线性采样浮点图（坐标越界取边缘） */
export function sampleBilinear(img: FloatImage, x: number, y: number): [number, number, number] {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const w = img.width;
  const h = img.height;
  const cx0 = Math.min(w - 1, Math.max(0, x0));
  const cy0 = Math.min(h - 1, Math.max(0, y0));
  const cx1 = Math.min(w - 1, cx0 + 1);
  const cy1 = Math.min(h - 1, cy0 + 1);
  const i00 = (cy0 * w + cx0) * 3;
  const i10 = (cy0 * w + cx1) * 3;
  const i01 = (cy1 * w + cx0) * 3;
  const i11 = (cy1 * w + cx1) * 3;
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const top = img.data[i00 + c] * (1 - fx) + img.data[i10 + c] * fx;
    const bot = img.data[i01 + c] * (1 - fx) + img.data[i11 + c] * fx;
    out[c] = top * (1 - fy) + bot * fy;
  }
  return out;
}

/** 双线性采样单通道掩膜 */
export function sampleMaskBilinear(mask: MaskImage, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const w = mask.width;
  const h = mask.height;
  const cx0 = Math.min(w - 1, Math.max(0, x0));
  const cy0 = Math.min(h - 1, Math.max(0, y0));
  const cx1 = Math.min(w - 1, cx0 + 1);
  const cy1 = Math.min(h - 1, cy0 + 1);
  const top = mask.data[cy0 * w + cx0] * (1 - fx) + mask.data[cy0 * w + cx1] * fx;
  const bot = mask.data[cy1 * w + cx0] * (1 - fx) + mask.data[cy1 * w + cx1] * fx;
  return top * (1 - fy) + bot * fy;
}

/** 最近邻采样 LDR（对齐后取像素用） */
export function sampleLdrNearest(img: LdrImage, x: number, y: number, c: number): number {
  const ix = Math.min(img.width - 1, Math.max(0, Math.round(x)));
  const iy = Math.min(img.height - 1, Math.max(0, Math.round(y)));
  return img.data[(iy * img.width + ix) * 4 + c];
}

/** 区域平均线性颜色（掩膜=1 的像素跳过），返回 [r,g,b] 与有效样本数 */
export function regionMeanLinear(
  img: FloatImage,
  mask: MaskImage | null,
  predicate: (x: number, y: number) => boolean,
): { rgb: [number, number, number]; count: number } {
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let count = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (!predicate(x, y)) continue;
      if (mask && mask.data[y * img.width + x]) continue;
      const i = (y * img.width + x) * 3;
      sr += img.data[i];
      sg += img.data[i + 1];
      sb += img.data[i + 2];
      count++;
    }
  }
  if (count === 0) return { rgb: [0, 0, 0], count: 0 };
  return { rgb: [sr / count, sg / count, sb / count], count };
}
