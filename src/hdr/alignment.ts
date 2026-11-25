/**
 * 多曝光对齐：以中位曝光帧为参考，做平移模型的亚像素配准。
 *
 * 策略：
 *  1. 全部帧解码到线性域并按曝光归一（消掉帧间亮度量级差）；
 *  2. 用归一化互相关（NCC）在 ±SEARCH_RADIUS 内搜索整数偏移——NCC 对曝光/增益
 *     导致的线性亮度变化免疫，可靠性软权重剔除死黑与饱和像素；
 *  3. 亚像素：在最优整数偏移的 3×3 邻域上对 NCC 取负拟合二次曲面求极值；
 *  4. 最优解相对零偏移的相关增益超阈值且偏移显著时，判手抖失配并警告，不静默丢弃。
 */
import type { AlignmentResult, LdrImage } from '../core/types';
import { ldrToLinear, sampleBilinear, makeFloatImage } from '../core/image';

const SEARCH_RADIUS = 12;
/** NCC 最优解相对零偏移的相关增益阈值，超过即判手抖失配 */
const CONFIDENCE_NCC_GAIN = 0.08;
/** 零偏移总可靠性权重低于此值时，该帧信息不足，跳过配准判定（极暗/极亮帧） */
const MIN_OVERLAP_WEIGHT = 200;

/** 线性图按曝光归一：除以 2^EV，再做稳定化平方根压缩，供配准比较 */
function normalizedForAlignment(img: LdrImage): Float32Array {
  const lin = ldrToLinear(img);
  const scale = 2 ** img.exposure;
  const n = img.width * img.height;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) {
    out[i] = Math.sqrt(Math.max(0, lin.data[i] / scale));
  }
  return out;
}

/** 归一化 RGB → 标量亮度（梯度计算用） */
function lumaField(norm: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    out[p] = 0.2126 * norm[p * 3] + 0.7152 * norm[p * 3 + 1] + 0.0722 * norm[p * 3 + 2];
  }
  return out;
}

/** 像素可靠性权重：可靠中段为 1，向死黑/饱和两端平滑降到 0（软门控，避免硬掩膜导致样本集随偏移变化） */
function reliability(img: LdrImage): Float32Array {
  const n = img.width * img.height;
  const r = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const luma = 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
    // [24,220] 完全可靠；[8,24] 与 [220,247] 线性衰减；之外为 0
    if (luma < 8 || luma > 247) r[p] = 0;
    else if (luma < 24) r[p] = (luma - 8) / 16;
    else if (luma > 220) r[p] = (247 - luma) / 27;
    else r[p] = 1;
  }
  return r;
}

/**
 * 归一化互相关（NCC）匹配分数，值域约 [-1,1]，越大越匹配。
 * 在归一化亮度场上计算，对曝光/增益导致的线性亮度变化天然免疫；
 * 用可靠性权重只采纳两帧都可信的像素。返回分数与总权重。
 */
