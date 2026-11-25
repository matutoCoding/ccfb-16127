// HDR 链路：MTB 中位数阈值位图对齐 + Debevec–Malik 响应曲线反演 +
// 加权对数域合成 + 角膜高光过曝区检测 + 数据质量判定。
import { enforceMonotonic } from './camera';
import type { EyeGeometry, HdrQuality, LdrImage, ResponseCurve, RgbImage } from './types';

// ---------------- 灰度与 MTB ----------------
export function lumaAt(img: LdrImage, x: number, y: number): number {
  const i = (y * img.width + x) * 4;
  return 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
}

function medianThreshold(img: LdrImage): number {
  const hist = new Uint32Array(256);
  const n = img.width * img.height;
  for (let i = 0; i < n; i++) {
    hist[Math.round(0.2126 * img.data[i * 4] + 0.7152 * img.data[i * 4 + 1] + 0.0722 * img.data[i * 4 + 2])]++;
  }
  let acc = 0;
  for (let z = 0; z < 256; z++) {
    acc += hist[z];
    if (acc >= n / 2) return z;
  }
  return 127;
}

interface BitmapLevel {
  w: number;
  h: number;
  bits: Uint8Array; // 1 = luma >= median
}

function buildMtb(img: LdrImage, box: number): BitmapLevel {
  // box: 降采样边长倍数（1=原尺寸），用盒式平均
  const w = Math.max(8, Math.round(img.width / box));
  const h = Math.max(8, Math.round(img.height / box));
  const bits = new Uint8Array(w * h);
  const lumas = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor((y + 0.5) * box));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor((x + 0.5) * box));
      lumas[y * w + x] = lumaAt(img, sx, sy);
    }
  }
  const sorted = Array.from(lumas).sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  for (let i = 0; i < w * h; i++) bits[i] = lumas[i] >= med ? 1 : 0;
  return { w, h, bits };
}

function xorMismatch(a: BitmapLevel, b: BitmapLevel, dx: number, dy: number): number {
  // 尺寸相同（同一 box），按位移比较
  let xor = 0, cnt = 0;
  for (let y = 0; y < a.h; y++) {
    const by = y + dy;
    if (by < 0 || by >= a.h) continue;
    for (let x = 0; x < a.w; x++) {
      const bx = x + dx;
      if (bx < 0 || bx >= a.w) continue;
      cnt++;
      if (a.bits[y * a.w + x] !== b.bits[by * b.w + bx]) xor++;
    }
  }
  return cnt ? xor / cnt : 1;
}

export interface AlignResult {
  // correction[i] 可直接传给 shiftLdr(frame, correction.x, correction.y) 完成对齐
  correction: { x: number; y: number }[];
  mtbOffset: { x: number; y: number }[]; // MTB 搜索到的帧内容偏移
  errorBefore: number;
  errorAfter: number;
}

// 金字塔 MTB 平移对齐。referenceIndex 通常为 EV0。
export function alignFramesMtb(frames: LdrImage[], referenceIndex: number, maxFullShift = 14): AlignResult {
  const levels = [16, 8, 4, 2, 1];
  const refPyramid = levels.map((b) => buildMtb(frames[referenceIndex], b));
  const mtbOffset: { x: number; y: number }[] = frames.map(() => ({ x: 0, y: 0 }));
  let errorBefore = 0;
  let errorAfter = 0;

  frames.forEach((frame, fi) => {
    if (fi === referenceIndex) {
      mtbOffset[fi] = { x: 0, y: 0 };
      return;
    }
    let dx = 0, dy = 0;
    levels.forEach((box, li) => {
      const bm = buildMtb(frame, box);
      const ref = refPyramid[li];
      // 上层位移映射到本层
      if (li > 0) {
        dx *= 2;
        dy *= 2;
      }
      const radius = li === 0 ? 3 : 2;
      let best = { dx, dy, err: Infinity };
      for (let oy = -radius; oy <= radius; oy++) {
        for (let ox = -radius; ox <= radius; ox++) {
          const tx = dx + ox, ty = dy + oy;
          const err = xorMismatch(ref, bm, tx, ty);
          if (err < best.err) best = { dx: tx, dy: ty, err };
        }
      }
      dx = best.dx;
      dy = best.dy;
    });
    // box=1 层的位移即全分辨率位移
    dx = Math.max(-maxFullShift, Math.min(maxFullShift, dx));
    dy = Math.max(-maxFullShift, Math.min(maxFullShift, dy));
    mtbOffset[fi] = { x: dx, y: dy };
    const full = buildMtb(frame, 1);
    errorBefore += xorMismatch(refPyramid[levels.length - 1], full, 0, 0);
    errorAfter += xorMismatch(refPyramid[levels.length - 1], full, dx, dy);
  });

  const n = Math.max(1, frames.length - 1);
  return {
    mtbOffset,
    // MTB 找到的是内容偏移 (dx,dy)，shiftLdr 用 -dx/-dy 把它移回基准
    correction: mtbOffset.map((o) => ({ x: -o.x, y: -o.y })),
    errorBefore: errorBefore / n,
    errorAfter: errorAfter / n,
  };
}

