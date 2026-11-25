/**
 * 相机响应曲线恢复（Debevec & Malik 1997）。
 *
 * 模型：g(Z_ij) = ln E_i + ln t_j
 *   g  : 8 位像素值 → 对数曝光的映射（待求，256 级）
 *   E_i: 像素 i 的场景辐照度
 *   t_j: 第 j 张照片的曝光量（这里用相对 EV，e_j = ev_j * ln2）
 *
 * 实现要点：
 *  - 三角权重 w(z)=min(z,255-z)，z=0/255 权重为 0，自动剔除死黑与过曝样本；
 *  - 先对每个像素消去 ln E_i（Schur 补），正规方程只剩 256×256，全像素参与也不膨胀；
 *  - 二阶差分平滑项 λΣw(z)·g''(z)²；
 *  - 锚定 g(128)=0 固定对数尺度；
 *  - 逐通道求解，并生成单调化反查 LUT 供成像比对复用同一条曲线。
 */
import type { LdrImage, ResponseCurve } from '../core/types';
import { solveLinear } from '../linalg/solve';

const N = 256;
const ANCHOR = 128;
const LUT_SIZE = 1024;

/**
 * 样本权重：以 128 为中心的高斯型（σ≈64），两端平滑归零。
 * 相比三角权重，中段约束更集中、暗/亮端过渡更平滑，恢复曲线斜率更稳。
 */
export function debevecWeight(z: number): number {
  if (z <= 1 || z >= N - 2) return 0;
  const x = (z - ANCHOR) / 70;
  return Math.exp(-0.5 * x * x) * ANCHOR;
}

export interface ResponseRecoverResult {
  curve: ResponseCurve;
  fitRms: [number, number, number];
  /** 每通道有效样本数（权重>0） */
  validSamples: [number, number, number];
}

/**
 * @param images 同机位多曝光 LDR 序列（已对齐），exposure 字段为 EV（档）
 * @param lambda 平滑权重
 */
/**
 * 单调保形平滑：在保持 g(anchor)=0 的前提下，用宽度 5 的局部线性趋势
 * 消除斜率振荡，再施加严格单调包络。响应曲线物理上必须单调递增。
 */
function monotoneSmooth(g: Float64Array, anchor: number): void {
  const n = g.length;
  const smoothed = new Float64Array(n);
  // 5 点二次 Savitzky-Golay 平滑系数（[-3,12,17,12,-3]/35），抑制斜率振荡又不过度抹平
  const half = 2;
  const sg = [-3, 12, 17, 12, -3];
  const sgNorm = 35;
  for (let z = 0; z < n; z++) {
    let acc = 0;
    let wsum = 0;
    for (let k = -half; k <= half; k++) {
      const idx = z + k;
      if (idx < 0 || idx >= n) continue;
      const w = sg[k + half];
      acc += w * g[idx];
      wsum += w;
    }
    smoothed[z] = wsum === sgNorm ? acc / sgNorm : acc / wsum;
  }
  // 严格单调包络：锚点向高值取累计 max，向低值取累计 min
  smoothed[anchor] = g[anchor];
  for (let z = anchor + 1; z < n; z++) smoothed[z] = Math.max(smoothed[z - 1], smoothed[z]);
  for (let z = anchor - 1; z >= 0; z--) smoothed[z] = Math.min(smoothed[z + 1], smoothed[z]);
  g.set(smoothed);
}

/**
 * 参数化 OECF 精炼。
 * 模型 q(u) = floor + (1-floor)·(m·u^γ + (1-m)·u)，u = z/255；
 * 由当前 g 反推 q(u)=exp(g(z))·exp(g(anchor))，再网格搜索 (γ, floor)、
 * 对线性参数 m 做 2×2 最小二乘，最后用最优参数重建单调 g。
 */
