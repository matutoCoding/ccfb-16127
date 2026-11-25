import type { EyeGeometry, LdrImage, RgbImage } from './types';

export function makeRgbImage(width: number, height: number): RgbImage {
  return { width, height, data: new Float32Array(width * height * 3) };
}

// 双线性采样（边界 clamp）
export function sampleRgbBilinear(img: RgbImage, x: number, y: number): [number, number, number] {
  const { width: w, height: h, data } = img;
  if (x < 0) x = 0; else if (x > w - 1) x = w - 1;
  if (y < 0) y = 0; else if (y > h - 1) y = h - 1;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const i00 = (y0 * w + x0) * 3, i10 = (y0 * w + x1) * 3;
  const i01 = (y1 * w + x0) * 3, i11 = (y1 * w + x1) * 3;
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const a = data[i00 + c] * (1 - fx) + data[i10 + c] * fx;
    const b = data[i01 + c] * (1 - fx) + data[i11 + c] * fx;
    out[c] = a * (1 - fy) + b * fy;
  }
  return out;
}

export interface RingSample {
  band: number;
  r: number; // 相对虹膜半径
  theta: number;
  x: number;
  y: number;
}

// 枚举虹膜环带像素（排除角膜高光 mask 与无效像素）
export function forEachRingPixel(
  width: number,
  height: number,
  geom: EyeGeometry,
  bandCount: number,
  fn: (band: number, idx: number, rRel: number) => void,
  highlightMask?: Uint8Array | null,
  validMask?: Uint8Array | null,
): number[] {
  const cx = geom.cx * width;
  const cy = geom.cy * height;
  const irisPx = geom.irisR * Math.min(width, height);
  const pupilPx = geom.pupilR * Math.min(width, height);
  const counts = new Array(bandCount).fill(0);
  const x0 = Math.max(0, Math.floor(cx - irisPx) - 1);
  const x1 = Math.min(width - 1, Math.ceil(cx + irisPx) + 1);
  const y0 = Math.max(0, Math.floor(cy - irisPx) - 1);
  const y1 = Math.min(height - 1, Math.ceil(cy + irisPx) + 1);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.hypot(dx, dy);
      if (d < pupilPx || d > irisPx) continue;
      const pidx = y * width + x;
      if (highlightMask && highlightMask[pidx]) continue;
      if (validMask && !validMask[pidx]) continue;
      const t = (d - pupilPx) / (irisPx - pupilPx);
      let band = Math.floor(t * bandCount);
      if (band >= bandCount) band = bandCount - 1;
      if (band < 0) band = 0;
      fn(band, pidx * 3, d / irisPx);
      counts[band]++;
    }
  }
  return counts;
}

// 计算每环带线性 RGB 均值
export function ringMeansLinear(
  img: RgbImage,
  geom: EyeGeometry,
  bandCount: number,
  highlightMask?: Uint8Array | null,
  validMask?: Uint8Array | null,
): [number, number, number][] {
  const sums = Array.from({ length: bandCount }, () => [0, 0, 0, 0]);
  forEachRingPixel(
    img.width,
    img.height,
    geom,
    bandCount,
    (band, idx) => {
      const s = sums[band];
      s[0] += img.data[idx];
      s[1] += img.data[idx + 1];
      s[2] += img.data[idx + 2];
      s[3]++;
    },
    highlightMask,
    validMask,
  );
  return sums.map((s) => (s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : [0, 0, 0]));
}

// LDR RGBA -> 每环带编码值均值（0..255）
export function ringMeansCodes(
  ldr: LdrImage,
  geom: EyeGeometry,
  bandCount: number,
  highlightMask?: Uint8Array | null,
): [number, number, number][] {
  const sums = Array.from({ length: bandCount }, () => [0, 0, 0, 0]);
  forEachRingPixel(
    ldr.width,
    ldr.height,
    geom,
    bandCount,
    (band, idx3) => {
      const i4 = (idx3 / 3) * 4;
      const s = sums[band];
      s[0] += ldr.data[i4];
      s[1] += ldr.data[i4 + 1];
      s[2] += ldr.data[i4 + 2];
      s[3]++;
    },
    highlightMask,
  );
  return sums.map((s) => (s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : [0, 0, 0]));
}

export function fillRgb(img: RgbImage, rgb: [number, number, number]) {
  const n = img.width * img.height;
  for (let i = 0; i < n; i++) {
    img.data[i * 3] = rgb[0];
    img.data[i * 3 + 1] = rgb[1];
    img.data[i * 3 + 2] = rgb[2];
  }
}
