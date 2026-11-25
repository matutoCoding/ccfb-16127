// 方案 → 过响应曲线编码的 Canvas（CPU 参考链路，指标同源）。
import { renderEyeLinear } from '../core/eyeRenderer';
import { encodeRadiance, sceneWbGains } from '../core/pipeline';
import type { RGB } from '../core/color';
import type { EyeGeometry, IrisScheme, ResponseCurve } from '../core/types';
import { sceneById } from '../core/scenes';

export function schemeToLdrCanvas(
  scheme: IrisScheme,
  geom: EyeGeometry,
  curve: ResponseCurve,
  opts: { size?: number; gain: number; wb?: RGB; sceneId?: string; irisDiameterMm: number; evOffset?: number },
): HTMLCanvasElement {
  const size = opts.size ?? 360;
  const scene = sceneById(opts.sceneId ?? 'clinic');
  const wb = opts.wb ?? (opts.sceneId && opts.sceneId !== 'clinic' ? sceneWbGains(scene) : ([1, 1, 1] as RGB));
  const lin = renderEyeLinear(scheme, geom, { size, scene, irisDiameterMm: opts.irisDiameterMm });
  const ldr = encodeRadiance(lin, { curve, wb, gain: opts.gain, evOffset: opts.evOffset ?? scene.exposureEv });
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(ldr.data), size, size), 0, 0);
  return c;
}

export function ldrDataToCanvas(data: Uint8ClampedArray, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data), w, h), 0, 0);
  return c;
}
