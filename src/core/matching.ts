// 配色匹配引擎：HDR 环带 → 颜料配方迭代拟合；过完响应曲线后的 ΔE00 评估；
// 超标环带的层级归因；交付配色单生成。
import { clamp, deltaE2000, kelvinToLinear, linearToLab, type RGB, type Lab } from './color';
import { ringMeansCodes, ringMeansLinear } from './image';
import { renderEyeLinear } from './eyeRenderer';
import { encodeRadiance, sceneWbGains } from './pipeline';
import { solvePigmentMix } from './pigmentFit';
import { pigmentById, PIGMENTS } from './pigments';
import { SCENES, sceneById } from './scenes';
import { cloneScheme } from './schemeFactory';
import type {
  EyeGeometry, FormulaRow, IrisScheme, LayerAdvice, LdrImage, ResponseCurve, RgbImage, SceneMetric,
} from './types';

const CLINIC = sceneById('clinic');

function codesToLabs(codes: RGB[], curve: ResponseCurve): Lab[] {
  return codes.map((c) => {
    const lin = c.map((z) => Math.exp(curve.g[Math.max(0, Math.min(255, Math.round(z)))])) as RGB;
    return linearToLab(lin);
  });
}

// ---------- 曝光/尺度标量 ----------
export function solveGain(
  hdr: RgbImage,
  geom: EyeGeometry,
  targetCodes: RGB[],
  curve: ResponseCurve,
  wb: RGB,
  bandCount: number,
  highlightMask?: Uint8Array | null,
  validMask?: Uint8Array | null,
): number {
  const H = ringMeansLinear(hdr, geom, bandCount, highlightMask ?? null, validMask ?? null);
  const encoder = (lnX: number) => {
    // 轻量反查，避免反复构造
    const g = curve.g;
    if (lnX <= g[0]) return 0;
    if (lnX >= g[255]) return 255;
    let lo = 0, hi = 255;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (g[mid] <= lnX) lo = mid; else hi = mid;
    }
    const t = (lnX - g[lo]) / (g[lo + 1] - g[lo] || 1e-9);
    return lo + t;
  };
  const obj = (log2g: number) => {
    const gain = 2 ** log2g;
    let s = 0;
    for (let b = 0; b < bandCount; b++) {
      for (let c = 0; c < 3; c++) {
        const code = encoder(Math.log(Math.max(1e-8, H[b][c] * wb[c] * gain)));
        const d = code - targetCodes[b][c];
        s += d * d;
      }
    }
    return s;
  };
  let best = -2, bestV = Infinity;
  for (let lg = -12; lg <= 12; lg += 0.25) {
    const v = obj(lg);
    if (v < bestV) { bestV = v; best = lg; }
  }
  for (let lg = best - 0.5; lg <= best + 0.5; lg += 0.03) {
    const v = obj(lg);
    if (v < bestV) { bestV = v; best = lg; }
  }
  return 2 ** best;
}

// 按目标环带色相为纹理层挑选最接近的真实颜料，避免蓝眼叠褐纹这类模型冲突
function assignLayerPigments(scheme: IrisScheme, H: RGB[]) {
  const nearestPigment = (c: RGB) => {
    const lab = linearToLab(c);
    let best = PIGMENTS[0].id, bd = Infinity;
    for (const pg of PIGMENTS) {
      const d = deltaE2000(linearToLab(pg.lin), lab);
      if (d < bd) { bd = d; best = pg.id; }
    }
    return best;
  };
  const dark = H[1] ?? H[0];
  const midInner = H[2] ?? H[1];
  scheme.radial.pigment = nearestPigment(dark.map((v) => v * 0.55) as RGB);
  scheme.collarette.pigment = nearestPigment(midInner.map((v) => v * 0.8) as RGB);
  scheme.spots.pigment = nearestPigment(H[0].map((v) => v * 0.5) as RGB);
}

function logXAtCode(curve: ResponseCurve, zf: number): number {
  const z = Math.max(0, Math.min(254, zf));
  const i = Math.floor(z);
  const t = z - i;
  return curve.g[i] * (1 - t) + curve.g[i + 1] * t;
}

