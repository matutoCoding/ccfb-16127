// 领域模型与图像基础类型 —— App / DB / 验收脚本共用

export interface RgbImage {
  width: number;
  height: number;
  data: Float32Array; // 打包 RGB，线性光，允许 >1（HDR）
}
export interface LdrImage {
  width: number;
  height: number;
  data: Uint8ClampedArray; // RGBA
}

// 正方形眼部裁切图上的归一化几何（各值 / size）
export interface EyeGeometry {
  cx: number;
  cy: number;
  irisR: number;
  pupilR: number;
}

export type Side = 'L' | 'R';

export interface Patient {
  id: string;
  code: string; // 档案编号
  name: string;
  prostheticSide: Side; // 术眼（戴义眼片）侧；健侧为对侧
  socketCondition: string; // 眼窝情况
  implantType: string; // 义眼台类型
  shellDiameterMm: number; // 义眼片直径
  thicknessMm: number; // 片子厚度
  irisDiameterMm: number; // 可见虹膜横径（用于像素↔mm）
  note: string;
  createdAt: number;
  updatedAt: number;
}

export interface FrameMeta {
  ev: number; // 相对曝光档
  exposureUs: number; // 曝光时间（相对单位也可，Debevec 用 ln）
  blobId?: string; // IDB blobs store key
  dataUrl?: string; // 小图直接内嵌（演示数据）
  width: number;
  height: number;
  shiftX?: number; // 对齐解算结果
  shiftY?: number;
  mismatch?: number; // 对齐后 MTB 残差
}

export interface ResponseCurve {
  // g[z] = ln(exposure)，z∈0..255，Debevec 反演结果
  g: number[];
  // 用于正向编码的反演采样：lnX -> z
  lnXMin: number;
  lnXMax: number;
  method: 'debevec-malik' | 'ground-truth';
  recoveredAt: number;
}

export interface HdrQuality {
  aligned: boolean;
  mtbErrorBefore: number;
  mtbErrorAfter: number;
  clippedFraction: number; // 虹膜 ROI 内饱和像素比例
  allOverexposed: boolean;
  usableFrames: number;
  message: string;
  // 仅合成数据自检时存在
  hdrRelError?: number;
  deltaE?: number;
}

export interface CaptureRecord {
  id: string;
  patientId: string;
  createdAt: number;
  source: 'synthetic' | 'upload';
  width: number;
  height: number;
  frames: FrameMeta[];
  referenceEv: number; // 与健侧照片比对所用的基准曝光档
  geometry: EyeGeometry;
  curve: ResponseCurve | null;
  wbGains: [number, number, number];
  // HDR Float32 RGB 的 ArrayBuffer（结构化克隆可直接存）
  hdrBuffer?: ArrayBuffer;
  highlightMask?: Uint8Array; // length = w*h，1=角膜高光过曝区
  quality: HdrQuality | null;
  datasetKind?: 'clean' | 'shaky' | 'blown';
  truth?: SyntheticTruthRef;
}

export interface SyntheticTruthRef {
  seed: number;
  archetype: string;
  // 验收用真值不进 UI 主流程；IDB 里保留便于设置页自检
  hdrRelError?: number;
  deltaE?: number;
}

// ---------- 配色方案 ----------
export interface PigmentMixItem {
  pigmentId: string;
  ratio: number; // 0..1，层内质量/遮盖占比
}

