// 拍摄序列处理服务：供种子数据与“健侧眼拍摄”页共用。
import {
  alignFramesMtb, assessQuality, detectHighlightMask, mergeHdr, recoverResponse, shiftLdr,
} from '../core/hdr';
import type { AlignResult } from '../core/hdr';
import type { EyeGeometry, HdrQuality, LdrImage, ResponseCurve, RgbImage } from '../core/types';

export interface ProcessedBracket {
  align: AlignResult;
  alignedFrames: LdrImage[];
  curve: ResponseCurve;
  merged: ReturnType<typeof mergeHdr>;
  highlightMask: Uint8Array;
  quality: HdrQuality;
}

export function processBracket(
  frames: LdrImage[],
  dts: number[],
  geom: EyeGeometry,
  referenceIndex: number,
): ProcessedBracket {
  const align = alignFramesMtb(frames, referenceIndex);
  const alignedFrames = frames.map((f, i) => shiftLdr(f, align.correction[i].x, align.correction[i].y));
  const curve = recoverResponse(alignedFrames, dts, { samples: 140, lambda: 26 });
  curve.recoveredAt = Date.now();
  const merged = mergeHdr(alignedFrames, dts, curve);
  const highlightMask = detectHighlightMask(frames[referenceIndex], geom, 4);
  const quality = assessQuality(frames, referenceIndex, geom, align, highlightMask);
  return { align, alignedFrames, curve, merged, highlightMask, quality };
}

export function hdrFromBuffer(width: number, height: number, buffer?: ArrayBuffer): RgbImage | null {
  if (!buffer) return null;
  return { width, height, data: new Float32Array(buffer) };
}

// 从 CaptureRecord 还原高亮 mask（单独存 base64? 这里用 Uint8Array 结构化存储）
export function maskToArrayBuffer(mask: Uint8Array): ArrayBuffer {
  return mask.buffer.slice(mask.byteOffset, mask.byteOffset + mask.byteLength) as ArrayBuffer;
}
export function maskFromBuffer(buf: ArrayBuffer): Uint8Array {
  return new Uint8Array(buf);
}