function nccScore(
  refL: Float32Array,
  tgtL: Float32Array,
  refRel: Float32Array,
  tgtRel: Float32Array,
  w: number,
  h: number,
  dx: number,
  dy: number,
  border: number,
): { score: number; weight: number } {
  let wsum = 0;
  let mr = 0;
  let mt = 0;
  // 第一遍：加权均值
  for (let y = border; y < h - border; y++) {
    const sy = y + dy;
    if (sy < 1 || sy >= h - 2) continue;
    const y0 = Math.floor(sy);
    const fy = sy - y0;
    for (let x = border; x < w - border; x++) {
      const sx = x + dx;
      if (sx < 1 || sx >= w - 2) continue;
      const x0 = Math.floor(sx);
      const fx = sx - x0;
      const i00 = y0 * w + x0;
      const tRel =
        tgtRel[i00] * (1 - fx) * (1 - fy) +
        tgtRel[i00 + 1] * fx * (1 - fy) +
        tgtRel[i00 + w] * (1 - fx) * fy +
        tgtRel[i00 + w + 1] * fx * fy;
      const weight = refRel[y * w + x] * tRel;
      if (weight < 0.05) continue;
      const tv =
        tgtL[i00] * (1 - fx) * (1 - fy) +
        tgtL[i00 + 1] * fx * (1 - fy) +
        tgtL[i00 + w] * (1 - fx) * fy +
        tgtL[i00 + w + 1] * fx * fy;
      wsum += weight;
      mr += weight * refL[y * w + x];
      mt += weight * tv;
    }
  }
  if (wsum < MIN_OVERLAP_WEIGHT) return { score: -Infinity, weight: wsum };
  mr /= wsum;
  mt /= wsum;
  // 第二遍：加权协方差/方差
  let cov = 0;
  let vr = 0;
  let vt = 0;
  for (let y = border; y < h - border; y++) {
    const sy = y + dy;
    if (sy < 1 || sy >= h - 2) continue;
    const y0 = Math.floor(sy);
    const fy = sy - y0;
    for (let x = border; x < w - border; x++) {
      const sx = x + dx;
      if (sx < 1 || sx >= w - 2) continue;
      const x0 = Math.floor(sx);
      const fx = sx - x0;
      const i00 = y0 * w + x0;
      const tRel =
        tgtRel[i00] * (1 - fx) * (1 - fy) +
        tgtRel[i00 + 1] * fx * (1 - fy) +
        tgtRel[i00 + w] * (1 - fx) * fy +
        tgtRel[i00 + w + 1] * fx * fy;
      const weight = refRel[y * w + x] * tRel;
      if (weight < 0.05) continue;
      const tv =
        tgtL[i00] * (1 - fx) * (1 - fy) +
        tgtL[i00 + 1] * fx * (1 - fy) +
        tgtL[i00 + w] * (1 - fx) * fy +
        tgtL[i00 + w + 1] * fx * fy;
      const dr = refL[y * w + x] - mr;
      const dt = tv - mt;
      cov += weight * dr * dt;
      vr += weight * dr * dr;
      vt += weight * dt * dt;
    }
  }
  const denom = Math.sqrt(vr * vt);
  return { score: denom > 1e-12 ? cov / denom : -Infinity, weight: wsum };
}

/** 3×3 二次曲面亚像素极值（解析公式，对 SSD 网格） */
function subpixelRefine(cost: number[][], cx: number, cy: number): { dx: number; dy: number } {
  // 边界最优或邻域含 Infinity（有效像素不足）时不做亚像素外推，退回整数偏移
  if (cy <= 0 || cy >= cost.length - 1 || cx <= 0 || cx >= cost[0].length - 1) {
    return { dx: cx - SEARCH_RADIUS, dy: cy - SEARCH_RADIUS };
  }
  for (let v = -1; v <= 1; v++) {
    for (let u = -1; u <= 1; u++) {
      if (!Number.isFinite(cost[cy + v][cx + u])) {
        return { dx: cx - SEARCH_RADIUS, dy: cy - SEARCH_RADIUS };
      }
    }
  }
  // 局部坐标 u,v ∈ {-1,0,1}，拟合 z = a + bu + cv + du² + ev² + fuv
  // 用 9 点最小二乘（此处网格恰好 9 点，解 6 元正规方程）
  const X: number[][] = [];
  const z: number[] = [];
  for (let v = -1; v <= 1; v++) {
    for (let u = -1; u <= 1; u++) {
      X.push([1, u, v, u * u, v * v, u * v]);
      z.push(cost[cy + v][cx + u]);
    }
  }
  const k = 6;
  const A = new Float64Array(k * k);
  const b = new Float64Array(k);
  for (let i = 0; i < 9; i++) {
    for (let p = 0; p < k; p++) {
      b[p] += X[i][p] * z[i];
      for (let q = 0; q < k; q++) A[p * k + q] += X[i][p] * X[i][q];
    }
  }
  let beta: Float64Array;
  try {
    beta = solveSmall(A, b, k);
  } catch {
    return { dx: cx, dy: cy };
  }
  const [, bu, bv, du, ev] = beta;
  // 极值：u* = -b_u / (2d)（若曲率非正，退回整数）
  let uStar = 0;
  let vStar = 0;
  if (du > 0) uStar = -bu / (2 * du);
  if (ev > 0) vStar = -bv / (2 * ev);
  uStar = Math.max(-1, Math.min(1, uStar));
  vStar = Math.max(-1, Math.min(1, vStar));
  // cx/cy 是代价网格坐标（= 实际偏移 + SEARCH_RADIUS），还原时减去半径
  return { dx: cx - SEARCH_RADIUS + uStar, dy: cy - SEARCH_RADIUS + vStar };
}