// ---------- 一键拟合 ----------
export interface FitOutcome {
  scheme: IrisScheme;
  gain: number;
  bandDeltaE: number[];
  meanDeltaE: number;
}

export function autoMatch(
  template: IrisScheme,
  hdr: RgbImage,
  photo: LdrImage,
  geom: EyeGeometry,
  curve: ResponseCurve,
  wb: RGB,
  opts: { highlightMask?: Uint8Array; validMask?: Uint8Array; irisDiameterMm: number; iterations?: number },
): FitOutcome {
  const scheme = cloneScheme(template);
  const B = scheme.bandCount;
  const targetCodes = ringMeansCodes(photo, geom, B, opts.highlightMask ?? null);

  // 尺度归一化：Debevec 曲线带整体尺度自由度，先把虹膜中位亮度规范到 ~0.2，
  // 可消除暗通道绝对下限/非线性项与大 gain 耦合造成的尺度不稳。
  const rawRingsForNorm = ringMeansLinear(hdr, geom, B, opts.highlightMask ?? null, opts.validMask ?? null);
  const lumas = rawRingsForNorm.map((c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]).filter((v) => v > 1e-5).sort((a, b) => a - b);
  const medianLuma = lumas[Math.floor(lumas.length / 2)] ?? 0.2;
  const normScale = Math.min(6, Math.max(0.15, 0.2 / medianLuma));
  const normHdr: RgbImage = {
    width: hdr.width, height: hdr.height,
    data: Float32Array.from(hdr.data, (v) => v * normScale),
  };

  const gain = solveGain(normHdr, geom, targetCodes, curve, wb, B, opts.highlightMask, opts.validMask);
  const H = ringMeansLinear(normHdr, geom, B, opts.highlightMask ?? null, opts.validMask ?? null);
  const light = kelvinToLinear(CLINIC.kelvin).map((v) => v * CLINIC.intensity) as RGB;

  for (let b = 0; b < B; b++) {
    scheme.bandRGB[b] = [
      Math.min(0.95, Math.max(1e-4, H[b][0] / light[0])),
      Math.min(0.95, Math.max(1e-4, H[b][1] / light[1])),
      Math.min(0.95, Math.max(1e-4, H[b][2] / light[2])),
    ];
  }
  assignLayerPigments(scheme, H);

  // 1) 线性 HDR 环带均值闭环
  for (let it = 0; it < 6; it++) {
    const rendered = renderEyeLinear(scheme, geom, { size: hdr.width, scene: CLINIC, irisDiameterMm: opts.irisDiameterMm });
    const M = ringMeansLinear(rendered, geom, B, opts.highlightMask ?? null);
    for (let b = 0; b < B; b++) {
      for (let c = 0; c < 3; c++) {
        const ratio = H[b][c] / Math.max(1e-5, M[b][c]);
        const k = Math.min(1.3, Math.max(0.77, ratio));
        scheme.bandRGB[b][c] = Math.min(0.995, Math.max(1e-4, scheme.bandRGB[b][c] * k));
      }
    }
  }

  // 2) 过响应曲线后的码值闭环：消除响应非线性与空间均值偏差
  for (let it = 0; it < 3; it++) {
    const rendered = renderEyeLinear(scheme, geom, { size: hdr.width, scene: CLINIC, irisDiameterMm: opts.irisDiameterMm });
    const coded = encodeRadiance(rendered, { curve, wb, gain });
    const candCodes = ringMeansCodes(coded, geom, B, opts.highlightMask ?? null);
    for (let b = 0; b < B; b++) {
      for (let c = 0; c < 3; c++) {
        const logRatio = logXAtCode(curve, targetCodes[b][c]) - logXAtCode(curve, candCodes[b][c]);
        const k = Math.exp(clamp(logRatio, -0.28, 0.28));
        scheme.bandRGB[b][c] = Math.min(0.995, Math.max(1e-4, scheme.bandRGB[b][c] * k));
      }
    }
  }

  // 3) 反解最接近的真实颜料配方（不覆盖权威 HDR 实测底色 bandRGB）。
  //    记录 hdrScale：bandRGB/gain 处于归一化尺度，皮肤、巩膜等绝对材质
  //    在渲染时对虹膜环带以外区域乘同一 hdrScale，保证整张照片影调一致。
  scheme.hdrScale = normScale;
  for (let b = 0; b < B; b++) {
    // 配方在物理尺度颜色上反解（深棕眼应得到黑/赭/褐，而不是归一化放大后的艳色）；
    // bandRGB 仍保留归一化权威色用于渲染。
    const physical: RGB = [
      Math.max(1e-4, scheme.bandRGB[b][0] / normScale),
      Math.max(1e-4, scheme.bandRGB[b][1] / normScale),
      Math.max(1e-4, scheme.bandRGB[b][2] / normScale),
    ];
    scheme.bandMix[b] = solvePigmentMix(physical, 4);
  }
  scheme.bandCalibrated = true;

  const metric = evaluateVsPhoto(scheme, photo, geom, curve, wb, gain, opts.irisDiameterMm, opts.highlightMask, 3);
  return { scheme, gain, bandDeltaE: metric.bandDeltaE, meanDeltaE: metric.meanDeltaE };
}

