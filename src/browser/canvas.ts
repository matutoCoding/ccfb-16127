// 核心图像类型 ↔ Canvas / Blob / dataURL 的浏览器侧转换。
import { linearToSrgb } from '../core/color';
import type { LdrImage, RgbImage } from '../core/types';

export function ldrToCanvas(img: LdrImage): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d')!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return c;
}

export function canvasToLdr(c: HTMLCanvasElement): LdrImage {
  const ctx = c.getContext('2d')!;
  const d = ctx.getImageData(0, 0, c.width, c.height);
  return { width: c.width, height: c.height, data: d.data };
}

// Float 线性 HDR → 显示用 sRGB（仅用于 HDR 预览；比对链路走响应曲线编码）
export function hdrToDisplayCanvas(img: RgbImage, exposure = 1): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d')!;
  const out = ctx.createImageData(img.width, img.height);
  for (let i = 0; i < img.width * img.height; i++) {
    for (let ch = 0; ch < 3; ch++) {
      const v = img.data[i * 3 + ch] * exposure;
      out.data[i * 4 + ch] = Math.round(255 * linearToSrgb(v));
    }
    out.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  return c;
}

export function canvasToBlob(c: HTMLCanvasElement, type = 'image/png'): Promise<Blob> {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob 失败'))), type));
}

export function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = rej;
    r.readAsDataURL(b);
  });
}

export function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

export async function fileToLdrSquare(file: File, size = 384): Promise<LdrImage> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImageElement(url);
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const ctx = c.getContext('2d')!;
    // 居中正方形裁剪
    const side = Math.min(img.width, img.height);
    const sx = (img.width - side) / 2, sy = (img.height - side) / 2;
    ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
    return canvasToLdr(c);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function dataUrlToLdr(dataUrl: string): Promise<LdrImage> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d')!.drawImage(img, 0, 0);
      resolve(canvasToLdr(c));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

export function drawContain(canvas: HTMLCanvasElement, source: CanvasImageSource, sw: number, sh: number) {
  const ctx = canvas.getContext('2d')!;
  canvas.width = sw; canvas.height = sh;
  ctx.drawImage(source, 0, 0, sw, sh);
}
