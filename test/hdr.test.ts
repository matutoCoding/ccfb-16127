/**
 * HDR 链路验收：
 *  1) 响应曲线恢复精度（g 与真值逐点误差）；
 *  2) 重建辐照度 vs 造图真值，相对误差 < 5%；
 *  3) 全部过曝组必须被 AllOverexposedError 识别；
 *  4) 手抖组必须产生对齐低置信度警告，且正常序列误差仍达标。
 */
import { describe, it, expect } from 'vitest';
import { generateSyntheticSequence, SYNTHETIC_IRIS_CASES } from '../src/synth/dataset';
import { buildHdr, AllOverexposedError } from '../src/hdr/pipeline';
import { trueResponseCurve } from '../src/synth/camera';

const SIZE = 144;
const EVS = [-2, -1, 0, 1, 2];

describe('相机响应曲线恢复', () => {
  it('恢复的 g 与真值在常用域 [16,240] 内逐点误差 < 0.5 log 单位', () => {
    const seq = generateSyntheticSequence(SYNTHETIC_IRIS_CASES[0], { size: SIZE, evs: EVS });
    const { capture } = buildHdr(seq.frames, { id: 't1', patientId: 'p', eye: 'right' });
    const gTrue = trueResponseCurve().g;
    for (let ch = 0; ch < 3; ch++) {
      let maxErr = 0;
      for (let z = 16; z <= 240; z++) {
        maxErr = Math.max(maxErr, Math.abs(capture.response.g[ch * 256 + z] - gTrue[ch * 256 + z]));
      }
      expect(maxErr).toBeLessThan(0.5);
    }
  });
});

describe('HDR 辐照重建（硬指标：相对误差 < 5%）', () => {
  for (const irisCase of SYNTHETIC_IRIS_CASES) {
    it(`${irisCase.label}：掩膜外、信噪比达标像素的平均相对误差 < 5%`, () => {
      const seq = generateSyntheticSequence(irisCase, { size: SIZE, evs: EVS });
      const { capture } = buildHdr(seq.frames, { id: `hdr-${irisCase.key}`, patientId: 'p', eye: 'right' });

      // 取色/比对只在可靠亮度区进行；近黑像素（瞳孔、眼球外背景，truth<0.05）
      // 相对误差天然发散，不纳入辐照精度主指标（与 HDR 评测通行口径一致）。
      const SNR_FLOOR = 0.05;
      let relSum = 0;
      let relCount = 0;
      let darkCount = 0;
      const n = SIZE * SIZE;
      for (let p = 0; p < n; p++) {
        if (capture.specularMask.data[p]) continue;
        for (let ch = 0; ch < 3; ch++) {
          const truth = seq.groundTruthHdr.data[p * 3 + ch];
          if (truth < SNR_FLOOR) {
            if (truth > 1e-4) darkCount++;
            continue;
          }
          const got = capture.hdr.data[p * 3 + ch];
          const rel = Math.abs(got - truth) / truth;
          relSum += rel;
          relCount++;
        }
      }
      const meanRel = relSum / relCount;
      console.log(`[HDR] ${irisCase.label} meanRel=${(meanRel * 100).toFixed(2)}% n=${relCount}（另剔除近黑 ${darkCount} 样本）`);
      expect(meanRel).toBeLessThan(0.05);
    });
  }
});

describe('异常序列识别', () => {
  it('全部过曝序列抛 AllOverexposedError', () => {
    const seq = generateSyntheticSequence(SYNTHETIC_IRIS_CASES[0], {
      size: SIZE,
      evs: EVS,
      anomaly: 'all-overexposed',
    });
    expect(() => buildHdr(seq.frames, { id: 'bad', patientId: 'p', eye: 'right' })).toThrow(AllOverexposedError);
  });

  it('手抖序列产生对齐置信度警告', () => {
    const seq = generateSyntheticSequence(SYNTHETIC_IRIS_CASES[1], {
      size: SIZE,
      evs: EVS,
      anomaly: 'handshake',
    });
    const { warnings } = buildHdr(seq.frames, { id: 'shake', patientId: 'p', eye: 'right' });
    expect(warnings.some((w) => w.includes('对齐置信度低'))).toBe(true);
  });

  it('正常序列不应有对齐警告', () => {
    const seq = generateSyntheticSequence(SYNTHETIC_IRIS_CASES[2], { size: SIZE, evs: EVS });
    const { warnings } = buildHdr(seq.frames, { id: 'ok', patientId: 'p', eye: 'right' });
    expect(warnings.some((w) => w.includes('对齐置信度低'))).toBe(false);
  });

  it('高光掩膜覆盖了合成亮斑核心区（亮斑不进取色）', () => {
    const seq = generateSyntheticSequence(SYNTHETIC_IRIS_CASES[3], { size: SIZE, evs: EVS });
    const { capture } = buildHdr(seq.frames, { id: 'mask', patientId: 'p', eye: 'right' });
    let masked = 0;
    for (let i = 0; i < capture.specularMask.data.length; i++) masked += capture.specularMask.data[i];
    expect(masked).toBeGreaterThan(0);
    // 掩膜不应失控吞掉整图
    expect(masked / capture.specularMask.data.length).toBeLessThan(0.25);
  });
});