// ---------- 照片 ΔE 评估 ----------
export function evaluateVsPhoto(
  candidate: IrisScheme,
  photo: LdrImage,
  geom: EyeGeometry,
  curve: ResponseCurve,
  wb: RGB,
  gain: number,
  irisDiameterMm: number,
  highlightMask?: Uint8Array | null,
  threshold = 3,
): SceneMetric {
  const B = candidate.bandCount;
  const rendered = renderEyeLinear(candidate, geom, { size: photo.width, scene: CLINIC, irisDiameterMm });
  const coded = encodeRadiance(rendered, { curve, wb, gain });
  const aCodes = ringMeansCodes(coded, geom, B, highlightMask ?? null);
  const bCodes = ringMeansCodes(photo, geom, B, highlightMask ?? null);
  const aLabs = codesToLabs(aCodes, curve);
  const bLabs = codesToLabs(bCodes, curve);
  const bandDeltaE = aLabs.map((l, i) => deltaE2000(l, bLabs[i]));
  const meanDeltaE = bandDeltaE.reduce((a, b) => a + b, 0) / bandDeltaE.length;
  const failingBands = bandDeltaE.map((d, i) => (d > threshold ? i : -1)).filter((i) => i >= 0);
  const advice = diagnose(candidate, geom, aLabs, bLabs, bandDeltaE, failingBands, irisDiameterMm, curve, gain, wb);
  return {
    sceneId: 'clinic', sceneName: '诊室灯（健侧照片）',
    meanDeltaE, maxBandDeltaE: Math.max(...bandDeltaE), bandDeltaE, failingBands, layerAdvice: advice,
    pass: meanDeltaE < threshold,
  };
}

