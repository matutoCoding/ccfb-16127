// 首次启动生成合成测试数据并写入 IndexedDB。
import { ARCHETYPES, generateDataset } from '../core/synth';
import { autoMatch, evaluateScenes, evaluateVsPhoto } from '../core/matching';
import { createScheme, uid } from '../core/schemeFactory';
import { estimateScenePupils, optimizeFixedPupil } from '../core/pupil';
import { SCENES } from '../core/scenes';
import { ldrToCanvas, canvasToBlob } from '../browser/canvas';
import { idb, repo } from './db';
import { processBracket } from './process';
import type { CaptureRecord, Patient, Snapshot } from '../core/types';

interface SeedProfile {
  name: string;
  side: 'L' | 'R';
  arch: number;
  kind: 'clean' | 'shaky' | 'blown';
  socket: string;
  implant: string;
  diameter: number;
  thickness: number;
}

const PROFILES: SeedProfile[] = [
  { name: '王桂英', side: 'R', arch: 0, kind: 'clean', socket: '结膜囊略浅，下穹窿稍平', implant: '多孔羟基磷灰石义眼台 20mm', diameter: 23, thickness: 3.2 },
  { name: '李建国', side: 'L', arch: 1, kind: 'clean', socket: '眼窝饱满，各方向运动可', implant: 'MEDPOR 义眼台 18mm', diameter: 22, thickness: 2.8 },
  { name: '张淑芬', side: 'L', arch: 2, kind: 'clean', socket: '萎缩眼，睑裂偏小', implant: '未植入义眼台（自体重睑）', diameter: 21, thickness: 3.6 },
  { name: '刘志强', side: 'R', arch: 3, kind: 'clean', socket: '眼窝正常，无分泌物', implant: '玻璃义眼台 19mm', diameter: 22.5, thickness: 3.0 },
  { name: '陈雅琴', side: 'L', arch: 1, kind: 'shaky', socket: '结膜囊轻度狭窄', implant: '多孔羟基磷灰石义眼台 18mm', diameter: 22, thickness: 3.4 },
  { name: '赵小满', side: 'R', arch: 2, kind: 'blown', socket: '术后三个月，轻度水肿', implant: '钛钉连体义眼台 20mm', diameter: 23, thickness: 3.1 },
];

async function makeThumbnail(scheme: import('../core/types').IrisScheme, geom: import('../core/types').EyeGeometry, gain: number, curve: import('../core/types').ResponseCurve, wb: [number, number, number]): Promise<string> {
  const { renderEyeLinear } = await import('../core/eyeRenderer');
  const { encodeRadiance } = await import('../core/pipeline');
  const r = renderEyeLinear(scheme, geom, { size: 220, irisDiameterMm: 12 });
  const ldr = encodeRadiance(r, { curve, wb, gain });
  const c = ldrToCanvas(ldr);
  return c.toDataURL('image/jpeg', 0.82);
}

