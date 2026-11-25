/**
 * 成像比对验收（硬指标：渲染结果过响应曲线后，与健侧照片在虹膜环带上的平均 ΔE00 < 3）。
 *
 * 链路：健侧 HDR（合成真值）→ 场景白点染色 → 同一响应曲线 + 同一曝光成像 → LDR
 *       义眼 HDR（同方案渲染，固定瞳孔）→ 同曲线同曝光成像 → LDR
 *       两 LDR 解码回线性 → Lab → 同心环带逐像素 CIEDE2000
 */
import { describe, it, expect } from 'vitest';
import { generateSyntheticSequence, SYNTHETIC_IRIS_CASES, sequenceGeometry } from '../src/synth/dataset';
import { buildHdr } from '../src/hdr/pipeline';
import { buildComparisonReport, RING_BANDS } from '../src/core/comparison';
import { makeMask } from '../src/core/image';
import { SCENE_ORDER } from '../src/render/scenes';
import { optimizeFixedPupil, fixedPupilFraction } from '../src/render/pupil';
import type { PaintScheme } from '../src/core/types';

const SIZE = 144;
const EVS = [-2, -1, 0, 1, 2];

describe('CIEDE2000 色差（硬指标：虹膜环带平均 ΔE00 < 3）', () => {
  for (const irisCase of SYNTHETIC_IRIS_CASES) {
    it(`${irisCase.label}：四场景环带平均 ΔE00 < 3`, () => {
      const seq = generateSyntheticSequence(irisCase, { size: SIZE, evs: EVS });
      // 从多曝光序列重建健侧 HDR 与响应曲线（走真实管线，而非直接用真值）
      const { capture } = buildHdr(seq.frames, { id: `c-${irisCase.key}`, patientId: 'p', eye: 'right' });

      // 义眼方案 = 健侧同方案（理想情况下应高度一致），固定瞳孔取四场景最优值
      const scheme: PaintScheme = structuredClone(irisCase.scheme);
      const pupil = optimizeFixedPupil();
      scheme.fixedPupilMm = pupil.fixedPupilMm;
      scheme.pupilFraction = fixedPupilFraction(pupil.fixedPupilMm);

      const geometry = sequenceGeometry(seq, scheme.pupilFraction);
      const report = buildComparisonReport({
        id: `r-${irisCase.key}`,
        patientId: 'p',
        captureId: capture.id,
        schemeId: scheme.id,
        healthyHdr: capture.hdr,
        healthyMask: makeMask(SIZE, SIZE), // 环带统计在虹膜内部，不额外掩
        geometry,
        scheme,
        curve: capture.response,
        ev: 0,
        deltaEThreshold: 3,
        renderSize: SIZE,
        now: 1,
      });

      const perScene: string[] = [];
      let allRingsPass = true;
      for (const sceneId of SCENE_ORDER) {
        const sc = report.scenes[sceneId];
        const ringAvg = sc.rings.reduce((s, r) => s + r.meanDeltaE, 0) / sc.rings.length;
        perScene.push(`${sceneId}=${ringAvg.toFixed(2)}`);
        if (ringAvg >= 3) allRingsPass = false;
      }
      console.log(`[ΔE00] ${irisCase.label} 总平均=${report.overallAverageDeltaE.toFixed(2)} | ${perScene.join(' ')}`);
      expect(report.overallAverageDeltaE).toBeLessThan(3);
      expect(allRingsPass).toBe(true);
      expect(RING_BANDS.length).toBe(5);
    });
  }

  it('超标环带能归因到具体颜料层并给出调整建议', () => {
    const irisCase = SYNTHETIC_IRIS_CASES[0];
    const seq = generateSyntheticSequence(irisCase, { size: SIZE, evs: EVS });
    const { capture } = buildHdr(seq.frames, { id: 'c', patientId: 'p', eye: 'right' });
    // 故意把多层颜料换成严重不符的色号，制造显著超标
    const scheme: PaintScheme = structuredClone(irisCase.scheme);
    scheme.base.pigmentId = 'base-blue-deep';
    scheme.fibers.pigmentId = 'fiber-navy';
    scheme.collarette.pigmentId = 'collar-blue';
    scheme.spots.pigmentId = 'spot-charcoal';
    const pupil = optimizeFixedPupil();
    scheme.fixedPupilMm = pupil.fixedPupilMm;
    scheme.pupilFraction = fixedPupilFraction(pupil.fixedPupilMm);
    // 用低阈值（1.5）确保错误配色必然触发超标环带，从而验证归因链路
    const report = buildComparisonReport({
      id: 'r',
      patientId: 'p',
      captureId: capture.id,
      schemeId: scheme.id,
      healthyHdr: capture.hdr,
      healthyMask: makeMask(SIZE, SIZE),
      geometry: sequenceGeometry(seq, scheme.pupilFraction),
      scheme,
      curve: capture.response,
      ev: 0,
      deltaEThreshold: 1.5,
      renderSize: SIZE,
      now: 1,
    });
    expect(report.attributions.length).toBeGreaterThan(0);
    // 每条归因都要落到具体颜料层、带色号与可操作建议
    for (const a of report.attributions) {
      expect(a.layerName).toBeTruthy();
      expect(a.advice.length).toBeGreaterThan(5);
      expect(a.advice).toMatch(/UM-|FB-|CL-|SP-/);
      expect(a.deltaE).toBeGreaterThan(1.5);
    }
    // 归因覆盖的环带与场景可回溯
    expect(report.attributions[0].ringIndex).toBeGreaterThanOrEqual(0);
    expect(SCENE_ORDER).toContain(report.attributions[0].sceneId);
  });
});
