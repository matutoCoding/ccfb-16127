/**
 * 颜色科学：sRGB 编解码、线性 RGB↔XYZ（D65）、XYZ↔Lab、CIEDE2000。
 * 全部基于线性浮点数据，绝不在 HDR 管线上做 8 位截断。
 */

export type RGB = [number, number, number];

/** sRGB 编码值 [0,1] → 线性光强 */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** 线性光强 → sRGB 编码 [0,1]（不做截断，超色域由调用方按相机曲线/钳位处理） */
export function linearToSrgb(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return v;
}

export function srgb8ToLinear(byte: number): number {
  return srgbToLinear(byte / 255);
}

/** 0..255 sRGB 字节 → 线性 RGB */
export function pixelToLinear(r: number, g: number, b: number): RGB {
  return [srgb8ToLinear(r), srgb8ToLinear(g), srgb8ToLinear(b)];
}

/** 线性 RGB → 0..255 sRGB 字节（钳位） */
export function linearToByte(r: number, g: number, b: number): [number, number, number] {
  const clamp = (v: number) => Math.min(255, Math.max(0, Math.round(linearToSrgb(v) * 255)));
  return [clamp(r), clamp(g), clamp(b)];
}

// sRGB D65 → XYZ
const M_RGB2XYZ: ReadonlyArray<readonly number[]> = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.072175],
  [0.0193339, 0.119192, 0.9503041],
];
const M_XYZ2RGB: ReadonlyArray<readonly number[]> = [
  [3.2404542, -1.5371385, -0.4985314],
  [-0.969266, 1.8760108, 0.041556],
  [0.0556434, -0.2040259, 1.0572252],
];

export function linearRgbToXyz(rgb: RGB): RGB {
  const [r, g, b] = rgb;
  return [
    M_RGB2XYZ[0][0] * r + M_RGB2XYZ[0][1] * g + M_RGB2XYZ[0][2] * b,
    M_RGB2XYZ[1][0] * r + M_RGB2XYZ[1][1] * g + M_RGB2XYZ[1][2] * b,
    M_RGB2XYZ[2][0] * r + M_RGB2XYZ[2][1] * g + M_RGB2XYZ[2][2] * b,
  ];
}

export function xyzToLinearRgb(xyz: RGB): RGB {
  const [x, y, z] = xyz;
  return [
    M_XYZ2RGB[0][0] * x + M_XYZ2RGB[0][1] * y + M_XYZ2RGB[0][2] * z,
    M_XYZ2RGB[1][0] * x + M_XYZ2RGB[1][1] * y + M_XYZ2RGB[1][2] * z,
    M_XYZ2RGB[2][0] * x + M_XYZ2RGB[2][1] * y + M_XYZ2RGB[2][2] * z,
  ];
}

/** D65 参考白点 */
export const D65: RGB = [0.95047, 1.0, 1.08883];

function pivotLab(t: number): number {
  const d = 6 / 29;
  return t > d ** 3 ? Math.cbrt(t) : t / (3 * d * d) + 4 / 29;
}

function pivotLabInv(f: number): number {
  const d = 6 / 29;
  return f > d ? f ** 3 : 3 * d * d * (f - 4 / 29);
}