export interface RadialLayer {
  enabled: boolean;
  pigment: string;
  coverage: number; // 遮盖比例 0..1
  opacity: number;
  count: number; // 放射纹密度
  contrast: number;
  seed: number;
}
export interface CollaretteLayer {
  enabled: boolean;
  pigment: string;
  coverage: number;
  opacity: number;
  radius: number; // 相对虹膜半径
  width: number;
  irregularity: number;
  seed: number;
}
export interface SpotsLayer {
  enabled: boolean;
  pigment: string;
  coverage: number;
  opacity: number;
  count: number;
  seed: number;
}
export interface ScleraRegion {
  key: 'innerCanthus' | 'outerCanthus' | 'upper' | 'lower';
  label: string;
  yellow: number; // 淡黄底色强度
  vesselDensity: number;
  vesselPigment: string;
}
export interface ScleraLayer {
  basePigment: string;
  yellowPigment: string;
  baseYellow: number;
  wetness: number; // 湿润光泽
  vesselOpacity: number;
  regions: ScleraRegion[];
  seed: number;
}
export interface CorneaLayer {
  curvature: number; // 凸面曲率感
  gloss: number; // 高光锐度/强度
  fresnel: number;
  highlightX: number; // 高光位置（归一化）
  highlightY: number;
  highlightHdr: number; // 高光 HDR 强度
}

export interface IrisScheme {
  id: string;
  patientId: string;
  version: number;
  name: string;
  createdAt: number;
  note: string;
  bandCount: number;
  // 每环带底色（线性 RGB）与颜料配方 —— 验收 ΔE 的主拟合量
  bandRGB: [number, number, number][];
  bandMix: PigmentMixItem[][];
  // true 表示 bandRGB 是 HDR 闭环校准出的权威实测色；bandMix 是最近真实颜料配方。
  // 技师在界面手改颜料后该标记清除，bandRGB 改由 bandMix 混合得到。
  bandCalibrated?: boolean;
  // bandRGB/fitGain 所在的 HDR 归一化尺度；渲染时对虹膜环带以外材质乘此值以统一影调
  hdrScale?: number;
  baseOpacity: number;
  radial: RadialLayer;
  collarette: CollaretteLayer;
  spots: SpotsLayer;
  pupilDiameterMm: number | null; // null = 采用优化建议值
  sclera: ScleraLayer;
  cornea: CorneaLayer;
  depth: number; // 虹膜纵深（层间视差/AO）
  fittedFromCaptureId?: string;
  fitGain?: number; // 拟合得到的曝光/尺度标量，比对链路复用
}

export interface Snapshot {
  id: string;
  patientId: string;
  schemeId: string;
  version: number;
  createdAt: number;
  reason: string;
  scheme: IrisScheme;
  thumbnail?: string; // dataURL
  metrics?: SceneMetric[];
}

export interface SceneMetric {
  sceneId: string;
  sceneName: string;
  meanDeltaE: number;
  maxBandDeltaE: number;
  bandDeltaE: number[];
  failingBands: number[];
  layerAdvice: LayerAdvice[];
  pass: boolean;
}

export interface LayerAdvice {
  band: number;
  layer: string; // 层名
  direction: string; // 偏色方向描述
  suggestion: string; // 调整/颜料建议
  deltaE: number;
}

export interface DeliveryRecord {
  id: string;
  patientId: string;
  snapshotId: string;
  schemeVersion: number;
  createdAt: number;
  formulaRows: FormulaRow[];
  metrics: SceneMetric[];
  pupilMm: number;
  signatureDataUrl: string | null;
  compareImageDataUrl?: string;
  signedAt: number | null;
  note: string;
}

export interface FormulaRow {
  layer: string;
  pigmentCode: string;
  pigmentName: string;
  ciName: string;
  coveragePct: number;
}

export interface AppSettings {
  id: 'app';
  deltaEThreshold: number;
  hdrErrorThreshold: number; // %
  renderBackend: 'auto' | 'webgpu' | 'cpu';
  studioName: string;
  operator: string;
  seededAt?: number;
}

export interface SceneDef {
  id: string;
  name: string;
  kelvin: number;
  intensity: number; // 光照强度倍乘
  exposureEv: number; // 该场景推荐曝光补偿
  ambientLux: number; // 用于瞳孔估计
  flash: number; // 机载闪光灯强度 0..1
  lightDir: [number, number]; // 光源方向（屏幕空间 x,y）
  icon: string;
}