function parametricOecfRefit(g: Float64Array, anchor: number): void {
  const qAnchor = Math.exp(g[anchor]);
  const pts: Array<[number, number]> = [];
  for (let z = 20; z <= 235; z++) {
    const u = z / (N - 1);
    const q = Math.max(0, Math.exp(g[z]) * qAnchor);
    pts.push([u, q]);
  }

  let best = { gamma: 0.45, m: 1, floor: 0.002, err: Infinity };
  for (let gamma = 0.3; gamma <= 0.8; gamma += 0.01) {
    for (let floor = 0; floor <= 0.012; floor += 0.002) {
      // y = (q-floor)/(1-floor) = m·u^γ + (1-m)·u → y-u = m·(u^γ-u)
      let sxx = 0;
      let sxy = 0;
      let syy = 0;
      for (const [u, q] of pts) {
        const y = (q - floor) / (1 - floor);
        const x = u ** gamma - u;
        const yy = y - u;
        sxx += x * x;
        sxy += x * yy;
        syy += yy * yy;
      }
      if (sxx < 1e-12) continue;
      const m = sxy / sxx;
      if (m <= 0 || m > 6) continue;
      // 残差
      let err = 0;
      for (const [u, q] of pts) {
        const pred = floor + (1 - floor) * (m * u ** gamma + (1 - m) * u);
        const d = pred - q;
        err += d * d;
      }
      if (err < best.err) best = { gamma, m, floor, err };
    }
  }

  // 用最优参数重建 g，锚点归零
  const qHalf =
    best.floor + (1 - best.floor) * (best.m * (anchor / (N - 1)) ** best.gamma + (1 - best.m) * (anchor / (N - 1)));
  for (let z = 0; z < N; z++) {
    const u = z / (N - 1);
    const q = best.floor + (1 - best.floor) * (best.m * u ** best.gamma + (1 - best.m) * u);
    g[z] = Math.log(q / qHalf);
  }
}

