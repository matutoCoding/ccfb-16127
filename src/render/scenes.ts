/**
 * 四种标准观察场景。
 * luminance 为场景适应亮度（cd/m²），驱动瞳孔光反射模型；
 * whitePoint 为线性白点（参与白平衡与场景染色）。
 */
import type { LightingScene, SceneId } from '../core/types';
import { hexToLinearRgb } from '../core/color';

export const LIGHTING_SCENES: Record<SceneId, LightingScene> = {
  clinic: {
    id: 'clinic',
    name: '诊室灯',
    luminance: 300,
    whitePoint: hexToLinearRgb('#f4f6ff'),
    lightDir: [0.25, -0.6],
    specularGain: 1.6,
    diffuseGain: 1.0,
  },
  daylight: {
    id: 'daylight',
    name: '窗边日光',
    luminance: 2000,
    whitePoint: hexToLinearRgb('#fff7e8'),
    lightDir: [-0.55, -0.45],
    specularGain: 1.25,
    diffuseGain: 1.35,
  },
  warm: {
    id: 'warm',
    name: '暖色室内灯',
    luminance: 60,
    whitePoint: hexToLinearRgb('#ffe6c6'),
    lightDir: [0.4, -0.35],
    specularGain: 0.7,
    diffuseGain: 1.0,
  },
  flash: {
    id: 'flash',
    name: '手机闪光灯',
    luminance: 8000,
    whitePoint: hexToLinearRgb('#eef4ff'),
    lightDir: [0.05, -0.15],
    specularGain: 1.9,
    diffuseGain: 1.5,
  },
};

export const SCENE_ORDER: SceneId[] = ['clinic', 'daylight', 'warm', 'flash'];

/** 标准虹膜直径（mm），瞳孔直径换算基准，与患者档案的片子尺寸解耦 */
export const STANDARD_IRIS_DIAMETER_MM = 12;