/** XYZ（D65）→ CIELAB */
export function xyzToLab(xyz: RGB, white: RGB = D65): RGB {
  const fx = pivotLab(xyz[0] / white[0]);
  const fy = pivotLab(xyz[1] / white[1]);
  const fz = pivotLab(xyz[2] / white[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function labToXyz(lab: RGB, white: RGB = D65): RGB {
  const L = lab[0];
  const fy = (L + 16) / 116;
  const fx = fy + lab[1] / 500;
  const fz = fy - lab[2] / 200;
  return [white[0] * pivotLabInv(fx), white[1] * pivotLabInv(fy), white[2] * pivotLabInv(fz)];
}

/** 线性 RGB → Lab（D65），色差计算的统一入口 */
export function linearRgbToLab(rgb: RGB): RGB {
  return xyzToLab(linearRgbToXyz([rgb[0], rgb[1], rgb[2]]));
}

/**
 * CIEDE2000 色差（Sharma 2005 修正版，含全部分量）。
 * 输入两个 Lab，返回 ΔE00。
 */
export function deltaE00(lab1: RGB, lab2: RGB): number {
  const [L1, a1, b1] = lab1;
  const [L2, a2, b2] = lab2;

  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;

  const Cbar7 = Cbar ** 7;
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + 25 ** 7)));

  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);

  const h1p = hueAngle(b1, a1p);
  const h2p = hueAngle(b2, a2p);

  const dLp = L2 - L1;
  const dCp = C2p - C1p;

  let dhp: number;
  if (C1p * C2p === 0) {
    dhp = 0;
  } else {
    let diff = h2p - h1p;
    if (diff > 180) diff -= 360;
    else if (diff < -180) diff += 360;
    dhp = diff;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * Math.PI) / 360);

  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;

  let hbarp: number;
  if (C1p * C2p === 0) {
    hbarp = h1p + h2p;
  } else {
    const sum = h1p + h2p;
    if (Math.abs(h1p - h2p) > 180) {
      hbarp = sum < 360 ? (sum + 360) / 2 : (sum - 360) / 2;
    } else {
      hbarp = sum / 2;
    }
  }

  const T =
    1 -
    0.17 * Math.cos(deg(hbarp - 30)) +
    0.24 * Math.cos(deg(2 * hbarp)) +
    0.32 * Math.cos(deg(3 * hbarp + 6)) -
    0.2 * Math.cos(deg(4 * hbarp - 63));

  const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2));
  const Cbarp7 = Cbarp ** 7;
  const Rc = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbarp - 50) ** 2) / Math.sqrt(20 + (Lbarp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbarp;
  const Sh = 1 + 0.015 * Cbarp * T;
  const Rt = -Math.sin(deg(2 * dTheta)) * Rc;

  const kL = 1;
  const kC = 1;
  const kH = 1;

  const termL = dLp / (kL * Sl);
  const termC = dCp / (kC * Sc);
  const termH = dHp / (kH * Sh);
  return Math.sqrt(termL ** 2 + termC ** 2 + termH ** 2 + Rt * termC * termH);
}

function hueAngle(b: number, ap: number): number {
  if (ap === 0 && b === 0) return 0;
  let h = (Math.atan2(b, ap) * 180) / Math.PI;
  if (h < 0) h += 360;
  return h;
}

function deg(rad: number): number {
  return (rad * Math.PI) / 180;
}

/** 两个线性 RGB 的 ΔE00 便捷封装 */
export function deltaE00Rgb(rgb1: RGB, rgb2: RGB): number {
  return deltaE00(linearRgbToLab(rgb1), linearRgbToLab(rgb2));
}

/**
 * 白平衡：把给定白点（线性）缩放为 D65 中性灰。
 * 采用 Bradford-adapted 简化的对角缩放，保证 HDR 域线性操作。
 */
export function whiteBalance(rgb: RGB, white: RGB): RGB {
  if (white[0] === 0 || white[1] === 0 || white[2] === 0) return rgb;
  return [
    (rgb[0] * D65[0]) / white[0],
    (rgb[1] * D65[1]) / white[1],
    (rgb[2] * D65[2]) / white[2],
  ];
}

/** sRGB 色号（hex）→ 线性 RGB。颜料目录/场景白点的统一解析入口 */
export function hexToLinearRgb(hex: string): RGB {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return [srgb8ToLinear(r), srgb8ToLinear(g), srgb8ToLinear(b)];
}

export function linearRgbToHex(rgb: RGB): string {
  const [r, g, b] = linearToByte(rgb[0], rgb[1], rgb[2]);
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}