// 按整数位移生成对齐后的帧（边缘复制）。shift 表示内容相对基准的位移，
// 因此基准坐标 (x,y) 应从源帧 (x - shift.x, y - shift.y) 取样。
export function shiftLdr(img: LdrImage, sx: number, sy: number): LdrImage {
  if (sx === 0 && sy === 0) return img;
  const out: LdrImage = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data.length) };
  const { width: w, height: h } = img;
  for (let y = 0; y < h; y++) {
    const sySrc = Math.min(h - 1, Math.max(0, y - sy));
    for (let x = 0; x < w; x++) {
      const sxSrc = Math.min(w - 1, Math.max(0, x - sx));
      const di = (y * w + x) * 4;
      const si = (sySrc * w + sxSrc) * 4;
      out.data[di] = img.data[si];
      out.data[di + 1] = img.data[si + 1];
      out.data[di + 2] = img.data[si + 2];
      out.data[di + 3] = 255;
    }
  }
  return out;
}

// ---------------- Debevec–Malik 响应曲线 ----------------
function hatWeights(zMax = 255): Float64Array {
  const w = new Float64Array(zMax + 1);
  for (let z = 0; z <= zMax; z++) {
    w[z] = z <= zMax / 2 ? z / (zMax / 2) : (zMax - z) / (zMax / 2);
    w[z] = Math.max(w[z], 0);
  }
  return w;
}

// Cholesky 分解 + 求解正定方程 A x = b（A 为对称矩阵）
function choleskySolve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const L: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = 0;
      for (let k = 0; k < j; k++) sum += L[i][k] * L[j][k];
      if (i === j) {
        const v = A[i][i] - sum;
        L[i][j] = Math.sqrt(Math.max(1e-12, v));
      } else {
        L[i][j] = (A[i][j] - sum) / L[j][j];
      }
    }
  }
  // Ly=b
  const y = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * y[k];
    y[i] = s / L[i][i];
  }
  // L^T x = y
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k];
    x[i] = s / L[i][i];
  }
  return x;
}

export interface RecoverOptions {
  samples?: number;
  lambda?: number;
  seed?: number;
}

// frames 为已对齐的 RGBA 图；dt 为曝光量（相对秒，取 ln）
export function recoverResponse(frames: LdrImage[], dt: number[], opts: RecoverOptions = {}): ResponseCurve {
  const K = Math.min(opts.samples ?? 130, frames[0].width * frames[0].height);
  const lambda = opts.lambda ?? 28;
  const w = hatWeights();
  const wImg = frames[0].width, hImg = frames[0].height;

  // 均匀 + 亮度覆盖采样：网格抖动取点，避免全取到同一灰度
  const pixels: number[] = [];
  const grid = Math.ceil(Math.sqrt(K * 2.2));
  let seed = opts.seed ?? 12345;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      if (pixels.length >= K) break;
      const x = Math.min(wImg - 1, Math.floor(((gx + 0.25 + rnd() * 0.5) / grid) * wImg));
      const y = Math.min(hImg - 1, Math.floor(((gy + 0.25 + rnd() * 0.5) / grid) * hImg));
      pixels.push(y * wImg + x);
    }
  }
  const P = pixels.length;
  const N = 256 + P;
  const A: number[][] = Array.from({ length: N }, () => new Array(N).fill(0));
  const b = new Array(N).fill(0);

  const addRow = (cols: number[], vals: number[], rhs: number) => {
    // 直接累积正规方程 A^T A x = A^T b，避免存稀疏行
    for (let i = 0; i < cols.length; i++) {
      const ci = cols[i], vi = vals[i];
      A[ci][ci] += vi * vi;
      b[ci] += vi * rhs;
      for (let j = i + 1; j < cols.length; j++) {
        const cj = cols[j], vj = vals[j];
        A[ci][cj] += vi * vj;
        A[cj][ci] += vi * vj;
      }
    }
  };

  const lnDt = dt.map((d) => Math.log(d));
  for (let k = 0; k < P; k++) {
    const pidx = pixels[k] * 4;
    const ek = 256 + k;
    for (let j = 0; j < frames.length; j++) {
      const z = Math.round(
        0.2126 * frames[j].data[pidx] + 0.7152 * frames[j].data[pidx + 1] + 0.0722 * frames[j].data[pidx + 2],
      );
      const wz = w[z];
      if (wz <= 0) continue;
      // wz*g[z] - wz*E = wz*lnDt
      addRow([z, ek], [wz, -wz], wz * lnDt[j]);
    }
  }
  // 平滑项
  for (let z = 1; z <= 254; z++) {
    const wz = w[z] * lambda;
    addRow([z - 1, z, z + 1], [wz, -2 * wz, wz], 0);
  }
  // 锚点 g[127]=0
  addRow([127], [1], 0);

  const x = choleskySolve(A, b);
  let gCurve = x.slice(0, 256);
  gCurve = enforceMonotonic(gCurve);
  // 锚点可能因单调化轻微漂移，重新归零
  const anchor = gCurve[127];
  gCurve = gCurve.map((v) => v - anchor);
  gCurve = enforceMonotonic(gCurve);

  return {
    g: gCurve,
    lnXMin: gCurve[0],
    lnXMax: gCurve[255],
    method: 'debevec-malik',
    recoveredAt: 0,
  };
}

