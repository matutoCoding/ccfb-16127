/** Canvas 绘制工具：HDR/LDR 图像上屏、响应曲线绘制、环带叠加。 */
import type { FloatImage, LdrImage, ResponseCurve } from '../core/types';
import { linearToSrgb } from '../core/color';

/** 线性 HDR → 可选曝光的 ImageData（仅用于显示，不回灌管线） */
export function hdrToImageData(hdr: FloatImage, exposureGain = 1): ImageData {
  const img = new ImageData(hdr.width, hdr.height);
  const n = hdr.width * hdr.height;
  for (let p = 0; p < n; p++) {
    for (let c = 0; c < 3; c++) {
      const v = linearToSrgb(Math.max(0, hdr.data[p * 3 + c] * exposureGain));
      img.data[p * 4 + c] = Math.min(255, Math.max(0, Math.round(v * 255)));
    }
    img.data[p * 4 + 3] = 255;
  }
  return img;
}

export function ldrToImageData(ldr: LdrImage): ImageData {
  return new ImageData(new Uint8ClampedArray(ldr.data), ldr.width, ldr.height);
}

export function drawHdr(canvas: HTMLCanvasElement, hdr: FloatImage, exposureGain = 1): void {
  canvas.width = hdr.width;
  canvas.height = hdr.height;
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(hdrToImageData(hdr, exposureGain), 0, 0);
}

export function drawLdr(canvas: HTMLCanvasElement, ldr: LdrImage): void {
  canvas.width = ldr.width;
  canvas.height = ldr.height;
  canvas.getContext('2d')!.putImageData(ldrToImageData(ldr), 0, 0);
}

/** 绘制三条响应曲线 g(z)，返回 canvas */
export function drawResponseCurve(canvas: HTMLCanvasElement, curve: ResponseCurve): void {
  const W = (canvas.width = 320);
  const H = (canvas.height = 220);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#0a0e12';
  ctx.fillRect(0, 0, W, H);
  const colors = ['#e06c5f', '#5fbf8f', '#67b8e8'];
  let gmin = Infinity;
  let gmax = -Infinity;
  for (let z = 2; z < 254; z++) {
    for (let ch = 0; ch < 3; ch++) {
      const v = curve.g[ch * 256 + z];
      gmin = Math.min(gmin, v);
      gmax = Math.max(gmax, v);
    }
  }
  const pad = 28;
  const X = (z: number) => pad + (z / 255) * (W - 2 * pad);
  const Y = (g: number) => H - pad - ((g - gmin) / (gmax - gmin || 1)) * (H - 2 * pad);
  // 坐标轴
  ctx.strokeStyle = '#313c49';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad, pad);
  ctx.lineTo(pad, H - pad);
  ctx.lineTo(W - pad, H - pad);
  ctx.stroke();
  ctx.fillStyle = '#9aa7b4';
  ctx.font = '10px sans-serif';
  ctx.fillText('ln 曝光', pad, pad - 10);
  ctx.fillText('像素值 z', W - 60, H - 8);
  for (let ch = 0; ch < 3; ch++) {
    ctx.strokeStyle = colors[ch];
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let z = 2; z < 254; z++) {
      const x = X(z);
      const y = Y(curve.g[ch * 256 + z]);
      if (z === 2) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  const legend = ['R', 'G', 'B'];
  legend.forEach((t, i) => {
    ctx.fillStyle = colors[i];
    ctx.fillText(t, W - 48 + i * 14, pad + 4);
  });
}
