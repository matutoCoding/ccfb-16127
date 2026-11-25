/**
 * 全局共享类型定义。
 * 全链路颜色数据分两类：
 *  - LDR：8 位 sRGB 编码图像（相机直出 / 响应曲线输出）
 *  - HDR：线性浮点辐照度图像（scene-linear，单位为相对辐照度，禁止先压成 8 位再处理）
 */

/** 线性高动态范围图像，RGB 交错 Float32，数值为 scene-linear 辐照度 */
export interface FloatImage {
  width: number;
  height: number;
  data: Float32Array;
}

/** 8 位低动态范围图像，RGBA 交错（A 恒为 255） */
export interface LdrImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  /** 拍摄时使用的对数曝光 t（log2 曝光值），用于 HDR 重建 */
  exposure: number;
}

/** 相机响应曲线 g：g[z] = 该 8 位亮度对应的对数曝光 ln(E)（锚定 g(127)=0） */
export interface ResponseCurve {
  /** 3 × 256，逐通道 */
  g: Float32Array;
  /** 反查用：把对数曝光映射回 8 位值的 LUT（逐通道 1024 级），由 g 单调化后生成 */
  inverseLut: Float32Array;
  /** inverseLut 每通道覆盖的 log 曝光区间 */
  logMin: number;
  logMax: number;
}

/** 多曝光对齐结果（相对参考帧的平移，像素，亚像素精度） */
export interface AlignmentResult {
  offsets: Array<{ dx: number; dy: number; score: number }>;
  referenceIndex: number;
}

/** 高光 / 过曝掩膜：1 表示该像素是角膜反光或全曝光过曝，不能参与取色 */
export interface MaskImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** HDR 重建完整产物（可持久化到 IndexedDB） */
export interface HdrCapture {
  id: string;
  patientId: string;
  eye: EyeSide;
  createdAt: number;
  exposures: number[];
  alignment: AlignmentResult;
  response: ResponseCurve;
  hdr: FloatImage;
  /** 高光/过曝掩膜 */
  specularMask: MaskImage;
  /** 输入照片缩略图（小尺寸 LDR，用于界面展示） */
  thumbnails: LdrImage[];
  /** 重建质量指标 */
  quality: HdrQuality;
}

export interface HdrQuality {
  /** 有效像素比例（未被过曝/死黑掩膜剔除） */
  validPixelRatio: number;
  /** 每通道响应曲线拟合残差（RMS，对数曝光单位） */
  fitRms: [number, number, number];
  /** 警告信息（如全部过曝、对齐失败） */
  warnings: string[];
}

export type EyeSide = 'left' | 'right';

/** 义眼台 / 眼窝情况 */
export type SocketCondition = 'enucleation' | 'evisceration' | 'atrophy' | 'congenital';
export type ImplantType = 'hydroxyapatite' | 'medpor' | 'silicone' | 'none' | 'other';

export interface Patient {
  id: string;
  name: string;
  /** 性别/年龄等基础信息 */
  gender: 'male' | 'female' | 'unknown';
  age: number;
  contact?: string;
  note?: string;
  /** 患侧（需要佩戴义眼的一侧） */
  affectedSide: EyeSide;
  /** 健侧 */
  healthySide: EyeSide;
  socketCondition: SocketCondition;
  implantType: ImplantType;
  /** 义眼片尺寸 mm */
  prosthesisWidthMm: number;
  prosthesisHeightMm: number;
  /** 厚度 mm */
  prosthesisThicknessMm: number;
  createdAt: number;
  updatedAt: number;
}

/** 单个颜料图层（真实颜料色号 + 遮盖比例） */
export interface PaintLayer {
  /** 层标识 */
  key: string;
  /** 颜料目录中的色号 id */
  pigmentId: string;
  /** 遮盖比例 0..1（技师涂布面积占该层区域的比例） */
  coverage: number;
  /** 不透明度 0..1 */
  opacity: number;
  /** 层专属参数（纤维数量、斑点半径等） */
  params: Record<string, number>;
}