// ---------------- HDR 合成 ----------------
export interface MergeResult {
  hdr: RgbImage;
  valid: Uint8Array; // 1=至少一帧中间调参与
  sumW: Float32Array;
}

export function mergeHdr(frames: LdrImage[], dts: number[], curve: ResponseCurve): MergeResult {
  const { width, height } = frames[0];
  const n = width * height;
  const hdr: RgbImage = { width, height, data: new Float32Array(n * 3) };
  const valid = new Uint8Array(n);
  const sumW = new Float32Array(n);
  const w = hatWeights();
  const lnDt = dts.map((d) => Math.log(d));
  const g = curve.g;

  for (let i = 0; i < n; i++) {
    const wsum = [0, 0, 0];
    const lnE = [0, 0, 0];
    for (let j = 0; j < frames.length; j++) {
      const i4 = i * 4;
      for (let c = 0; c < 3; c++) {
        const z = frames[j].data[i4 + c];
        const wz = w[z];
        if (wz <= 0) continue;
        wsum[c] += wz;
        lnE[c] += wz * (g[z] - lnDt[j]);
      }
    }
    if (wsum[0] + wsum[1] + wsum[2] <= 1e-6) continue;
    valid[i] = 1;
    sumW[i] = (wsum[0] + wsum[1] + wsum[2]) / 3;
    for (let c = 0; c < 3; c++) {
      if (wsum[c] <= 1e-6) {
        hdr.data[i * 3 + c] = 0;
        continue;
      }
      const ln = lnE[c] / wsum[c];
      hdr.data[i * 3 + c] = Math.exp(Math.max(-30, Math.min(30, ln)));
    }
  }
  return { hdr, valid, sumW };
}

// 全局尺度标定：Debevec 曲线带一个整体尺度自由度，
// 用虹膜 ROI 的中位数比值求单一标量（不做逐通道拟合，避免“调答案”）。
export function calibrateGlobalScale(hdr: RgbImage, truth: RgbImage, roi?: Uint8Array): number {
  const ratios: number[] = [];
  const n = hdr.width * hdr.height;
  for (let i = 0; i < n; i++) {
    if (roi && !roi[i]) continue;
    const yH = 0.2126 * hdr.data[i * 3] + 0.7152 * hdr.data[i * 3 + 1] + 0.0722 * hdr.data[i * 3 + 2];
    const yT = 0.2126 * truth.data[i * 3] + 0.7152 * truth.data[i * 3 + 1] + 0.0722 * truth.data[i * 3 + 2];
    if (yH < 1e-4 || yT < 0.02) continue;
    ratios.push(yT / yH);
  }
  ratios.sort((a, b) => a - b);
  return ratios.length ? ratios[Math.floor(ratios.length / 2)] : 1;
}

