/**
 * 成像比对：渲染结果与健侧照片过同一条响应曲线、同一曝光/白平衡后，
 * 在虹膜同心环带上计算 CIEDE2000 色差，并把超标环带归因到具体颜料层。
 */
import type {
  AttributionAdvice,
  ComparisonReport,
  FloatImage,
  IrisGeometryLike,
  LightingScene,
  LdrImage,
  PaintScheme,
  ResponseCurve,
  RingMetric,
  SceneComparison,
  SceneId,
  MaskImage,
} from './types-compat';
import { deltaE00, linearRgbToLab, srgb8ToLinear, type RGB } from './color';
import { LIGHTING_SCENES, SCENE_ORDER } from '../render/scenes';
import { renderEye } from '../render/eyeModel';
import { healthyPupilMm, fixedPupilFraction } from '../render/pupil';
import { renderThroughCurve } from '../synth/camera';
import { STANDARD_IRIS_DIAMETER_MM } from '../render/scenes';
import { getPigment } from '../pigment/catalog';

/** 5 个同心环带（虹膜半径归一，跳过瞳孔区） */
export const RING_BANDS: Array<{ rInner: number; rOuter: number }> = [
  { rInner: 0.2, rOuter: 0.34 },
  { rInner: 0.34, rOuter: 0.5 },
  { rInner: 0.5, rOuter: 0.66 },
  { rInner: 0.66, rOuter: 0.82 },
  { rInner: 0.82, rOuter: 0.98 },
];

interface CompareSceneArgs {
  sceneId: SceneId;
  healthyHdr: FloatImage;
  healthyMask: MaskImage;
  geometry: IrisGeometryLike;
  scheme: PaintScheme;
  curve: ResponseCurve;
  ev: number;
  deltaEThreshold: number;
  renderSize: number;
}

/** 单场景比对：渲染 → 同曲线成像 → 环带 ΔE00 */
export function compareScene(args: CompareSceneArgs): SceneComparison {
  const { sceneId, healthyHdr, healthyMask, geometry, scheme, curve, ev, deltaEThreshold, renderSize } = args;
  const scene: LightingScene = LIGHTING_SCENES[sceneId];

  // 义眼：固定瞳孔，直接在目标场景光照下渲染
  const fixedFraction = scheme.fixedPupilMm
    ? fixedPupilFraction(scheme.fixedPupilMm)
    : scheme.pupilFraction;
  const prosthesis = renderEye(scheme, scene, { size: renderSize, pupilFractionOverride: fixedFraction });

  // 健侧：HDR 重建结果是在拍摄场景（诊室灯）光照下得到的，先归一化到中性反照率
  // （除掉诊室灯白点与漫射增益），再施加与义眼完全相同的目标场景光照，
  // 保证两侧光照路径对称，场景只改变观察条件、不制造系统性色差。
  const clinic = LIGHTING_SCENES.clinic;
  const neutral = rescaleLighting(healthyHdr, clinic.whitePoint, 1 / clinic.diffuseGain);
  const healthyScened = applySceneWhite(neutral, scene);

  // 同一条响应曲线、同一曝光成像
  const healthyLdr = renderThroughCurve(healthyScened, curve, ev);
  const prosthesisLdr = renderThroughCurve(prosthesis.hdr, curve, ev);

  const rings = computeRingMetrics(healthyLdr, prosthesisLdr, healthyMask, geometry, deltaEThreshold);
  const averageDeltaE = rings.reduce((s, r) => s + r.meanDeltaE, 0) / rings.length;

  return {
    sceneId,
    healthyLdr,
    prosthesisLdr,
    rings,
    averageDeltaE,
    healthyPupilMm: healthyPupilMm(sceneId),
  };
}

