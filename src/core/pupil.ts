// 瞳孔场景估计与固定瞳孔尺寸优化
// 健侧瞳孔随环境亮度缩放；义眼片瞳孔画死，需要选一个在四种场景下
// 总体最接近健侧的固定直径。
import type { SceneDef } from './types';

// 简化的瞳孔对光反射曲线（mm）。形状参考 Watson–Yekimov 型幂律：
// L 为适应亮度 cd/m²，越亮瞳孔越小。
// d(L) = dMin + (dMax-dMin) / (1 + (L/L0)^k)
export function pupilDiameterAtLuminance(
  cdPerM2: number,
  dMin = 2.4,
  dMax = 7.2,
  l0 = 120,
  k = 0.42,
): number {
  const L = Math.max(0.01, cdPerM2);
  return dMin + (dMax - dMin) / (1 + Math.pow(L / l0, k));
}

// 环境照度 lux -> 视野适应亮度 cd/m² 的粗略换算（灰/白环境反射）
export function luxToAdaptationLuminance(lux: number): number {
  return (lux * 0.4) / Math.PI;
}

export interface PupilEstimate {
  sceneId: string;
  sceneName: string;
  healthyMm: number; // 该场景下健侧估计瞳孔
  fixedMm: number; // 当前建议固定值
  diffMm: number;
}

// 用拍摄时实测瞳孔直径标定曲线的整体偏移，再推四种场景
export function estimateScenePupils(
  measuredCaptureMm: number,
  captureLux: number,
  scenes: SceneDef[],
): { estimates: { sceneId: string; sceneName: string; healthyMm: number }[]; offset: number } {
  const captureL = luxToAdaptationLuminance(captureLux);
  const modelAtCapture = pupilDiameterAtLuminance(captureL);
  const offset = measuredCaptureMm - modelAtCapture;
  const estimates = scenes.map((s) => ({
    sceneId: s.id,
    sceneName: s.name,
    healthyMm: clampMm(pupilDiameterAtLuminance(luxToAdaptationLuminance(s.ambientLux)) + offset),
  }));
  return { estimates, offset };
}

function clampMm(v: number) {
  return Math.max(2.0, Math.min(8.0, v));
}

// 选固定瞳孔：最小化四种场景误差的平方和（也报告最大误差）
export function optimizeFixedPupil(
  healthyByScene: number[],
): { bestMm: number; rms: number; worst: number; curve: { mm: number; rms: number; worst: number }[] } {
  let bestMm = healthyByScene.reduce((a, b) => a + b, 0) / healthyByScene.length;
  let bestRms = Infinity;
  const curve: { mm: number; rms: number; worst: number }[] = [];
  for (let mm = 2.5; mm <= 6.5001; mm += 0.05) {
    let sum2 = 0;
    let worst = 0;
    for (const h of healthyByScene) {
      const d = mm - h;
      sum2 += d * d;
      worst = Math.max(worst, Math.abs(d));
    }
    const rms = Math.sqrt(sum2 / healthyByScene.length);
    curve.push({ mm: Math.round(mm * 100) / 100, rms, worst });
    // RMS + 轻微 minimax 加权，避免某一场景明显失真
    const score = rms + 0.15 * worst;
    if (score < bestRms) {
      bestRms = score;
      bestMm = mm;
    }
  }
  let rms2 = 0, worst2 = 0;
  for (const h of healthyByScene) {
    rms2 += (bestMm - h) ** 2;
    worst2 = Math.max(worst2, Math.abs(bestMm - h));
  }
  return { bestMm: Math.round(bestMm * 100) / 100, rms: Math.sqrt(rms2 / healthyByScene.length), worst: worst2, curve };
}
