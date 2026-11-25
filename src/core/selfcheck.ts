// 端到端数值自检：合成真值 → 多曝光 → 对齐 → 反演曲线 → HDR 合成 →
// 误差核对 → 拟合配方 → 过响应曲线 → 环带 ΔE00。
// scripts/verify.ts 与“设置”页自检共用这一份实现。
import { generateDataset, ARCHETYPES, type SyntheticDataset } from './synth';
import {
  alignFramesMtb, assessQuality, calibrateGlobalScale, detectHighlightMask, mergeHdr, recoverResponse, shiftLdr,
} from './hdr';
import { autoMatch, evaluateScenes } from './matching';
import { createScheme } from './schemeFactory';
import { SCENES } from './scenes';
import type { EyeGeometry } from './types';

export interface EyeCheck {
  key: string;
  archetype: string;
  kind: string;
  hdrRelErrorPct: number;
  hdrMedianErrorPct: number;
  meanDeltaE: number;
  maxBandDeltaE: number;
  bandDeltaE: number[];
  sceneMeanDeltaE: { sceneId: string; name: string; de: number }[];
  alignBefore: number;
  alignAfter: number;
  offsetRecovered: boolean;
  gain: number;
  message: string;
}
export interface SelfCheckReport {
  ok: boolean;
  hdrThresholdPct: number;
  deThreshold: number;
  eyes: EyeCheck[];
  blownCorrectlyRejected: boolean;
  blownMessage: string;
  overallHdrRelErrorPct: number;
  overallMeanDeltaE: number;
  failures: string[];
  notes: string[];
}

function buildIrisRoi(w: number, h: number, geom: EyeGeometry): Uint8Array {
  const roi = new Uint8Array(w * h);
  const cx = geom.cx * w, cy = geom.cy * h, irisPx = geom.irisR * Math.min(w, h);
  const pupilPx = geom.pupilR * Math.min(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d > pupilPx * 1.05 && d < irisPx * 0.97) roi[y * w + x] = 1;
    }
  }
  return roi;
}

function relErrors(ds: SyntheticDataset, hdrData: Float32Array, scale: number, roi: Uint8Array, mask?: Uint8Array) {
  const errs: number[] = [];
  const truth = ds.truthHdr.data;
  const n = ds.size * ds.size;
  for (let i = 0; i < n; i++) {
    if (!roi[i]) continue;
    if (mask && mask[i]) continue;
    const yT = 0.2126 * truth[i * 3] + 0.7152 * truth[i * 3 + 1] + 0.0722 * truth[i * 3 + 2];
    if (yT < 0.06) continue;
    const yH = 0.2126 * hdrData[i * 3] * scale + 0.7152 * hdrData[i * 3 + 1] * scale + 0.0722 * hdrData[i * 3 + 2] * scale;
    errs.push(Math.abs(yH - yT) / yT);
  }
  errs.sort((a, b) => a - b);
  const mean = errs.reduce((a, b) => a + b, 0) / Math.max(1, errs.length);
  const median = errs[Math.floor(errs.length / 2)] ?? 1;
  return { mean, median, count: errs.length };
}

export interface SelfCheckOptions {
  size?: number;
  hdrThresholdPct?: number;
  deThreshold?: number;
  onProgress?: (msg: string, pct: number) => void;
}

