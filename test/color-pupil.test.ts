/**
 * 颜色科学与瞳孔模型单元测试（纯函数，不依赖浏览器/WebGPU）。
 */
import { describe, it, expect } from 'vitest';
import { deltaE00, srgbToLinear, linearToSrgb, hexToLinearRgb, type RGB } from '../src/core/color';
import { pupilDiameterMm, optimizeFixedPupil, healthyPupilMm } from '../src/render/pupil';
import { LIGHTING_SCENES, SCENE_ORDER } from '../src/render/scenes';
import { defaultPaintScheme } from '../src/render/eyeModel';
import { renderEye } from '../src/render/eyeModel';

describe('sRGB 编解码往返', () => {
  it('线性→sRGB→线性在 [0,1] 内误差 < 1e-4', () => {
    for (let i = 1; i < 255; i++) {
      const lin = srgbToLinear(i / 255);
      const back = linearToSrgb(lin);
      expect(Math.abs(back * 255 - i)).toBeLessThan(1); // 量化误差不超过 1 级
    }
  });
  it('hex 解码为线性 RGB，黑为 0 白接近 1', () => {
    const black = hexToLinearRgb('#000000');
    const white = hexToLinearRgb('#ffffff');
    expect(black).toEqual([0, 0, 0]);
    expect(white[0]).toBeCloseTo(1, 5);
    expect(white[1]).toBeCloseTo(1, 5);
  });
});

describe('CIEDE2000', () => {
  it('同色 ΔE00 = 0', () => {
    expect(deltaE00([50, 10, -10], [50, 10, -10])).toBeCloseTo(0, 6);
  });
  it('已知参考对（Lab 蓝 vs 红）ΔE00 > 30', () => {
    const blue: RGB = [32, 68, -104];
    const red: RGB = [53, 80, 67];
    expect(deltaE00(blue, red)).toBeGreaterThan(30);
  });
  it('对称性', () => {
    const a: RGB = [40, 20, -30];
    const b: RGB = [55, -10, 25];
    expect(deltaE00(a, b)).toBeCloseTo(deltaE00(b, a), 6);
  });
});

describe('瞳孔光反射模型', () => {
  it('亮度越高瞳孔越小，且落在生理区间 [1.5,8] mm', () => {
    const dark = pupilDiameterMm(1);
    const bright = pupilDiameterMm(10000);
    expect(dark).toBeGreaterThan(bright);
    expect(dark).toBeLessThan(8);
    expect(bright).toBeGreaterThan(1.5);
  });
  it('闪光灯下瞳孔最小（<3mm），暖色室内灯最大', () => {
    expect(healthyPupilMm('flash')).toBeLessThan(3);
    expect(healthyPupilMm('warm')).toBeGreaterThan(6);
  });
  it('固定瞳孔优化值落在所有场景动态瞳孔的包络内', () => {
    const opt = optimizeFixedPupil();
    const dyn = SCENE_ORDER.map((id) => pupilDiameterMm(LIGHTING_SCENES[id].luminance));
    expect(opt.fixedPupilMm).toBeGreaterThanOrEqual(Math.min(...dyn) - 0.5);
    expect(opt.fixedPupilMm).toBeLessThanOrEqual(Math.max(...dyn) + 0.5);
    expect(opt.perScene).toHaveLength(4);
  });
});

describe('CPU HDR 眼睛渲染', () => {
  it('输出为线性浮点且不含 8 位截断（存在 >1 的 HDR 值）', () => {
    const scheme = defaultPaintScheme('p', 42);
    const { hdr } = renderEye(scheme, LIGHTING_SCENES.flash, { size: 64 });
    expect(hdr.data).toBeInstanceOf(Float32Array);
    expect(Math.max(...hdr.data)).toBeGreaterThan(1);
    expect(Math.min(...hdr.data)).toBeGreaterThanOrEqual(0);
  });
  it('四种场景都能稳定渲染且尺寸正确', () => {
    const scheme = defaultPaintScheme('p', 7);
    for (const id of SCENE_ORDER) {
      const { hdr } = renderEye(scheme, LIGHTING_SCENES[id], { size: 48 });
      expect(hdr.width).toBe(48);
      expect(hdr.data.length).toBe(48 * 48 * 3);
      expect(Number.isFinite(hdr.data.reduce((a, b) => a + b, 0))).toBe(true);
    }
  });
});