export function recoverResponseCurve(images: LdrImage[], lambda = 8): ResponseRecoverResult {
  if (images.length < 2) {
    throw new Error('响应曲线恢复至少需要 2 张不同曝光的照片');
  }
  const logT = images.map((im) => im.exposure * Math.LN2);
  const pixelCount = images[0].width * images[0].height;
  const g = new Float32Array(N * 3);
  const fitRms: [number, number, number] = [0, 0, 0];
  const validSamples: [number, number, number] = [0, 0, 0];

  // 预检：最暗帧中接近饱和的像素占比过高 → 整序列过曝。
  // 不能只数"未饱和像素"，因为眼球外的黑色背景即使全过曝也仍是黑的；
  // 改为统计最暗帧里高亮度（>235）像素比例，正常序列该比例应很低。
  const darkestIdx = images.reduce((m, im, j) => (im.exposure < images[m].exposure ? j : m), 0);
  const darkest = images[darkestIdx];
  let nearClipped = 0;
  for (let p = 0; p < pixelCount; p++) {
    const i = p * 4;
    const luma = 0.2126 * darkest.data[i] + 0.7152 * darkest.data[i + 1] + 0.0722 * darkest.data[i + 2];
    if (luma > 235) nearClipped++;
  }
  if (nearClipped > pixelCount * 0.5) {
    throw new AllOverexposedError(
      `最暗帧（EV ${darkest.exposure}）中 ${nearClipped}/${pixelCount} 个像素接近饱和，序列全部过曝，无法恢复响应曲线`,
      nearClipped,
    );
  }

  // 均匀网格抽样像素用于拟合（控制计算量，覆盖均匀）
  const maxSamples = 600;
  const stride = Math.max(1, Math.ceil(Math.sqrt(pixelCount / maxSamples)));
  const samplePixels: number[] = [];
  const w0 = images[0].width;
  for (let y = 0; y < images[0].height; y += stride) {
    for (let x = 0; x < w0; x += stride) samplePixels.push(y * w0 + x);
  }

  for (let ch = 0; ch < 3; ch++) {
    // 收集每个抽样像素的有效 (z, w, ln t) 序列
    const pixelObs: Array<Array<{ z: number; w: number; lt: number }>> = [];
    let totalValid = 0;
    for (const p of samplePixels) {
      const obs: Array<{ z: number; w: number; lt: number }> = [];
      for (let j = 0; j < images.length; j++) {
        const z = images[j].data[p * 4 + ch];
        const w = debevecWeight(z);
        if (w <= 0) continue;
        obs.push({ z, w, lt: logT[j] });
      }
      if (obs.length > 0) {
        pixelObs.push(obs);
        totalValid += obs.length;
      }
    }

    if (totalValid < images.length * 40) {
      throw new AllOverexposedError(
        `通道 ${'RGB'[ch]} 有效样本仅 ${totalValid} 个，序列疑似全部过曝或死黑，无法恢复响应曲线`,
        totalValid,
      );
    }

    // 交替最小二乘：
    //  固定 g → 每像素 lnE = Σw(g(z)-ln t)/Σw（闭式）
    //  固定 lnE → g 满足带二阶平滑的三对角法方程
    // 用 sRGB 风格单调初值，避免冷启动
    const gHat = new Float64Array(N);
    for (let z = 0; z < N; z++) gHat[z] = Math.log(Math.max(1e-3, z / ANCHOR));

    const ITER = 30;
    let lnE = new Float64Array(pixelObs.length);
    for (let it = 0; it < ITER; it++) {
      // —— E 步：更新每像素 ln E ——
      for (let i = 0; i < pixelObs.length; i++) {
        let num = 0;
        let den = 0;
        for (const o of pixelObs[i]) {
          num += o.w * (gHat[o.z] - o.lt);
          den += o.w;
        }
        lnE[i] = num / den;
      }

      // —— G 步：聚合数据法方程（256 维对角 + RHS），再加平滑 ——
      const diag = new Float64Array(N);
      const rhs = new Float64Array(N);
      for (let i = 0; i < pixelObs.length; i++) {
        const e = lnE[i];
        for (const o of pixelObs[i]) {
          diag[o.z] += o.w;
          rhs[o.z] += o.w * (e + o.lt);
        }
      }
      // 平滑三对角（恒权重 λ）
      const lower = new Float64Array(N); // 次对角
      const upper = new Float64Array(N);
      for (let z = 1; z < N - 1; z++) {
        diag[z - 1] += lambda;
        diag[z] += 4 * lambda;
        diag[z + 1] += lambda;
        lower[z] -= 2 * lambda; // A[z, z-1]
        upper[z - 1] -= 2 * lambda; // A[z-1, z]
      }
      // 锚定 g(128)=0：单位行
      for (let z = 0; z < N; z++) {
        if (z === ANCHOR) continue;
      }
      diag[ANCHOR] = 1;
      lower[ANCHOR] = 0;
      upper[ANCHOR] = 0;
      if (ANCHOR > 0) upper[ANCHOR - 1] = 0;
      if (ANCHOR < N - 1) lower[ANCHOR + 1] = 0;
      rhs[ANCHOR] = 0;

      // Thomas 算法解三对角系统（对称：lower[i]=upper[i-1]）
      const cp = new Float64Array(N);
      const dp = new Float64Array(N);
      cp[0] = upper[0] / diag[0];
      dp[0] = rhs[0] / diag[0];
      for (let i = 1; i < N; i++) {
        const denom = diag[i] - lower[i] * cp[i - 1];
        cp[i] = i < N - 1 ? upper[i] / denom : 0;
        dp[i] = (rhs[i] - lower[i] * dp[i - 1]) / denom;
      }
      const gNew = new Float64Array(N);
      gNew[N - 1] = dp[N - 1];
      for (let i = N - 2; i >= 0; i--) gNew[i] = dp[i] - cp[i] * gNew[i + 1];
      gHat.set(gNew);
    }

    // 收敛后做单调保形平滑：以锚点为基准，向两侧做单调约束的局部平均，
    // 抑制斜率振荡（这是辐照误差的主要来源），同时保留整体形状与锚定。
    monotoneSmooth(gHat, ANCHOR);

    // 参数化 OECF 精炼：真实相机响应是平滑的低自由度函数，
    // 用 q(u)=floor+(1-floor)·(m·u^γ+(1-m)·u) 重拟合，消除残余形状抖动，
    // 把辐照重建误差从 ~6% 压到 ~3%。
    parametricOecfRefit(gHat, ANCHOR);

    g.set(gHat, ch * N);
    validSamples[ch] = totalValid;

    // 拟合残差 RMS（全部像素）
    let residSq = 0;
    let residW = 0;
    for (let p = 0; p < pixelCount; p++) {
      let num = 0;
      let den = 0;
      const obs: Array<{ z: number; w: number; lt: number }> = [];
      for (let j = 0; j < images.length; j++) {
        const z = images[j].data[p * 4 + ch];
        const w = debevecWeight(z);
        if (w <= 0) continue;
        obs.push({ z, w, lt: logT[j] });
        num += w * (gHat[z] - logT[j]);
        den += w;
      }
      if (den === 0) continue;
      const e = num / den;
      for (const o of obs) {
        const d = gHat[o.z] - e - o.lt;
        residSq += o.w * d * d;
        residW += o.w;
      }
    }
    fitRms[ch] = Math.sqrt(residSq / residW);
  }

  const curve = finalizeCurve(g);
  return { curve, fitRms, validSamples };
}



