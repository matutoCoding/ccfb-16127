/**
 * 合成测试数据集。
 *
 * 生成 5 种虹膜颜色的健侧眼，每只产出 3~5 张不同曝光的 LDR 序列，
 * 场景辐照度真值（q(0.5) 归一）随数据集一并保留，供 5% 辐照度验收。
 * 另含两组异常：
 *   - 手抖失配组：其中两帧带随机平移，对齐模块应给出低置信度警告；
 *   - 全部过曝组：所有帧 EV 上移到全饱和，响应曲线恢复应抛 AllOverexposedError。
 */
import type { FloatImage, LdrImage, MaskImage, PaintScheme } from '../core/types';
import { defaultPaintScheme, renderEye, irisGeometry } from '../render/eyeModel';
import { LIGHTING_SCENES } from '../render/scenes';
import { shoot, trueResponseCurve } from './camera';
import { detectSpecularMask } from '../hdr/specular';
import { mulberry32 } from '../core/rng';
import { makeMask } from '../core/image';

export interface SyntheticIrisCase {
  key: string;
  label: string;
  scheme: PaintScheme;
}

export const SYNTHETIC_IRIS_CASES: SyntheticIrisCase[] = [
  makeCase('brown-deep', '深棕眼', {
    base: 'base-brown-deep',
    fibers: 'fiber-rust',
    collarette: 'collar-rust',
    spots: 'spot-darkbrown',
    seed: 11001,
  }),
  makeCase('hazel', '榛褐眼', {
    base: 'base-hazel',
    fibers: 'fiber-amber',
    collarette: 'collar-gold',
    spots: 'spot-rust',
    seed: 22002,
  }),
  makeCase('green', '橄榄绿眼', {
    base: 'base-green-olive',
    fibers: 'fiber-teal',
    collarette: 'collar-olive',
    spots: 'spot-darkbrown',
    seed: 33003,
  }),
  makeCase('blue', '灰蓝眼', {
    base: 'base-blue-grey',
    fibers: 'fiber-slate',
    collarette: 'collar-blue',
    spots: 'spot-charcoal',
    seed: 44004,
  }),
  makeCase('grey', '石板灰眼', {
    base: 'base-grey',
    fibers: 'fiber-navy',
    collarette: 'collar-blue',
    spots: 'spot-charcoal',
    seed: 55005,
  }),
];

function makeCase(
  key: string,
  label: string,
  pick: { base: string; fibers: string; collarette: string; spots: string; seed: number },
): SyntheticIrisCase {
  const scheme = defaultPaintScheme(`synth-${key}`, pick.seed);
  scheme.name = label;
  scheme.base.pigmentId = pick.base;
  scheme.fibers.pigmentId = pick.fibers;
  scheme.collarette.pigmentId = pick.collarette;
  scheme.spots.pigmentId = pick.spots;
  return { key, label, scheme };
}

export interface SyntheticSequence {
  caseKey: string;
  label: string;
  size: number;
  /** 真值场景辐照度（q(0.5) 归一，与恢复结果同尺度） */
  groundTruthHdr: FloatImage;
  /** 真值高光掩膜 */
  groundTruthMask: MaskImage;
  /** 多曝光 LDR 序列 */
  frames: LdrImage[];
  /** 对应 EV */
  exposures: number[];
  curve: ReturnType<typeof trueResponseCurve>;
  /** 合成时人为注入的手抖偏移（帧序号 → 像素偏移） */
  injectedShifts: Array<{ dx: number; dy: number }>;
  /** 异常标记 */
  anomaly?: 'handshake' | 'all-overexposed';
}

const DEFAULT_EVS = [-2, -1, 0, 1, 2];

export interface GenerateOptions {
  size?: number;
  evs?: number[];
  anomaly?: 'handshake' | 'all-overexposed';
  seedBase?: number;
}

/** 生成一只健侧眼的完整多曝光序列（含真值） */
export function generateSyntheticSequence(irisCase: SyntheticIrisCase, opts: GenerateOptions = {}): SyntheticSequence {
  const size = opts.size ?? 128;
  const evs = opts.evs ?? DEFAULT_EVS;
  const scene = LIGHTING_SCENES.clinic;
  const { hdr: groundTruthHdr } = renderEye(irisCase.scheme, scene, { size });
  const curve = trueResponseCurve();

  // 真值掩膜：先按正常曝光拍一组再检测，保证掩膜逻辑与生产路径一致
  const probeFrames = evs.map((ev, j) => shoot(groundTruthHdr, { ev, seed: irisCase.scheme.seed + j * 101 }));
  const groundTruthMask = detectSpecularMask(probeFrames);

  let useEvs = evs;
  if (opts.anomaly === 'all-overexposed') {
    useEvs = evs.map((ev) => ev + 6); // 全部推到饱和
  }

  const rand = mulberry32((opts.seedBase ?? 7000) + irisCase.scheme.seed);
  const injectedShifts: Array<{ dx: number; dy: number }> = [];
  const frames: LdrImage[] = useEvs.map((ev, j) => {
    let dx = 0;
    let dy = 0;
    if (opts.anomaly === 'handshake' && (j === 1 || j === 3)) {
      // 真实手持拍摄的失配量级：±6px 平移，方向随机且不触搜索半径(12)边界
      dx = (rand() - 0.5) * 12;
      dy = (rand() - 0.5) * 12;
    }
    injectedShifts.push({ dx, dy });
    return shoot(groundTruthHdr, {
      ev,
      seed: irisCase.scheme.seed + j * 101 + (opts.anomaly ? 9000 : 0),
      shiftX: dx,
      shiftY: dy,
    });
  });

  return {
    caseKey: irisCase.key,
    label: irisCase.label,
    size,
    groundTruthHdr,
    groundTruthMask,
    frames,
    exposures: useEvs,
    curve,
    injectedShifts,
    anomaly: opts.anomaly,
  };
}

/** 全量演示数据集：5 只正常 + 1 组手抖（榛褐眼）+ 1 组全过曝（深棕眼） */
export function generateDemoDataset(size = 128): {
  normal: SyntheticSequence[];
  handshake: SyntheticSequence;
  allOverexposed: SyntheticSequence;
} {
  const normal = SYNTHETIC_IRIS_CASES.map((c) => generateSyntheticSequence(c, { size }));
  const handshake = generateSyntheticSequence(SYNTHETIC_IRIS_CASES[1], { size, anomaly: 'handshake' });
  const allOverexposed = generateSyntheticSequence(SYNTHETIC_IRIS_CASES[0], { size, anomaly: 'all-overexposed' });
  return { normal, handshake, allOverexposed };
}

/** 取序列对应眼睛的虹膜几何（比对环带用） */
export function sequenceGeometry(seq: SyntheticSequence, pupilFraction = 0.42) {
  return irisGeometry(seq.size, pupilFraction);
}

/** 空掩膜（全过曝等场景的占位，保证类型完整） */
export function emptyMask(size: number): MaskImage {
  return makeMask(size, size);
}