// ---------- 双方案四场景 ----------
export function evaluateScenes(
  candidate: IrisScheme,
  reference: IrisScheme,
  geom: EyeGeometry,
  curve: ResponseCurve,
  clinicGain: number,
  irisDiameterMm: number,
  threshold = 3,
): SceneMetric[] {
  const B = candidate.bandCount;
  const size = 300;
  return SCENES.map((scene) => {
    const wb = sceneWbGains(scene);
    const gainA = candidate.fitGain ?? clinicGain;
    const gainB = reference.fitGain ?? clinicGain;
    const renderA = renderEyeLinear(candidate, geom, { size, scene, irisDiameterMm });
    const renderB = renderEyeLinear(reference, geom, { size, scene, irisDiameterMm });
    const codeA = encodeRadiance(renderA, { curve, wb, gain: gainA, evOffset: scene.exposureEv });
    const codeB = encodeRadiance(renderB, { curve, wb, gain: gainB, evOffset: scene.exposureEv });
    const labsA = codesToLabs(ringMeansCodes(codeA, geom, B), curve);
    const labsB = codesToLabs(ringMeansCodes(codeB, geom, B), curve);
    const bandDeltaE = labsA.map((l, i) => deltaE2000(l, labsB[i]));
    const meanDeltaE = bandDeltaE.reduce((a, b) => a + b, 0) / bandDeltaE.length;
    const failingBands = bandDeltaE.map((d, i) => (d > threshold ? i : -1)).filter((i) => i >= 0);
    return {
      sceneId: scene.id, sceneName: scene.name,
      meanDeltaE, maxBandDeltaE: Math.max(...bandDeltaE), bandDeltaE, failingBands,
      layerAdvice: diagnose(candidate, geom, labsA, labsB, bandDeltaE, failingBands, irisDiameterMm, curve, clinicGain, wb, scene.id),
      pass: meanDeltaE < threshold,
    };
  });
}

// ---------- 层级诊断 ----------
function diagnose(
  candidate: IrisScheme,
  geom: EyeGeometry,
  candLabs: Lab[],
  targetLabs: Lab[],
  bandDE: number[],
  failing: number[],
  irisDiameterMm: number,
  curve: ResponseCurve,
  gain: number,
  wb: RGB,
  sceneId = 'clinic',
): LayerAdvice[] {
  if (!failing.length) return [];
  const size = 200;
  const scene = sceneById(sceneId);
  const bandLabsOf = (sch: IrisScheme): Lab[] => {
    const r = renderEyeLinear(sch, geom, { size, scene, irisDiameterMm });
    const c = encodeRadiance(r, { curve, wb, gain, evOffset: scene.exposureEv });
    return codesToLabs(ringMeansCodes(c, geom, sch.bandCount), curve);
  };
  const full = bandLabsOf(candidate);
  const noRadial = cloneScheme(candidate); noRadial.radial.enabled = false;
  const noColl = cloneScheme(candidate); noColl.collarette.enabled = false;
  const noSpots = cloneScheme(candidate); noSpots.spots.enabled = false;
  const variants: { layer: string; labs: Lab[] }[] = [
    { layer: '放射纹层', labs: bandLabsOf(noRadial) },
    { layer: '卷缩轮层', labs: bandLabsOf(noColl) },
    { layer: '色素斑层', labs: bandLabsOf(noSpots) },
  ];

  const advice: LayerAdvice[] = [];
  for (const b of failing.slice(0, 4)) {
    // 残差：目标 - 当前
    const dL = targetLabs[b][0] - candLabs[b][0];
    const da = targetLabs[b][1] - candLabs[b][1];
    const db = targetLabs[b][2] - candLabs[b][2];

    // 层影响向量（关掉该层造成的 Lab 变化），与所需修正做方向匹配
    let bestLayer = '底色层';
    let bestScore = 0;
    for (const v of variants) {
      const eff: Lab = [v.labs[b][0] - full[b][0], v.labs[b][1] - full[b][1], v.labs[b][2] - full[b][2]];
      // 增强该层 ≈ -eff；若所需残差与 -eff 同向，说明该层偏弱
      const align = -(eff[0] * dL + eff[1] * da + eff[2] * db);
      const mag = Math.hypot(...eff);
      const score = mag * (0.5 + Math.max(-1, Math.min(1, align / (mag * (Math.hypot(dL, da, db) || 1) || 1))));
      if (score > bestScore && mag > 0.4) { bestScore = score; bestLayer = v.layer; }
    }
    // 位置规则补强
    if (b <= 2 && bestLayer === '底色层') bestLayer = '卷缩轮层';
    if (b >= 3 && b <= 5 && bestScore < 1.2) bestLayer = '放射纹层';

    const parts: string[] = [];
    let suggestion = '';
    if (dL > 1.2) parts.push('偏深');
    if (dL < -1.2) parts.push('偏浅');
    if (da > 1.0) parts.push('偏绿/青');
    if (da < -1.0) parts.push('偏红');
    if (db > 1.2) parts.push('偏蓝灰');
    if (db < -1.2) parts.push('偏黄/暖');
    const bias = parts.length ? `当前环带${parts.join('、')}` : '色相有偏差';

    if (dL > 1.2) suggestion = '减少象牙黑/熟褐比例，或在底色中薄涂钛白提亮';
    else if (dL < -1.2) suggestion = '提高象牙黑或生褐比例压暗，降低钛白遮盖';
    else if (db < -1.2) suggestion = '底色加少量群青(B-02)互补压黄，或降低土黄/赭石比例';
    else if (db > 1.2) suggestion = '降低群青/酞菁蓝，加土黄(Y-07)或生赭暖底';
    else if (da < -1.0) suggestion = '降低氧化铁红/绛红，补少量氧化铬绿';
    else if (da > 1.0) suggestion = '加氧化铁红(R-05)或赭石，压掉青绿';
    else suggestion = `微调${bestLayer}主颜料的遮盖比例后重新比对`;

    advice.push({
      band: b, layer: bestLayer, direction: bias, suggestion, deltaE: bandDE[b],
    });
  }
  return advice;
}

