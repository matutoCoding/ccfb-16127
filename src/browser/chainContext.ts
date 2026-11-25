// 加载某患者当前比对链路所需的全部上下文：capture/HDR/基准照片/曲线/几何/gain/数字孪生方案。
import { repo, idb } from '../data/db';
import { hdrFromBuffer } from '../data/process';
import { solveGain } from '../core/matching';
import { ringMeansCodes } from '../core/image';
import type { RGB } from '../core/color';
import type { AppSettings, EyeGeometry, IrisScheme, LdrImage, ResponseCurve, CaptureRecord } from '../core/types';
import type { Patient } from '../core/types';

export interface ChainContext {
  patient: Patient;
  settings: AppSettings;
  capture: CaptureRecord | null;
  geom: EyeGeometry;
  curve: ResponseCurve | null;
  wb: RGB;
  gain: number;
  irisDiameterMm: number;
  hdr: ReturnType<typeof hdrFromBuffer>;
  photo: LdrImage | null;
  referenceScheme: IrisScheme | null;
  currentScheme: IrisScheme | null;
}

export async function frameToLdr(capture: CaptureRecord, frameIndex: number): Promise<LdrImage | null> {
  const meta = capture.frames[frameIndex];
  if (!meta?.blobId) return null;
  const url = await idb.getBlobUrl(meta.blobId);
  if (!url) return null;
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const c = document.createElement('canvas');
    c.width = capture.width; c.height = capture.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0, capture.width, capture.height);
    const d = ctx.getImageData(0, 0, capture.width, capture.height).data;
    return { width: capture.width, height: capture.height, data: new Uint8ClampedArray(d) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function loadChainContext(patient: Patient, settings: AppSettings): Promise<ChainContext> {
  const capture = await repo.latestCapture(patient.id) ?? null;
  const currentScheme = await repo.currentScheme(patient.id) ?? null;
  const snapshots = await repo.listSnapshots(patient.id);
  const referenceScheme = snapshots[snapshots.length - 1]?.scheme ?? snapshots[0]?.scheme ?? currentScheme;

  const geom: EyeGeometry = capture?.geometry ?? { cx: 0.5, cy: 0.515, irisR: 0.335, pupilR: 0.1 };
  const curve = capture?.curve ?? null;
  const wb: RGB = capture?.wbGains ?? [1, 1, 1];
  const irisDiameterMm = patient.irisDiameterMm || 12;
  const hdr = capture ? hdrFromBuffer(capture.width, capture.height, capture.hdrBuffer) : null;

  let photo: LdrImage | null = null;
  if (capture) {
    let idx = capture.frames.findIndex((f) => f.ev === capture.referenceEv);
    if (idx < 0) idx = Math.floor(capture.frames.length / 2);
    photo = await frameToLdr(capture, idx);
  }

  let gain = currentScheme?.fitGain ?? 1;
  if (curve && hdr && photo && capture && (!currentScheme?.fitGain)) {
    const targetCodes = ringMeansCodes(photo, geom, currentScheme?.bandCount ?? 8, capture.highlightMask ?? null);
    gain = solveGain(hdr, geom, targetCodes, curve, wb, currentScheme?.bandCount ?? 8, capture.highlightMask ?? null);
  }

  return { patient, settings, capture, geom, curve, wb, gain, irisDiameterMm, hdr, photo, referenceScheme: referenceScheme ?? null, currentScheme };
}