// ---------------- 角膜高光过曝区 ----------------
export function detectHighlightMask(frame: LdrImage, geom: EyeGeometry, dilate = 4): Uint8Array {
  const { width: w, height: h, data } = frame;
  const n = w * h;
  const mask = new Uint8Array(n);
  const cx = geom.cx * w, cy = geom.cy * h, irisPx = geom.irisR * Math.min(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      if (Math.hypot(dx, dy) > irisPx * 1.02) continue;
      const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      // 高亮、低饱和（闪光灯/柔光箱反光），或三通道全部撞顶
      if ((lum > 228 && sat < 46) || (r >= 252 && g >= 252 && b >= 252)) mask[i] = 1;
    }
  }
  // 仅保留偏上方的最大连通高光团（避免把整片浅虹膜误判）
  const labels = new Int32Array(n).fill(-1);
  const comps: { pixels: number[]; cy: number; size: number }[] = [];
  const stack: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!mask[i] || labels[i] !== -1) continue;
    const id = comps.length;
    const pixels: number[] = [];
    let sy = 0;
    labels[i] = id;
    stack.push(i);
    while (stack.length) {
      const p = stack.pop()!;
      pixels.push(p);
      const px = p % w, py = (p / w) | 0;
      sy += py;
      for (const [nx, ny] of [[px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]]) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (mask[q] && labels[q] === -1) {
          labels[q] = id;
          stack.push(q);
        }
      }
    }
    comps.push({ pixels, cy: sy / pixels.length, size: pixels.length });
  }
  const keep = new Uint8Array(n);
  // 取虹膜上半部、面积合理的最大团；若多个小团则全保留
  const upper = comps.filter((c) => c.cy < cy + irisPx * 0.25 && c.size > 8);
  upper.sort((a, b) => b.size - a.size);
  const chosen = upper.length ? upper.slice(0, 2) : comps.filter((c) => c.size > 20);
  for (const c of chosen) for (const p of c.pixels) keep[p] = 1;

  // 膨胀，覆盖高光边缘的颜色污染
  const dilated = new Uint8Array(n);
  const rad = Math.max(1, Math.round((dilate / 384) * w));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let hit = false;
      for (let oy = -rad; oy <= rad && !hit; oy++) {
        for (let ox = -rad; ox <= rad; ox++) {
          const nx = x + ox, ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (keep[ny * w + nx]) { hit = true; break; }
        }
      }
      if (hit) dilated[y * w + x] = 1;
    }
  }
  return dilated;
}

// ---------------- 质量判定 ----------------
export function assessQuality(
  frames: LdrImage[],
  referenceIndex: number,
  geom: EyeGeometry,
  align: AlignResult,
  highlightMask: Uint8Array,
): HdrQuality {
  const ref = frames[referenceIndex];
  const w = ref.width, h = ref.height;
  const cx = geom.cx * w, cy = geom.cy * h, irisPx = geom.irisR * Math.min(w, h);
  let irisN = 0, clipped = 0, maskN = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      if (Math.hypot(dx, dy) > irisPx * 0.96) continue;
      const i = y * w + x;
      irisN++;
      if (highlightMask[i]) maskN++;
      const p = i * 4;
      const lum = 0.2126 * ref.data[p] + 0.7152 * ref.data[p + 1] + 0.0722 * ref.data[p + 2];
      if (lum >= 248) clipped++;
    }
  }
  const clippedFraction = irisN ? clipped / irisN : 1;
  // 可用帧：虹膜内有足够中间调（60..235）像素
  let usableFrames = 0;
  for (const f of frames) {
    let mid = 0, tot = 0;
    for (let y = Math.max(0, Math.floor(cy - irisPx)); y < Math.min(h, cy + irisPx); y += 2) {
      for (let x = Math.max(0, Math.floor(cx - irisPx)); x < Math.min(w, cx + irisPx); x += 2) {
        const dx = x - cx, dy = y - cy;
        if (Math.hypot(dx, dy) > irisPx * 0.95) continue;
        const i = (y * w + x) * 4;
        const lum = 0.2126 * f.data[i] + 0.7152 * f.data[i + 1] + 0.0722 * f.data[i + 2];
        tot++;
        if (lum > 48 && lum < 238) mid++;
      }
    }
    if (tot && mid / tot > 0.24) usableFrames++;
  }
  const allOverexposed = usableFrames === 0 || clippedFraction > 0.82;
  // 跨曝光 MTB 位图本身因阈值/噪声有约 20% 的固有异或，残差低于 27% 视为对齐可用
  const aligned = align.errorAfter < 0.27;
  let message: string;
  if (allOverexposed) message = '整组照片全部过曝，虹膜没有可用中间调，HDR 无法恢复颜色，请降低曝光补拍。';
  else if (!aligned) message = '对齐残差偏高，建议使用三脚架/固定机位重拍；当前结果可能有径向重影。';
  else if (maskN / Math.max(1, irisN) > 0.18) message = '角膜高光面积偏大，已自动剔除，环带取色不受影响。';
  else message = '对齐与曝光序列正常，响应曲线与 HDR 合成可用。';
  return {
    aligned,
    mtbErrorBefore: align.errorBefore,
    mtbErrorAfter: align.errorAfter,
    clippedFraction,
    allOverexposed,
    usableFrames,
    message,
  };
}