/**
 * NCC 分数网格的亚像素极大值：取负后复用 SSD 极小值的二次曲面拟合。
 * 含 -Infinity（无效偏移）时退回整数最优，不外推。
 */
function subpixelMax(scoreGrid: number[][], cx: number, cy: number): { dx: number; dy: number } {
  if (cy <= 0 || cy >= scoreGrid.length - 1 || cx <= 0 || cx >= scoreGrid[0].length - 1) {
    return { dx: cx - SEARCH_RADIUS, dy: cy - SEARCH_RADIUS };
  }
  const neg = scoreGrid.map((row) => row.map((v) => (Number.isFinite(v) ? -v : 1e9)));
  return subpixelRefine(neg, cx, cy);
}

/** 6×6 高斯消元（配准专用，避免拉通用求解器的开销） */
function solveSmall(a: Float64Array, b: Float64Array, n: number): Float64Array {
  const m = new Float64Array(n * (n + 1));
  for (let i = 0; i < n; i++) {
    m.set(a.subarray(i * n, i * n + n), i * (n + 1));
    m[i * (n + 1) + n] = b[i];
  }
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r * (n + 1) + col]) > Math.abs(m[pivot * (n + 1) + col])) pivot = r;
    }
    if (Math.abs(m[pivot * (n + 1) + col]) < 1e-15) throw new Error('奇异');
    if (pivot !== col) {
      for (let k = 0; k <= n; k++) {
        const tmp = m[pivot * (n + 1) + k];
        m[pivot * (n + 1) + k] = m[col * (n + 1) + k];
        m[col * (n + 1) + k] = tmp;
      }
    }
    const d = m[col * (n + 1) + col];
    for (let k = col; k <= n; k++) m[col * (n + 1) + k] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r * (n + 1) + col];
      for (let k = col; k <= n; k++) m[r * (n + 1) + k] -= f * m[col * (n + 1) + k];
    }
  }
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = m[i * (n + 1) + n];
  return x;
}

export interface AlignOutput {
  result: AlignmentResult;
  /** 对齐后重采样的帧（线性域，供后续合并） */
  alignedLinear: Float32Array[];
  warnings: string[];
}

/**
 * 对齐整个序列。返回参考帧索引、每帧亚像素偏移与重采样后的线性帧。
 */