// ---------- 配色单 ----------
export function buildFormula(scheme: IrisScheme): FormulaRow[] {
  const rows: FormulaRow[] = [];
  const B = scheme.bandCount;
  // 环带面积权重（等径向间隔，面积 ∝ r_out²-r_in²）
  const w: number[] = [];
  for (let b = 0; b < B; b++) {
    w.push(((b + 1) ** 2 - b ** 2));
  }
  const wSum = w.reduce((a, x) => a + x, 0);
  const agg = new Map<string, number>();
  for (let b = 0; b < B; b++) {
    for (const it of scheme.bandMix[b]) {
      agg.set(it.pigmentId, (agg.get(it.pigmentId) ?? 0) + it.ratio * (w[b] / wSum));
    }
  }
  for (const [pid, ratio] of [...agg.entries()].sort((a, b) => b[1] - a[1])) {
    const pg = pigmentById(pid);
    rows.push({
      layer: '虹膜底色层', pigmentCode: pg.studioCode, pigmentName: pg.name, ciName: pg.ci,
      coveragePct: Math.round(ratio * scheme.baseOpacity * 1000) / 10,
    });
  }
  const addSimple = (layer: string, pid: string, cov: number) => {
    if (cov <= 0.15) return;
    const pg = pigmentById(pid);
    rows.push({
      layer, pigmentCode: pg.studioCode, pigmentName: pg.name, ciName: pg.ci,
      coveragePct: Math.round(cov * 10) / 10,
    });
  };
  addSimple('放射纹层', scheme.radial.pigment, scheme.radial.coverage * scheme.radial.opacity * 78);
  const rc = scheme.collarette;
  const annulus = Math.max(0.02, ((rc.radius + rc.width) ** 2 - (rc.radius - rc.width) ** 2) / Math.max(0.2, 1 - 0.16));
  addSimple('卷缩轮层', rc.pigment, Math.min(80, annulus * 100 * rc.coverage * rc.opacity * 2.2));
  addSimple('色素斑层', scheme.spots.pigment, scheme.spots.coverage * scheme.spots.opacity * 100);
  addSimple('巩膜底色层', scheme.sclera.basePigment, 92);
  addSimple('巩膜淡黄底', scheme.sclera.yellowPigment, scheme.sclera.baseYellow * 60);
  const avgVesselDensity = scheme.sclera.regions.reduce((a, r) => a + r.vesselDensity, 0) / scheme.sclera.regions.length;
  addSimple('巩膜血管', scheme.sclera.regions[0].vesselPigment, scheme.sclera.vesselOpacity * avgVesselDensity * 22);
  rows.push({
    layer: '角膜凸面层', pigmentCode: '—', pigmentName: '透明角膜胶（不加颜料）', ciName: 'clear PMMA',
    coveragePct: 100,
  });
  return rows;
}
