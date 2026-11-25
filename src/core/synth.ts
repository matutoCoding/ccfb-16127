// 合成测试数据：几只不同虹膜颜色的健侧眼 + 多曝光序列。
// 每组都带造图真值（线性辐照度 E_true、相机响应、WB、位移），供验收核对。
import { Rng } from './prng';
import { mixPigments } from './pigments';
import type { RGB } from './color';
import { createScheme } from './schemeFactory';
import { renderEyeLinear } from './eyeRenderer';
import { trueResponseCode } from './camera';
import { shiftLdr } from './hdr';
import type { EyeGeometry, IrisScheme, LdrImage, RgbImage } from './types';

export interface Archetype {
  id: string;
  name: string;
  seed: number;
  pupilMm: number;
  bandMix: { pigmentId: string; ratio: number }[][];
  radialPigment: string;
  collarettePigment: string;
  spotsPigment: string;
}

const mix = (rows: [string, number][]): { pigmentId: string; ratio: number }[] =>
  rows.map(([pigmentId, ratio]) => ({ pigmentId, ratio }));

export const ARCHETYPES: Archetype[] = [
  {
    id: 'dark-brown',
    name: '深棕虹膜',
    seed: 101,
    pupilMm: 3.5,
    radialPigment: 'PBk9',
    collarettePigment: 'PBr7u',
    spotsPigment: 'PBk6',
    bandMix: [
      mix([['PBk9', 0.42], ['PBr7u', 0.4], ['PBr7', 0.18]]),
      mix([['PBk9', 0.3], ['PBr7u', 0.5], ['PBr7', 0.2]]),
      mix([['PBr7u', 0.5], ['PBr7', 0.35], ['PBk9', 0.15]]),
      mix([['PBr7', 0.55], ['PBr7u', 0.3], ['PBk9', 0.15]]),
      mix([['PBr7', 0.5], ['PBr7y', 0.25], ['PBr7u', 0.25]]),
      mix([['PBr7u', 0.5], ['PBr7', 0.35], ['PBk9', 0.15]]),
      mix([['PBr7u', 0.6], ['PBk9', 0.25], ['PBr7', 0.15]]),
      mix([['PBk9', 0.55], ['PBr7u', 0.35], ['PBr7', 0.1]]),
    ],
  },
  {
    id: 'hazel-amber',
    name: '琥珀褐虹膜',
    seed: 202,
    pupilMm: 3.8,
    radialPigment: 'PBr7',
    collarettePigment: 'PY42',
    spotsPigment: 'PBr7u',
    bandMix: [
      mix([['PBr7u', 0.45], ['PBk9', 0.25], ['PBr7', 0.3]]),
      mix([['PBr7', 0.5], ['PBr7y', 0.3], ['PBk9', 0.2]]),
      mix([['PY42', 0.4], ['PBr7', 0.45], ['PBr7u', 0.15]]),
      mix([['PY35', 0.35], ['PBr7', 0.45], ['PO20', 0.2]]),
      mix([['PY42', 0.45], ['PBr7', 0.4], ['PW6', 0.15]]),
      mix([['PBr7y', 0.5], ['PBr7', 0.35], ['PY42', 0.15]]),
      mix([['PBr7', 0.55], ['PBr7u', 0.3], ['PBk9', 0.15]]),
      mix([['PBr7u', 0.6], ['PBk9', 0.3], ['PBr7', 0.1]]),
    ],
  },
  {
    id: 'blue-gray',
    name: '蓝灰虹膜',
    seed: 303,
    pupilMm: 3.2,
    radialPigment: 'PB29',
    collarettePigment: 'PB28',
    spotsPigment: 'PB15',
    bandMix: [
      mix([['PB15', 0.45], ['PBk9', 0.2], ['PB29', 0.35]]),
      mix([['PB29', 0.5], ['PB28', 0.3], ['PBk9', 0.2]]),
      mix([['PB28', 0.5], ['PW6', 0.3], ['PB29', 0.2]]),
      mix([['PB28', 0.45], ['PW6', 0.4], ['PG23', 0.15]]),
      mix([['PB29', 0.4], ['PB28', 0.35], ['PW6', 0.25]]),
      mix([['PB29', 0.5], ['PB15', 0.25], ['PW6', 0.25]]),
      mix([['PB15', 0.45], ['PB29', 0.4], ['PBk9', 0.15]]),
      mix([['PBk9', 0.45], ['PB15', 0.4], ['PB29', 0.15]]),
    ],
  },
  {
    id: 'green',
    name: '绿褐虹膜',
    seed: 404,
    pupilMm: 3.6,
    radialPigment: 'PG17',
    collarettePigment: 'PY42',
    spotsPigment: 'PBr7u',
    bandMix: [
      mix([['PBk9', 0.3], ['PG7', 0.35], ['PBr7u', 0.35]]),
      mix([['PG17', 0.5], ['PBr7u', 0.3], ['PBk9', 0.2]]),
      mix([['PG17', 0.45], ['PY42', 0.35], ['PBr7', 0.2]]),
      mix([['PG23', 0.4], ['PY42', 0.4], ['PG17', 0.2]]),
      mix([['PG17', 0.5], ['PY42', 0.3], ['PW6', 0.2]]),
      mix([['PG17', 0.55], ['PG7', 0.2], ['PBr7y', 0.25]]),
      mix([['PG17', 0.5], ['PBr7u', 0.35], ['PBk9', 0.15]]),
      mix([['PBr7u', 0.55], ['PBk9', 0.35], ['PG17', 0.1]]),
    ],
  },
];