export function alignExposureStack(images: LdrImage[]): AlignOutput {
  if (images.length < 2) {
    const w = images[0]?.width ?? 0;
    const h = images[0]?.height ?? 0;
    return {
      result: { offsets: [{ dx: 0, dy: 0, score: 0 }], referenceIndex: 0 },
      alignedLinear: images.length ? [ldrToLinear(images[0]).data] : [],
      warnings: [],
    };
  }
  const { width: w, height: h } = images[0].width ? { width: images[0].width, height: images[0].height } : { width: 0, height: 0 };
  // 参考帧：曝光最接近中位数的那一张
  const evs = images.map((im) => im.exposure);
  const sorted = [...evs].sort((a, b) => a - b);
  const medianEv = sorted[Math.floor(sorted.length / 2)];
  const refIdx = evs.indexOf(medianEv);

  const norm = images.map(normalizedForAlignment);
  const rel = images.map(reliability);
  // 归一化亮度场：NCC 匹配的输入（NCC 对曝光导致的线性亮度变化免疫）
  const luma = norm.map((f) => lumaField(f, w * h));
  const refRel = rel[refIdx];
  const refLuma = luma[refIdx];
  const border = SEARCH_RADIUS + 2;

  const offsets = [];
  const warnings: string[] = [];

  for (let j = 0; j < images.length; j++) {
    if (j === refIdx) {
      offsets.push({ dx: 0, dy: 0, score: 0 });
      continue;
    }

    // 零偏移下的总可靠性权重；过低（极暗/极亮帧大面积不可靠）时配准无统计意义，
    // 按零偏移处理且不报警。
    const zero = nccScore(refLuma, luma[j], refRel, rel[j], w, h, 0, 0, border);
    if (zero.weight < MIN_OVERLAP_WEIGHT) {
      offsets.push({ dx: 0, dy: 0, score: 0 });
      continue;
    }

    // 最大化 NCC：搜索网格（score 网格，越大越好）
    const scoreGrid: number[][] = [];
    let best = { dx: 0, dy: 0, score: -Infinity };
    for (let dy = -SEARCH_RADIUS; dy <= SEARCH_RADIUS; dy++) {
      const row: number[] = [];
      for (let dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; dx++) {
        const { score } = nccScore(refLuma, luma[j], refRel, rel[j], w, h, dx, dy, border);
        row.push(score);
        if (score > best.score) best = { dx, dy, score };
      }
      scoreGrid.push(row);
    }
    const zeroScore = zero.score;
    const cx = best.dx + SEARCH_RADIUS;
    const cy = best.dy + SEARCH_RADIUS;
    const sub = subpixelMax(scoreGrid, cx, cy);
    const subScore = nccScore(refLuma, luma[j], refRel, rel[j], w, h, sub.dx, sub.dy, border).score;
    offsets.push({ dx: sub.dx, dy: sub.dy, score: subScore });
    // 置信度判据：真对齐时零偏移 NCC 已接近最优；手抖时最优解显著优于零偏移。
    // 用 (best - zero) 的相关增益衡量失配程度。
    const correlationGain = Number.isFinite(subScore) ? subScore - zeroScore : 0;
    // 三个条件同时满足才判手抖：相关增益超阈值、偏移显著、最优解不在搜索边界
    // （边界最优意味着搜索半径不足或该帧信息不可靠，不能当作失配证据）。
    const atBoundary =
      Math.abs(best.dx) >= SEARCH_RADIUS - 1 || Math.abs(best.dy) >= SEARCH_RADIUS - 1;
    const shiftMag = Math.hypot(sub.dx, sub.dy);
    if (correlationGain > CONFIDENCE_NCC_GAIN && shiftMag > 2.0 && !atBoundary) {
      warnings.push(
        `第 ${j + 1} 张（EV ${images[j].exposure}）对齐置信度低：需平移 (${sub.dx.toFixed(1)},${sub.dy.toFixed(1)})px 才对齐，相关增益 ${correlationGain.toFixed(3)}，疑似手抖失配`,
      );
    }
  }

  // 用亚像素偏移把各帧重采样到参考帧坐标系（线性域）
  const alignedLinear: Float32Array[] = [];
  for (let j = 0; j < images.length; j++) {
    const lin = ldrToLinear(images[j]);
    if (j === refIdx) {
      alignedLinear.push(lin.data);
      continue;
    }
    const { dx, dy } = offsets[j];
    const warped = makeFloatImage(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = sampleBilinear(lin, x + dx, y + dy);
        const i = (y * w + x) * 3;
        warped.data[i] = s[0];
        warped.data[i + 1] = s[1];
        warped.data[i + 2] = s[2];
      }
    }
    alignedLinear.push(warped.data);
  }

  return {
    result: { offsets, referenceIndex: refIdx },
    alignedLinear,
    warnings,
  };
}
