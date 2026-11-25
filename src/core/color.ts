// 颜色科学基础：线性 sRGB / XYZ / Lab / CIEDE2000 / 色温与 Bradford 色适应
// 全部纯函数，可在 Node(tsx) 与浏览器中运行，是 HDR 验收脚本与 App 共用的唯一实现。

export type RGB = [number, number, number]; // 线性 sRGB，D65，分量可 >1（HDR）
export type Lab = [number, number, number];

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

// ---------- sRGB 传递函数 ----------
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
export function linearToSrgb(c: number): number {
  c = clamp(c, 0, 1);
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}
export function hexToRgb255(hex: string): RGB {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function hexToLinear(hex: string): RGB {
  const [r, g, b] = hexToRgb255(hex);
  return [srgbToLinear(r / 255), srgbToLinear(g / 255), srgbToLinear(b / 255)];
}
export function linearToHex(rgb: RGB): string {
  const f = (v: number) => Math.round(clamp(linearToSrgb(v), 0, 1) * 255).toString(16).padStart(2, '0');
  return `#${f(rgb[0])}${f(rgb[1])}${f(rgb[2])}`;
}

// ---------- XYZ（sRGB D65） ----------
export function linearToXyz([r, g, b]: RGB): RGB {
  return [
    0.4124564 * r + 0.3575761 * g + 0.1804375 * b,
    0.2126729 * r + 0.7151522 * g + 0.072175 * b,
    0.0193339 * r + 0.119192 * g + 0.9503041 * b,
  ];
}
export function xyzToLinear([x, y, z]: RGB): RGB {
  return [
    3.2404542 * x - 1.5371385 * y - 0.4985314 * z,
    -0.969266 * x + 1.8760108 * y + 0.041556 * z,
    0.0556434 * x - 0.2040259 * y + 1.0572252 * z,
  ];
}

// D65 白点
export const D65: RGB = [0.95047, 1.0, 1.08883];

export function xyzToLab([x, y, z]: RGB, white: RGB = D65): Lab {
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const fx = f(x / white[0]);
  const fy = f(y / white[1]);
  const fz = f(z / white[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
export function labToXyz([L, a, b]: Lab, white: RGB = D65): RGB {
  const fy = (L + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;
  const finv = (t: number) => (t ** 3 > 216 / 24389 ? t ** 3 : (t - 4 / 29) / (841 / 108));
  return [white[0] * finv(fx), white[1] * finv(fy), white[2] * finv(fz)];
}
export function linearToLab(rgb: RGB): Lab {
  return xyzToLab(linearToXyz(rgb));
}
export function labToLinear(lab: Lab): RGB {
  return xyzToLinear(labToXyz(lab));
}

// ---------- CIEDE2000 ----------
export function deltaE2000(lab1: Lab, lab2: Lab): number {
  const [L1, a1, b1] = lab1;
  const [L2, a2, b2] = lab2;
  const avgL = (L1 + L2) / 2;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const avgC = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(avgC ** 7 / (avgC ** 7 + 25 ** 7)));
  const a1p = a1 * (1 + G);
  const a2p = a2 * (1 + G);
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const avgCp = (C1p + C2p) / 2;
  const h1p = (Math.atan2(b1, a1p) * 180) / Math.PI + (Math.atan2(b1, a1p) < 0 ? 360 : 0);
  const h2p = (Math.atan2(b2, a2p) * 180) / Math.PI + (Math.atan2(b2, a2p) < 0 ? 360 : 0);
  let avghp: number;
  if (Math.abs(h1p - h2p) > 180) avghp = (h1p + h2p + 360) / 2;
  else avghp = (h1p + h2p) / 2;
  if (C1p * C2p === 0) avghp = h1p + h2p;
  const T =
    1 -
    0.17 * Math.cos(((avghp - 30) * Math.PI) / 180) +
    0.24 * Math.cos(((2 * avghp) * Math.PI) / 180) +
    0.32 * Math.cos(((3 * avghp + 6) * Math.PI) / 180) -
    0.2 * Math.cos(((4 * avghp - 63) * Math.PI) / 180);
  let dhp: number;
  if (C1p * C2p === 0) dhp = 0;
  else if (Math.abs(h2p - h1p) <= 180) dhp = h2p - h1p;
  else if (h2p - h1p > 180) dhp = h2p - h1p - 360;
  else dhp = h2p - h1p + 360;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * Math.PI / 180);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  const Sl = 1 + (0.015 * (avgL - 50) ** 2) / Math.sqrt(20 + (avgL - 50) ** 2);
  const Sc = 1 + 0.045 * avgCp;
  const Sh = 1 + 0.015 * avgCp * T;
  const dTheta = 30 * Math.exp(-(((avghp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(avgCp ** 7 / (avgCp ** 7 + 25 ** 7));
  const Rt = -Math.sin((2 * dTheta * Math.PI) / 180) * Rc;
  const kL = 1, kC = 1, kH = 1;
  return Math.sqrt(
    (dLp / (kL * Sl)) ** 2 +
      (dCp / (kC * Sc)) ** 2 +
      (dHp / (kH * Sh)) ** 2 +
      Rt * (dCp / (kC * Sc)) * (dHp / (kH * Sh)),
  );
}

// ---------- 色温 / 光源 ----------
// Tanner Helland 近似，返回 0..255 sRGB 色（仅用于光源标识与粗略线性倍增）
export function kelvinToRgb255(k: number): RGB {
  const t = k / 100;
  let r: number, g: number, b: number;
  r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return [clamp(r, 0, 255), clamp(g, 0, 255), clamp(b, 0, 255)];
}
export function kelvinToLinear(k: number): RGB {
  const [r, g, b] = kelvinToRgb255(k);
  return [srgbToLinear(r / 255), srgbToLinear(g / 255), srgbToLinear(b / 255)];
}

// Bradford 色适应：把 XYZ 从 srcWhite 适应到 dstWhite(D65)
const BRADFORD = [
  [0.8951, 0.2664, -0.1614],
  [-0.7502, 1.7135, 0.0367],
  [0.0389, -0.0685, 1.0296],
];
const BRADFORD_INV = [
  [0.9869929, -0.1470543, 0.1599627],
  [0.4323053, 0.5183603, 0.0492912],
  [-0.0085287, 0.0400428, 0.9684867],
];
function mul3(m: number[][], v: RGB): RGB {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}
export function adaptWhite(xyz: RGB, srcWhite: RGB, dstWhite: RGB = D65): RGB {
  const src = mul3(BRADFORD, srcWhite);
  const dst = mul3(BRADFORD, dstWhite);
  const cone = mul3(BRADFORD, xyz);
  const adapted: RGB = [
    (cone[0] * dst[0]) / src[0],
    (cone[1] * dst[1]) / src[1],
    (cone[2] * dst[2]) / src[2],
  ];
  return mul3(BRADFORD_INV, adapted);
}

// 由光源色温求其白点 XYZ（用 sRGB 光源色近似），再给 WB 通道增益
export function whiteBalanceGainsFromKelvin(k: number): RGB {
  const lin = kelvinToLinear(k);
  // 灰世界：让光源色中和为等能灰
  const mid = (lin[0] + lin[1] + lin[2]) / 3;
  return [mid / lin[0], mid / lin[1], mid / lin[2]];
}

export function applyGains(rgb: RGB, gains: RGB): RGB {
  return [rgb[0] * gains[0], rgb[1] * gains[1], rgb[2] * gains[2]];
}

// 灰世界白平衡增益（从线性 HDR 图的指定 ROI 统计）
export function grayWorldGains(data: Float32Array, n: number, mask?: Uint8Array): RGB {
  let r = 0, g = 0, b = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    if (mask && !mask[i]) continue;
    r += data[i * 3];
    g += data[i * 3 + 1];
    b += data[i * 3 + 2];
    cnt++;
  }
  if (!cnt) return [1, 1, 1];
  r /= cnt; g /= cnt; b /= cnt;
  const mid = (r + g + b) / 3 || 1e-6;
  return [mid / (r || 1e-6), mid / (g || 1e-6), mid / (b || 1e-6)];
}