export interface SyntheticDataset {
  kind: 'clean' | 'shaky' | 'blown';
  archetype: Archetype;
  size: number;
  geom: EyeGeometry;
  irisDiameterMm: number;
  truthScheme: IrisScheme;
  truthHdr: RgbImage;
  wb: RGB;
  evs: number[];
  dts: number[];
  referenceIndex: number;
  frames: LdrImage[];
  trueOffsets: { x: number; y: number }[];
  captureLux: number;
}

export interface GenerateOptions {
  archetype?: Archetype;
  kind?: 'clean' | 'shaky' | 'blown';
  size?: number;
  seed?: number;
  noiseSigma?: number;
}

export function buildTruthScheme(a: Archetype): IrisScheme {
  const patientStub = { id: 'synth', irisDiameterMm: 12 };
  const s = createScheme(patientStub, { name: `${a.name}真值` });
  s.bandMix = a.bandMix.map((r) => r.map((it) => ({ ...it })));
  s.bandRGB = s.bandMix.map((m) => mixPigments(m));
  s.radial.pigment = a.radialPigment;
  s.radial.seed = a.seed + 11;
  s.collarette.pigment = a.collarettePigment;
  s.collarette.seed = a.seed + 23;
  s.spots.pigment = a.spotsPigment;
  s.spots.seed = a.seed + 37;
  s.pupilDiameterMm = a.pupilMm;
  s.sclera.seed = a.seed + 51;
  return s;
}

export function generateDataset(opts: GenerateOptions = {}): SyntheticDataset {
  const kind = opts.kind ?? 'clean';
  const archetype = opts.archetype ?? ARCHETYPES[0];
  const size = opts.size ?? 384;
  const rng = new Rng(opts.seed ?? archetype.seed + (kind === 'shaky' ? 7000 : kind === 'blown' ? 9000 : 0));
  const irisDiameterMm = 12;

  const truthScheme = buildTruthScheme(archetype);
  const geom: EyeGeometry = {
    cx: 0.5 + rng.float(-0.015, 0.015),
    cy: 0.515 + rng.float(-0.012, 0.012),
    irisR: 0.335 + rng.float(-0.012, 0.012),
    pupilR: 0,
  };
  geom.pupilR = ((archetype.pupilMm / irisDiameterMm) * geom.irisR);

  const truthHdr = renderEyeLinear(truthScheme, geom, { size, irisDiameterMm });
  const wb: RGB = [0.97, 1.0, 1.06];

  // 曝光序列：干净/手抖用 EV -2..+2；过曝组整体再 +4 EV
  const evs = kind === 'blown' ? [-1, 0, 1, 2, 3] : [-2, -1, 0, 1, 2];
  const baseGain = 8;
  const blowBoost = kind === 'blown' ? 64 : 1;
  const dts = evs.map((ev) => baseGain * 2 ** ev * blowBoost);
  const referenceIndex = evs.indexOf(0);

  // 手抖位移（全分辨率整数像素）
  const trueOffsets = evs.map((_, j) => {
    if (kind !== 'shaky' || j === referenceIndex) return { x: 0, y: 0 };
    return { x: rng.int(-8, 8), y: rng.int(-7, 7) };
  });

  const noiseSigma = opts.noiseSigma ?? 1.3;
  const frames: LdrImage[] = evs.map((ev, j) => {
    const dt = dts[j];
    const raw: LdrImage = { width: size, height: size, data: new Uint8ClampedArray(size * size * 4) };
    for (let i = 0; i < size * size; i++) {
      for (let c = 0; c < 3; c++) {
        const X = Math.max(1e-8, truthHdr.data[i * 3 + c] * wb[c] * dt);
        let code = trueResponseCode(Math.log(X)) + rng.gaussian(0, noiseSigma);
        code = code < 0 ? 0 : code > 255 ? 255 : Math.round(code);
        raw.data[i * 4 + c] = code;
      }
      raw.data[i * 4 + 3] = 255;
    }
    if (trueOffsets[j].x || trueOffsets[j].y) {
      // 造图时把内容按 offset 平移（shiftLdr 正参数 = 内容正向移动）
      return shiftLdr(raw, trueOffsets[j].x, trueOffsets[j].y);
    }
    return raw;
  });

  return {
    kind, archetype, size, geom, irisDiameterMm, truthScheme, truthHdr, wb,
    evs, dts, referenceIndex, frames, trueOffsets, captureLux: 650,
  };
}