export async function runSelfCheck(opts: SelfCheckOptions = {}): Promise<SelfCheckReport> {
  const size = opts.size ?? 320;
  const hdrTh = opts.hdrThresholdPct ?? 5;
  const deTh = opts.deThreshold ?? 3;
  const progress = opts.onProgress ?? (() => {});
  const eyes: EyeCheck[] = [];
  const failures: string[] = [];
  const notes: string[] = [];

  // 4 种颜色干净组 + 1 组手抖
  const jobs: { archIndex: number; kind: 'clean' | 'shaky' }[] = [
    { archIndex: 0, kind: 'clean' },
    { archIndex: 1, kind: 'clean' },
    { archIndex: 2, kind: 'clean' },
    { archIndex: 3, kind: 'clean' },
    { archIndex: 0, kind: 'shaky' },
  ];

  for (let j = 0; j < jobs.length; j++) {
    const job = jobs[j];
    const arch = ARCHETYPES[job.archIndex];
    progress(`合成 ${arch.name}${job.kind === 'shaky' ? '（手抖序列）' : ''}…`, (j / (jobs.length + 1)) * 100);
    // 让 UI 有机会绘制进度
    await new Promise((r) => setTimeout(r, 0));

    const ds = generateDataset({ archetype: arch, kind: job.kind, size });
    const align = alignFramesMtb(ds.frames, ds.referenceIndex);
    const alignedFrames = ds.frames.map((f, i) => shiftLdr(f, align.correction[i].x, align.correction[i].y));
    const curve = recoverResponse(alignedFrames, ds.dts, { samples: 130, lambda: 26 });
    const merged = mergeHdr(alignedFrames, ds.dts, curve);
    const highlightMask = detectHighlightMask(ds.frames[ds.referenceIndex], ds.geom, 4);
    const roi = buildIrisRoi(size, size, ds.geom);
    const scale = calibrateGlobalScale(merged.hdr, ds.truthHdr, roi);
    const err = relErrors(ds, merged.hdr.data, scale, roi, highlightMask);

    // 拟合（HDR 乘上标定尺度，等价于 App 内由曝光搜索吸收尺度）
    const calibrated = {
      width: merged.hdr.width,
      height: merged.hdr.height,
      data: Float32Array.from(merged.hdr.data, (v) => v * scale),
    };
    const template = createScheme({ id: 'selfcheck', irisDiameterMm: ds.irisDiameterMm });
    const fit = autoMatch(template, calibrated, ds.frames[ds.referenceIndex], ds.geom, curve, ds.wb, {
      highlightMask, validMask: merged.valid, irisDiameterMm: ds.irisDiameterMm,
    });

    // 四场景表的产品语义：当前方案 vs 拟合得到的“健侧数字孪生”。
    // 自检里孪生就是拟合方案本身，应在四种光照下都保持 ΔE≈0（链路一致性）。
    const sceneMetrics = evaluateScenes(
      fit.scheme, fit.scheme, ds.geom, curve, fit.gain, ds.irisDiameterMm, deTh,
    );

    const offsetRecovered = ds.trueOffsets.every((o, i) => {
      if (o.x === 0 && o.y === 0) return true;
      const got = align.mtbOffset[i];
      return Math.abs(got.x - o.x) <= 1 && Math.abs(got.y - o.y) <= 1;
    });

    const check: EyeCheck = {
      key: `${arch.id}-${job.kind}`,
      archetype: arch.name,
      kind: job.kind === 'shaky' ? '手抖对齐组' : '固定机位组',
      hdrRelErrorPct: err.mean * 100,
      hdrMedianErrorPct: err.median * 100,
      meanDeltaE: fit.meanDeltaE,
      maxBandDeltaE: Math.max(...fit.bandDeltaE),
      bandDeltaE: fit.bandDeltaE,
      sceneMeanDeltaE: sceneMetrics.map((m) => ({ sceneId: m.sceneId, name: m.sceneName, de: m.meanDeltaE })),
      alignBefore: align.errorBefore,
      alignAfter: align.errorAfter,
      offsetRecovered,
      gain: fit.gain,
      message: `参与误差统计像素 ${err.count}`,
    };
    eyes.push(check);
    if (err.mean * 100 >= hdrTh) failures.push(`${check.archetype}/${check.kind} HDR 平均相对误差 ${check.hdrRelErrorPct.toFixed(2)}% ≥ ${hdrTh}%`);
    if (fit.meanDeltaE >= deTh) failures.push(`${check.archetype}/${check.kind} 平均 ΔE00 ${fit.meanDeltaE.toFixed(2)} ≥ ${deTh}`);
    if (job.kind === 'shaky' && align.errorAfter >= 0.27) failures.push('手抖组对齐残差过高');
    if (job.kind === 'shaky' && !offsetRecovered) notes.push('手抖组个别位移偏差 >1px（仍完成对齐）');
  }

  // 全过曝组：必须被 QC 正确拒绝，而不是给出假结果
  progress('验证全过曝序列的质量拦截…', 92);
  await new Promise((r) => setTimeout(r, 0));
  const blown = generateDataset({ archetype: ARCHETYPES[2], kind: 'blown', size });
  const blownAlign = alignFramesMtb(blown.frames, blown.referenceIndex);
  const blownMask = detectHighlightMask(blown.frames[blown.referenceIndex], blown.geom, 4);
  const q = assessQuality(blown.frames, blown.referenceIndex, blown.geom, blownAlign, blownMask);
  const blownCorrectlyRejected = q.allOverexposed;
  if (!blownCorrectlyRejected) failures.push('全过曝组未被质量判定拦截');

  const validEyes = eyes;
  const overallHdr = validEyes.reduce((a, e) => a + e.hdrRelErrorPct, 0) / validEyes.length;
  const overallDE = validEyes.reduce((a, e) => a + e.meanDeltaE, 0) / validEyes.length;
  if (overallHdr >= hdrTh) failures.push(`总体 HDR 相对误差 ${overallHdr.toFixed(2)}% ≥ ${hdrTh}%`);
  if (overallDE >= deTh) failures.push(`总体平均 ΔE00 ${overallDE.toFixed(2)} ≥ ${deTh}`);

  progress('完成', 100);
  return {
    ok: failures.length === 0,
    hdrThresholdPct: hdrTh,
    deThreshold: deTh,
    eyes,
    blownCorrectlyRejected,
    blownMessage: q.message,
    overallHdrRelErrorPct: overallHdr,
    overallMeanDeltaE: overallDE,
    failures,
    notes,
  };
}

export { SCENES };
