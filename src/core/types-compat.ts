/** 兼容类型出口：comparison 同时被核心层与 UI 引用，避免与 core/types 形成环 */
export type {
  AttributionAdvice,
  ComparisonReport,
  FloatImage,
  LightingScene,
  LdrImage,
  MaskImage,
  PaintScheme,
  ResponseCurve,
  RingMetric,
  SceneComparison,
  SceneId,
} from './types';

export interface IrisGeometryLike {
  centerX: number;
  centerY: number;
  irisRadius: number;
  pupilRadius?: number;
}