export async function seedIfNeeded(onProgress: (msg: string, pct: number) => void): Promise<boolean> {
  const settings = await repo.getSettings();
  if (settings.seededAt) return false;

  for (let i = 0; i < PROFILES.length; i++) {
    const pf = PROFILES[i];
    const pctBase = (i / PROFILES.length) * 100;
    onProgress(`合成测试眼 ${i + 1}/${PROFILES.length} · ${pf.name}`, pctBase);
    await new Promise((r) => setTimeout(r, 30));

    const arch = ARCHETYPES[pf.arch];
    const ds = generateDataset({ archetype: arch, kind: pf.kind, size: 320 });

    const now = Date.now();
    const patient: Patient = {
      id: uid('pat'),
      code: `YE-${new Date().getFullYear()}-${String(i + 1).padStart(3, '0')}`,
      name: pf.name,
      prostheticSide: pf.side,
      socketCondition: pf.socket,
      implantType: pf.implant,
      shellDiameterMm: pf.diameter,
      thicknessMm: pf.thickness,
      irisDiameterMm: ds.irisDiameterMm,
      note: pf.kind === 'shaky' ? '本组合成时掺入 ±8px 手抖位移，用于验证自动对齐'
        : pf.kind === 'blown' ? '本组合成时整体加 6 档曝光，全部过曝，用于验证质量拦截'
        : `合成数据 · ${arch.name}`,
      createdAt: now - (PROFILES.length - i) * 86400000,
      updatedAt: now - i * 3600000,
    };
    await repo.savePatient(patient);

    onProgress(`处理多曝光序列 · ${pf.name}`, pctBase + 8);
    const processed = processBracket(ds.frames, ds.dts, ds.geom, ds.referenceIndex);

    // 存帧 Blob
    const frameMetas = [];
    for (let j = 0; j < ds.frames.length; j++) {
      const blobId = uid('img');
      const blob = await canvasToBlob(ldrToCanvas(ds.frames[j]), 'image/png');
      await idb.putBlob(blobId, blob);
      frameMetas.push({
        ev: ds.evs[j],
        exposureUs: Math.round(ds.dts[j] * 125), // 相对曝光单位 → 虚拟 μs
        blobId,
        width: ds.size,
        height: ds.size,
        shiftX: processed.align.mtbOffset[j].x,
        shiftY: processed.align.mtbOffset[j].y,
        mismatch: processed.align.errorAfter,
      });
    }

    const capture: CaptureRecord = {
      id: uid('cap'),
      patientId: patient.id,
      createdAt: patient.createdAt + 3600000,
      source: 'synthetic',
      width: ds.size,
      height: ds.size,
      frames: frameMetas,
      referenceEv: 0,
      geometry: ds.geom,
      curve: processed.curve,
      wbGains: ds.wb,
      hdrBuffer: processed.merged.hdr.data.buffer as ArrayBuffer,
      highlightMask: processed.highlightMask,
      quality: processed.quality,
      datasetKind: pf.kind,
    };

    if (pf.kind !== 'blown') {
      onProgress(`拟合颜料配方 · ${pf.name}`, pctBase + 22);
      await new Promise((r) => setTimeout(r, 10));
      // 用实测瞳孔初始化
      const tpl = createScheme(patient);
      tpl.pupilDiameterMm = Math.round((ds.geom.pupilR / ds.geom.irisR) * ds.irisDiameterMm * 10) / 10;
      const fit = autoMatch(tpl, processed.merged.hdr, ds.frames[ds.referenceIndex], ds.geom, processed.curve, ds.wb, {
        highlightMask: processed.highlightMask,
        validMask: processed.merged.valid,
        irisDiameterMm: ds.irisDiameterMm,
      });
      const scheme = fit.scheme;
      scheme.patientId = patient.id;
      scheme.version = 1;
      scheme.name = '一键拟合 v1';
      scheme.fitGain = fit.gain;
      scheme.fittedFromCaptureId = capture.id;
      await repo.saveScheme(scheme);

      // 瞳孔场景优化建议（写入 note，不强制改动拟合瞳孔）
      const pupilEst = estimateScenePupils(tpl.pupilDiameterMm!, ds.captureLux, SCENES);
      const opt = optimizeFixedPupil(pupilEst.estimates.map((e) => e.healthyMm));
      scheme.note = `四场景固定瞳孔建议 ${opt.bestMm.toFixed(2)}mm（RMS ${opt.rms.toFixed(2)}mm）`;

      const photoMetric = evaluateVsPhoto(scheme, ds.frames[ds.referenceIndex], ds.geom, processed.curve, ds.wb, fit.gain, ds.irisDiameterMm, processed.highlightMask, settings.deltaEThreshold);
      const sceneMetrics = evaluateScenes(scheme, scheme, ds.geom, processed.curve, fit.gain, ds.irisDiameterMm, settings.deltaEThreshold);

      const thumb = await makeThumbnail(scheme, ds.geom, fit.gain, processed.curve, ds.wb);
      const snapshot: Snapshot = {
        id: uid('snap'),
        patientId: patient.id,
        schemeId: scheme.id,
        version: 1,
        createdAt: capture.createdAt + 60000,
        reason: '多曝光 HDR 一键拟合初始快照',
        scheme: JSON.parse(JSON.stringify(scheme)),
        thumbnail: thumb,
        metrics: [photoMetric, ...sceneMetrics],
      };
      await repo.saveSnapshot(snapshot);
      capture.truth = { seed: arch.seed, archetype: arch.id, deltaE: fit.meanDeltaE };
    }

    await repo.saveCapture(capture);
  }

  settings.seededAt = Date.now();
  await repo.saveSettings(settings);
  onProgress('完成', 100);
  return true;
}
