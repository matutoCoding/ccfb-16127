import type { IrisScheme, Patient, PigmentMixItem } from './types';
import { mixPigments } from './pigments';

let seq = 0;
export function uid(prefix = 'id'): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

// 八环带的初始棕眼配方（新建设计时的安全起点；一键拟合会重算）
export function defaultBandMix(): PigmentMixItem[][] {
  const brown: PigmentMixItem[][] = [
    [{ pigmentId: 'PBk9', ratio: 0.35 }, { pigmentId: 'PBr7u', ratio: 0.45 }, { pigmentId: 'PBr7', ratio: 0.2 }],
    [{ pigmentId: 'PBr7u', ratio: 0.5 }, { pigmentId: 'PBk9', ratio: 0.2 }, { pigmentId: 'PBr7', ratio: 0.3 }],
    [{ pigmentId: 'PBr7', ratio: 0.55 }, { pigmentId: 'PBr7y', ratio: 0.3 }, { pigmentId: 'PBk9', ratio: 0.15 }],
    [{ pigmentId: 'PBr7', ratio: 0.5 }, { pigmentId: 'PY42', ratio: 0.3 }, { pigmentId: 'PBr7u', ratio: 0.2 }],
    [{ pigmentId: 'PBr7y', ratio: 0.45 }, { pigmentId: 'PBr7', ratio: 0.4 }, { pigmentId: 'PBk9', ratio: 0.15 }],
    [{ pigmentId: 'PBr7', ratio: 0.5 }, { pigmentId: 'PBr7u', ratio: 0.35 }, { pigmentId: 'PBk9', ratio: 0.15 }],
    [{ pigmentId: 'PBr7u', ratio: 0.55 }, { pigmentId: 'PBk9', ratio: 0.3 }, { pigmentId: 'PBr7', ratio: 0.15 }],
    [{ pigmentId: 'PBk9', ratio: 0.5 }, { pigmentId: 'PBr7u', ratio: 0.4 }, { pigmentId: 'PBr7', ratio: 0.1 }],
  ];
  return brown;
}

export function createScheme(patient: Pick<Patient, 'id' | 'irisDiameterMm'>, opts?: { name?: string }): IrisScheme {
  const bandMix = defaultBandMix();
  return {
    id: uid('sch'),
    patientId: patient.id,
    version: 1,
    name: opts?.name ?? '手工配色 v1',
    createdAt: Date.now(),
    note: '',
    bandCount: 8,
    bandRGB: bandMix.map((m) => mixPigments(m)),
    bandMix,
    baseOpacity: 0.96,
    radial: { enabled: true, pigment: 'PBr7u', coverage: 0.62, opacity: 0.7, count: 210, contrast: 1.0, seed: 11 },
    collarette: { enabled: true, pigment: 'PBr7', coverage: 0.7, opacity: 0.55, radius: 0.46, width: 0.05, irregularity: 0.7, seed: 23 },
    spots: { enabled: true, pigment: 'PBr7u', coverage: 0.12, opacity: 0.6, count: 12, seed: 37 },
    pupilDiameterMm: 3.6,
    sclera: {
      basePigment: 'PW6',
      yellowPigment: 'PY42',
      baseYellow: 0.18,
      wetness: 0.55,
      vesselOpacity: 0.5,
      seed: 51,
      regions: [
        { key: 'innerCanthus', label: '内眦', yellow: 0.42, vesselDensity: 0.8, vesselPigment: 'PR206' },
        { key: 'outerCanthus', label: '外眦', yellow: 0.22, vesselDensity: 0.55, vesselPigment: 'PR206' },
        { key: 'upper', label: '上方', yellow: 0.12, vesselDensity: 0.3, vesselPigment: 'PR101' },
        { key: 'lower', label: '下方', yellow: 0.16, vesselDensity: 0.38, vesselPigment: 'PR101' },
      ],
    },
    cornea: { curvature: 0.8, gloss: 0.7, fresnel: 0.5, highlightX: 0.4, highlightY: 0.36, highlightHdr: 1.5 },
    depth: 0.8,
  };
}

export function cloneScheme(s: IrisScheme): IrisScheme {
  return JSON.parse(JSON.stringify(s)) as IrisScheme;
}
