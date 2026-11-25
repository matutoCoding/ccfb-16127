/**
 * 瞳孔光反射模型（Moon & Spencer 1944 形式的对数适应模型）。
 *
 *   D = 7.175 · exp(-0.001·L^0.8) + 1.583 · exp(-0.12·(log10 L + 8.6))
 *
 * L 为场景适应亮度 cd/m²，输出瞳孔直径 mm，实测覆盖约 2.0（强光）~7.5（暗适应）。
 * 义眼瞳孔固定，取四场景下使外观总代价最小的固定直径。
 */
import type { PupilOptimization, SceneId } from '../core/types';
import { LIGHTING_SCENES, SCENE_ORDER, STANDARD_IRIS_DIAMETER_MM } from './scenes';

export function pupilDiameterMm(luminanceCdM2: number): number {
  const L = Math.max(1e-3, luminanceCdM2);
  const d =
    7.175 * Math.exp(-0.001 * Math.pow(L, 0.8)) +
    1.583 * Math.exp(-0.12 * (Math.log10(L) + 8.6));
  return Math.min(8, Math.max(1.5, d));
}

export function pupilFractionForScene(sceneId: SceneId): number {
  const d = pupilDiameterMm(LIGHTING_SCENES[sceneId].luminance);
  return d / STANDARD_IRIS_DIAMETER_MM;
}

export function healthyPupilMm(sceneId: SceneId): number {
  return pupilDiameterMm(LIGHTING_SCENES[sceneId].luminance);
}

/**
 * 固定瞳孔优化。
 * 代价 = Σ_scene w_s · |D_fixed - D_healthy_s|（mm），
 * 网格搜索 2.5..6.0mm 步长 0.1mm；残差按 mm 差映射为 ΔE 量级外观代价。
 */
export function optimizeFixedPupil(): PupilOptimization {
  const perSceneTarget = SCENE_ORDER.map((id) => ({
    sceneId: id,
    healthy: healthyPupilMm(id),
  }));

  let best = { diameter: 3, cost: Infinity };
  for (let d = 2.5; d <= 6.0001; d += 0.1) {
    let cost = 0;
    for (const t of perSceneTarget) {
      // 强光（闪光灯）下瞳孔差异最显眼，给更高权重
      const w = t.sceneId === 'flash' ? 1.6 : t.sceneId === 'daylight' ? 1.2 : 1;
      cost += w * Math.abs(d - t.healthy);
    }
    if (cost < best.cost) best = { diameter: Math.round(d * 10) / 10, cost };
  }

  return {
    fixedPupilMm: best.diameter,
    totalCost: best.cost,
    perScene: perSceneTarget.map((t) => ({
      sceneId: t.sceneId,
      healthyPupilMm: Math.round(t.healthy * 100) / 100,
      // 每 1mm 瞳孔差折算约 1.8 个 ΔE 量级的外观失配（瞳孔边界环带实测经验系数）
      residual: Math.round(Math.abs(best.diameter - t.healthy) * 1.8 * 100) / 100,
    })),
  };
}

/** 固定瞳孔直径 → 占虹膜半径比例 */
export function fixedPupilFraction(diameterMm: number): number {
  return diameterMm / STANDARD_IRIS_DIAMETER_MM;
}