/** 逐通道线性光照缩放（HDR 域） */
function rescaleLighting(
  hdr: FloatImage,
  white: [number, number, number],
  gain: number,
): FloatImage {
  const out: FloatImage = { width: hdr.width, height: hdr.height, data: new Float32Array(hdr.data.length) };
  for (let p = 0; p < hdr.width * hdr.height; p++) {
    out.data[p * 3] = (hdr.data[p * 3] / white[0]) * gain;
    out.data[p * 3 + 1] = (hdr.data[p * 3 + 1] / white[1]) * gain;
    out.data[p * 3 + 2] = (hdr.data[p * 3 + 2] / white[2]) * gain;
  }
  return out;
}

/** 场景白点染色 + 光比（HDR 域线性乘法） */
function applySceneWhite(hdr: FloatImage, scene: LightingScene): FloatImage {
  return rescaleLighting(hdr, [1 / scene.whitePoint[0], 1 / scene.whitePoint[1], 1 / scene.whitePoint[2]], scene.diffuseGain);
}

/** 角膜镜面高光判定：LDR 三通道都接近饱和的亮白像素（光照反射，非颜料色） */
function isSpecularLdr(img: LdrImage, pixelIndex: number): boolean {
  const i = pixelIndex * 4;
  return img.data[i] >= 248 && img.data[i + 1] >= 248 && img.data[i + 2] >= 248;
}

/** 环带 ΔE00：LDR 解码回线性 → Lab → 逐像素 ΔE00，掩膜与角膜高光剔除 */
export function computeRingMetrics(
  healthyLdr: LdrImage,
  prosthesisLdr: LdrImage,
  mask: MaskImage,
  geometry: IrisGeometryLike,
  threshold: number,
): RingMetric[] {
  const { centerX, centerY, irisRadius, pupilRadius } = geometry;
  const pupilNorm = pupilRadius ? pupilRadius / irisRadius : 0.2;
  return RING_BANDS.map((band, ringIndex) => {
    let sum = 0;
    let max = 0;
    let samples = 0;
    let dL = 0;
    let da = 0;
    let db = 0;
    for (let y = 0; y < healthyLdr.height; y++) {
      for (let x = 0; x < healthyLdr.width; x++) {
        const r = Math.hypot(x - centerX, y - centerY) / irisRadius;
        if (r < band.rInner || r >= band.rOuter) continue;
        const pi = y * healthyLdr.width + x;
        if (mask.data[pi]) continue;
        // 角膜镜面高光：任一侧接近饱和亮白即剔除（亮斑是光照不是颜料）
        if (isSpecularLdr(healthyLdr, pi) || isSpecularLdr(prosthesisLdr, pi)) continue;
        const h = readLab(healthyLdr, pi);
        const q = readLab(prosthesisLdr, pi);
        const de = deltaE00(h, q);
        sum += de;
        max = Math.max(max, de);
        dL += q[0] - h[0];
        da += q[1] - h[1];
        db += q[2] - h[2];
        samples++;
      }
    }
    const mean = samples ? sum / samples : 0;
    return {
      ringIndex,
      rInner: Math.max(band.rInner, pupilNorm),
      rOuter: band.rOuter,
      meanDeltaE: Math.round(mean * 100) / 100,
      maxDeltaE: Math.round(max * 100) / 100,
      exceeded: mean > threshold,
      samples,
      labShift: {
        dL: samples ? Math.round((dL / samples) * 100) / 100 : 0,
        da: samples ? Math.round((da / samples) * 100) / 100 : 0,
        db: samples ? Math.round((db / samples) * 100) / 100 : 0,
      },
    };
  });
}

function readLab(img: LdrImage, pixelIndex: number): RGB {
  const i = pixelIndex * 4;
  const lin: RGB = [
    srgb8ToLinear(img.data[i]),
    srgb8ToLinear(img.data[i + 1]),
    srgb8ToLinear(img.data[i + 2]),
  ];
  return linearRgbToLab(lin);
}

/**
 * 图层归因：
 * 环带 0（瞳孔缘）→ 底色层；环带 1（卷缩轮区）→ 卷缩轮；
 * 环带 2-3（中周部）→ 放射纹层；环带 4（周边/角膜缘）→ 底色 + 色素斑；
 * 再按 Lab 偏移方向给出具体颜料调整话术。
 */
