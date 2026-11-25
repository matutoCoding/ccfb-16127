/**
 * 角膜反光 / 过曝区检测。
 *
 * 关键原则：角膜上的镜面高光不是虹膜颜色，绝不能进入取色与环带统计。
 * 判定依据：在序列里最暗的那张照片中仍接近饱和的像素，属于真实镜面反射
 * （普通虹膜/巩膜在最暗帧必然被压下来），再做形态学膨胀覆盖色差边缘。
 * 单帧饱和而最暗帧未饱和的像素只是普通过曝样本，合并时靠零权重剔除即可。
 */
import type { LdrImage, MaskImage } from '../core/types';
import { makeMask } from '../core/image';

/** 最暗帧亮度 ≥ 此阈值视为镜面高光（8 位） */
const SPECULAR_DARKEST_LUMA = 235;
/** 任意帧三通道全饱和且最暗帧也很亮时，并入过曝区 */
const CLIP_LUMA = 250;

function luma(img: LdrImage, p: number): number {
  const i = p * 4;
  return 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
}

export function detectSpecularMask(images: LdrImage[]): MaskImage {
  const w = images[0].width;
  const h = images[0].height;
  const n = w * h;

  // 找最暗帧（EV 最小）
  let darkest = 0;
  for (let j = 1; j < images.length; j++) {
    if (images[j].exposure < images[darkest].exposure) darkest = j;
  }

  const raw = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    const darkLuma = luma(images[darkest], p);
    if (darkLuma >= SPECULAR_DARKEST_LUMA) {
      raw[p] = 1;
      continue;
    }
    // 所有帧都全饱和 → 无法恢复的过曝区（含亮斑外扩部分）
    let allClipped = true;
    for (let j = 0; j < images.length; j++) {
      if (luma(images[j], p) < CLIP_LUMA) {
        allClipped = false;
        break;
      }
    }
    if (allClipped && images.length >= 2 && darkLuma >= 200) raw[p] = 1;
  }

  // 3×3 膨胀一次，覆盖亮斑边缘色散与对齐残差
  const mask = makeMask(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!raw[y * w + x]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < w && ny >= 0 && ny < h) mask.data[ny * w + nx] = 1;
        }
      }
    }
  }
  return mask;
}

/** 统计掩膜覆盖率 */
export function maskRatio(mask: MaskImage): number {
  let count = 0;
  for (let i = 0; i < mask.data.length; i++) count += mask.data[i];
  return count / mask.data.length;
}