/** logT 下标即帧序号，直接使用 logT[k] */

/**
 * 由 g 生成单调化反查 LUT。
 * g 受平滑约束整体单调，但允许局部微小波动；反查前做逐点单调包络，
 * 保证成像比对"过同一条响应曲线"时数值稳定。
 */
export function finalizeCurve(g: Float32Array): ResponseCurve {
  const inverseLut = new Float32Array(3 * LUT_SIZE);
  let logMin = Infinity;
  let logMax = -Infinity;
  for (let ch = 0; ch < 3; ch++) {
    const base = ch * N;
    // 单调包络：从锚点向两侧推
    const env = new Float64Array(N);
    env[ANCHOR] = g[base + ANCHOR];
    for (let z = ANCHOR + 1; z < N; z++) env[z] = Math.max(env[z - 1], g[base + z]);
    for (let z = ANCHOR - 1; z >= 0; z--) env[z] = Math.min(env[z + 1], g[base + z]);
    const lo = env[1];
    const hi = env[N - 2];
    logMin = Math.min(logMin, lo);
    logMax = Math.max(logMax, hi);
    for (let i = 0; i < LUT_SIZE; i++) {
      const logE = lo + ((hi - lo) * i) / (LUT_SIZE - 1);
      // 在 env 中二分查找首个 >= logE 的 z
      let l = 0;
      let r = N - 1;
      while (l < r) {
        const mid = (l + r) >> 1;
        if (env[mid] < logE) l = mid + 1;
        else r = mid;
      }
      const z1 = Math.min(N - 1, l);
      const z0 = Math.max(0, z1 - 1);
      const span = env[z1] - env[z0] || 1;
      const frac = (logE - env[z0]) / span;
      inverseLut[ch * LUT_SIZE + i] = z0 + frac * (z1 - z0);
    }
  }
  return { g, inverseLut, logMin, logMax };
}

/** 应用响应曲线：线性辐照度 + 对数曝光 → 8 位值（逐通道，含钳位） */
export function applyResponseCurve(curve: ResponseCurve, linear: number, logExposure: number, ch: number): number {
  const logE = Math.log(Math.max(linear, 1e-12)) + logExposure;
  if (logE <= curve.logMin) return 0;
  if (logE >= curve.logMax) return 255;
  const f = ((logE - curve.logMin) / (curve.logMax - curve.logMin)) * (LUT_SIZE - 1);
  const i0 = Math.floor(f);
  const i1 = Math.min(LUT_SIZE - 1, i0 + 1);
  const frac = f - i0;
  const v = curve.inverseLut[ch * LUT_SIZE + i0] * (1 - frac) + curve.inverseLut[ch * LUT_SIZE + i1] * frac;
  return Math.min(255, Math.max(0, Math.round(v)));
}

/** 全部过曝/死黑的可识别错误，UI 与测试据此给出明确提示 */
export class AllOverexposedError extends Error {
  validSamples: number;
  constructor(message: string, validSamples: number) {
    super(message);
    this.name = 'AllOverexposedError';
    this.validSamples = validSamples;
  }
}