/** 完整配色方案（分层） */
export interface PaintScheme {
  id: string;
  patientId: string;
  name: string;
  /** 1 底色层 */
  base: PaintLayer;
  /** 2 放射纹层 */
  fibers: PaintLayer;
  /** 3 卷缩轮 */
  collarette: PaintLayer;
  /** 4 色素斑 */
  spots: PaintLayer;
  /** 巩膜淡黄底色 */
  scleraBase: PaintLayer;
  /** 巩膜血管 */
  vessels: PaintLayer;
  /** 透明角膜凸面参数 */
  cornea: {
    /** 曲率半径相对值 0.5..2 */
    curvature: number;
    /** 折射率 */
    ior: number;
    /** 透明层厚度感（高光锐度）0..1 */
    gloss: number;
  };
  /** 固定瞳孔半径占虹膜半径比例 */
  pupilFraction: number;
  /** 优化得到的固定瞳孔直径 mm（四种场景综合最优） */
  fixedPupilMm?: number;
  /** 巩膜湿润光泽 0..1 */
  wetness: number;
  /** 随机种子（纤维/斑点/血管形态可复现） */
  seed: number;
  createdAt: number;
  note?: string;
}

/** 配色快照（每次调整留档） */
export interface PaintSnapshot {
  id: string;
  patientId: string;
  schemeId: string;
  label: string;
  scheme: PaintScheme;
  createdAt: number;
}

/** 四种观察场景 */
export type SceneId = 'clinic' | 'daylight' | 'warm' | 'flash';

export interface LightingScene {
  id: SceneId;
  name: string;
  /** 场景照度对数空间亮度（cd/m² 量级，用于瞳孔模型） */
  luminance: number;
  /** 白点（线性 RGB，max=1 归一），用于白平衡与场景染色 */
  whitePoint: [number, number, number];
  /** 主光方向（单位向量 x,y，屏幕空间） */
  lightDir: [number, number];
  /** 高光强度倍率 */
  specularGain: number;
  /** 环境光漫射倍率 */
  diffuseGain: number;
}

/** 虹膜环带色差结果 */
export interface RingMetric {
  ringIndex: number;
  /** 环带内径/外径（占虹膜半径比例） */
  rInner: number;
  rOuter: number;
  meanDeltaE: number;
  maxDeltaE: number;
  /** 是否超标 */
  exceeded: boolean;
  /** 像素数 */
  samples: number;
  /** 偏差方向（L/a/b 均值差），用于归因 */
  labShift: { dL: number; da: number; db: number };
}

export interface SceneComparison {
  sceneId: SceneId;
  /** 健侧过响应曲线后的 LDR（展示用，RGBA） */
  healthyLdr: LdrImage;
  /** 义眼渲染过同一响应曲线后的 LDR */
  prosthesisLdr: LdrImage;
  rings: RingMetric[];
  averageDeltaE: number;
  /** 健侧动态瞳孔直径 mm */
  healthyPupilMm: number;
}

export interface ComparisonReport {
  id: string;
  patientId: string;
  captureId: string;
  schemeId: string;
  createdAt: number;
  scenes: Record<SceneId, SceneComparison>;
  /** 超标环带的图层归因建议 */
  attributions: AttributionAdvice[];
  overallAverageDeltaE: number;
}

export interface AttributionAdvice {
  ringIndex: number;
  sceneId: SceneId;
  /** 推测出问题的图层 key */
  layerKey: string;
  layerName: string;
  /** 建议调整的颜料方向描述 */
  advice: string;
  deltaE: number;
}

/** 瞳孔优化结果 */
export interface PupilOptimization {
  /** 推荐固定瞳孔直径 mm */
  fixedPupilMm: number;
  perScene: Array<{
    sceneId: SceneId;
    healthyPupilMm: number;
    /** 采用固定值后该场景的外观代价（ΔE 量级） */
    residual: number;
  }>;
  totalCost: number;
}

export interface DeliveryRecord {
  id: string;
  patientId: string;
  schemeId: string;
  reportId: string;
  createdAt: number;
  /** 配色单（图层颜料 + 遮盖比例）的快照 */
  scheme: PaintScheme;
  /** 患者签名（dataURL） */
  signature?: string;
  /** 技师确认人 */
  technician: string;
  note?: string;
  archived: boolean;
}

export interface AppSettings {
  id: 'singleton';
  technicianName: string;
  studioName: string;
  /** 环带色差阈值（ΔE00），默认 3 */
  deltaEThreshold: number;
  /** HDR 重建平滑权重 λ */
  responseLambda: number;
  /** 渲染分辨率 */
  renderSize: number;
  /** 优先使用 WebGPU（关闭则强制 CPU 回退） */
  preferWebGpu: boolean;
}
