/**
 * HDR 重建总装：对齐 → 高光检测 → 响应曲线恢复 → 辐照合并 → 质量指标。
 * 任何一步的可恢复异常都转成 quality.warnings，不可恢复（全部过曝）向上抛 AllOverexposedError。
 */
import type { HdrCapture, HdrQuality, LdrImage, MaskImage } from '../core/types';
import { alignExposureStack } from './alignment';
import { detectSpecularMask, maskRatio } from './specular';
import { recoverResponseCurve, AllOverexposedError } from './response';
import { mergeRadiance } from './merge';
import { linearToLdr } from '../core/image';

export interface BuildHdrOptions {
  id: string;
  patientId: string;
  eye: 'left' | 'right';
  lambda?: number;
  now?: number;
}

export interface BuildHdrOutput {
  capture: HdrCapture;
  warnings: string[];
}

export function buildHdr(images: LdrImage[], opts: BuildHdrOptions): BuildHdrOutput {
  if (images.some((im) => im.width !== images[0].width || im.height !== images[0].height)) {
    throw new Error('多曝光照片尺寸不一致，无法对齐');
  }
  const warnings: string[] = [];

  // 1. 对齐（含手抖失配警告）
  const { result: alignment, alignedLinear, warnings: alignWarnings } = alignExposureStack(images);
  warnings.push(...alignWarnings);

  // 2. 高光/过曝掩膜（亮斑不进取色）
  const specularMask: MaskImage = detectSpecularMask(images);
  const specRatio = maskRatio(specularMask);
  if (specRatio > 0.25) {
    warnings.push(`高光/过曝区覆盖 ${(specRatio * 100).toFixed(1)}%，有效取色面积偏小`);
  }

  // 3. 响应曲线恢复（全部过曝在此抛 AllOverexposedError）
  const { curve, fitRms } = recoverResponseCurve(images, opts.lambda ?? 8);
  for (let ch = 0; ch < 3; ch++) {
    if (fitRms[ch] > 0.15) {
      warnings.push(`${'RGB'[ch]} 通道响应曲线拟合残差偏大（RMS=${fitRms[ch].toFixed(3)}），建议补拍曝光`);
    }
  }

  // 4. 辐照合并（线性 HDR，不做位深截断）
  const { hdr, fallbackPixels } = mergeRadiance(images, alignedLinear, curve, specularMask);
  if (fallbackPixels > 0) {
    warnings.push(`${fallbackPixels} 个像素在全部照片中均无有效样本，已用最暗帧回退估值`);
  }

  const total = specularMask.data.length;
  const validRatio = 1 - specRatio;

  const quality: HdrQuality = {
    validPixelRatio: validRatio,
    fitRms,
    warnings,
  };

  const thumbnails = images.map((im) => downscaleLdr(im, 96));

  const capture: HdrCapture = {
    id: opts.id,
    patientId: opts.patientId,
    eye: opts.eye,
    createdAt: opts.now ?? Date.now(),
    exposures: images.map((im) => im.exposure),
    alignment,
    response: curve,
    hdr,
    specularMask,
    thumbnails,
    quality,
  };

  return { capture, warnings };
}

/** 等比缩小 LDR（盒式滤波），存档缩略图用 */
export function downscaleLdr(img: LdrImage, targetMax: number): LdrImage {
  const scale = Math.min(1, targetMax / Math.max(img.width, img.height));
  const tw = Math.max(1, Math.round(img.width * scale));
  const th = Math.max(1, Math.round(img.height * scale));
  const out = new LdrImageStub(tw, th, img.exposure);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const sx0 = Math.floor((x / tw) * img.width);
      const sy0 = Math.floor((y / th) * img.height);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) / tw) * img.width));
      const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) / th) * img.height));
      let r = 0;
      let g = 0;
      let b = 0;
      let cnt = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * img.width + sx) * 4;
          r += img.data[i];
          g += img.data[i + 1];
          b += img.data[i + 2];
          cnt++;
        }
      }
      const oi = (y * tw + x) * 4;
      out.data[oi] = r / cnt;
      out.data[oi + 1] = g / cnt;
      out.data[oi + 2] = b / cnt;
      out.data[oi + 3] = 255;
    }
  }
  return out;
}

// 避免循环依赖类型名冲突的轻量构造
import type { LdrImage as LdrImageType } from '../core/types';
class LdrImageStub implements LdrImageType {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  exposure: number;
  constructor(w: number, h: number, exposure: number) {
    this.width = w;
    this.height = h;
    this.exposure = exposure;
    this.data = new Uint8ClampedArray(w * h * 4);
  }
}

export { AllOverexposedError };
export { linearToLdr };