const RING_LAYER: Array<{ key: string; fallbackId: string }> = [
  { key: 'base', fallbackId: 'base' },
  { key: 'collarette', fallbackId: 'collarette' },
  { key: 'fibers', fallbackId: 'fibers' },
  { key: 'fibers', fallbackId: 'fibers' },
  { key: 'spots', fallbackId: 'base' },
];

export function attributeRings(report: { scenes: Record<SceneId, SceneComparison> }, scheme: PaintScheme): AttributionAdvice[] {
  const advices: AttributionAdvice[] = [];
  for (const sceneId of SCENE_ORDER) {
    const sc = report.scenes[sceneId];
    for (const ring of sc.rings) {
      if (!ring.exceeded) continue;
      const mapping = RING_LAYER[ring.ringIndex];
      const layerKey = mapping.key;
      const layer = (scheme as unknown as Record<string, { pigmentId: string }>)[layerKey] ?? scheme[mapping.fallbackId as keyof PaintScheme];
      const pigment = getPigment((layer as { pigmentId: string }).pigmentId);
      advices.push({
        ringIndex: ring.ringIndex,
        sceneId,
        layerKey,
        layerName: layerDisplayName(layerKey),
        advice: shiftAdvice(ring.labShift, pigment.name, pigment.code),
        deltaE: ring.meanDeltaE,
      });
    }
  }
  return advices;
}

function layerDisplayName(key: string): string {
  const names: Record<string, string> = {
    base: '虹膜底色层',
    fibers: '放射纹层',
    collarette: '卷缩轮层',
    spots: '色素斑层',
    scleraBase: '巩膜底色',
    vessels: '巩膜血管',
  };
  return names[key] ?? key;
}

function shiftAdvice(shift: { dL: number; da: number; db: number }, pigmentName: string, code: string): string {
  const parts: string[] = [];
  if (Math.abs(shift.dL) >= 0.8) parts.push(shift.dL > 0 ? '整体偏亮，应降低该层明度/遮盖比例' : '整体偏暗，应提高该层明度/遮盖比例');
  if (Math.abs(shift.da) >= 0.8) parts.push(shift.da > 0 ? '偏红，向绿相调整' : '偏绿，向红相调整');
  if (Math.abs(shift.db) >= 0.8) parts.push(shift.db > 0 ? '偏黄，向蓝相调整' : '偏蓝，向黄相调整');
  const dir = parts.length ? parts.join('；') : '色相接近但纹理密度/遮盖比例需要微调';
  return `${dir}（当前色号 ${code} ${pigmentName}）`;
}

export interface BuildReportArgs {
  id: string;
  patientId: string;
  captureId: string;
  schemeId: string;
  healthyHdr: FloatImage;
  healthyMask: MaskImage;
  geometry: IrisGeometryLike;
  scheme: PaintScheme;
  curve: ResponseCurve;
  ev: number;
  deltaEThreshold: number;
  renderSize: number;
  now?: number;
}

/** 四场景完整报告 */
export function buildComparisonReport(args: BuildReportArgs): ComparisonReport {
  const scenes = {} as Record<SceneId, SceneComparison>;
  for (const sceneId of SCENE_ORDER) {
    scenes[sceneId] = compareScene({
      sceneId,
      healthyHdr: args.healthyHdr,
      healthyMask: args.healthyMask,
      geometry: args.geometry,
      scheme: args.scheme,
      curve: args.curve,
      ev: args.ev,
      deltaEThreshold: args.deltaEThreshold,
      renderSize: args.renderSize,
    });
  }
  const partial = { scenes };
  const attributions = attributeRings(partial, args.scheme);
  const overall = SCENE_ORDER.reduce((s, id) => s + scenes[id].averageDeltaE, 0) / SCENE_ORDER.length;
  return {
    id: args.id,
    patientId: args.patientId,
    captureId: args.captureId,
    schemeId: args.schemeId,
    createdAt: args.now ?? Date.now(),
    scenes,
    attributions,
    overallAverageDeltaE: Math.round(overall * 100) / 100,
  };
}

export { STANDARD_IRIS_DIAMETER_MM };
