// 颜料目录：工作室色号 + 真实 Colour Index 颜料通用名（PW6/PBr7…）
// hex 为管装颜料的 sRGB 外观；lin 为线性近似反射率，用于线性光分层叠加。
import { hexToLinear, type RGB } from './color';

export interface Pigment {
  id: string;
  studioCode: string; // 工作室色号
  name: string; // 中文常用名
  ci: string; // Colour Index 通用名（真实颜料索引名）
  hex: string;
  lin: RGB;
  staining: number; // 着色力 0..1，影响混合权重
}

function p(id: string, studioCode: string, name: string, ci: string, hex: string, staining = 1): Pigment {
  return { id, studioCode, name, ci, hex, lin: hexToLinear(hex), staining };
}

export const PIGMENTS: Pigment[] = [
  p('PW6', 'W-01', '钛白', 'Pigment White 6', '#f4f1e8', 0.55),
  p('PY42', 'Y-07', '土黄/赭黄', 'Pigment Yellow 42', '#c79a3f', 0.9),
  p('PBr7y', 'Y-12', '生赭', 'Pigment Brown 7 (Raw Sienna)', '#b07a35', 0.95),
  p('PBr7', 'BR-03', '赭石', 'Pigment Brown 7 (Burnt Sienna)', '#8a4b2a', 1),
  p('PBr7u', 'BR-08', '熟褐/赭褐', 'Pigment Brown 7 (Burnt Umber)', '#5d3a22', 1),
  p('PBr7r', 'BR-11', '生褐', 'Pigment Brown 7 (Raw Umber)', '#6e5430', 1),
  p('PBk9', 'K-01', '象牙黑', 'Pigment Black 9', '#1c1a18', 1),
  p('PBk6', 'K-04', '灯黑', 'Pigment Black 6', '#101214', 1),
  p('PR101', 'R-05', '氧化铁红', 'Pigment Red 101', '#9c3a2c', 1),
  p('PR206', 'R-09', '喹吖啶酮绛红', 'Pigment Red 206', '#7d2438', 1),
  p('PV19', 'R-15', '喹吖啶酮玫红', 'Pigment Violet 19', '#a3405a', 0.9),
  p('PB29', 'B-02', '群青', 'Pigment Blue 29', '#27408b', 1),
  p('PB28', 'B-06', '钴蓝', 'Pigment Blue 28', '#2f6fb4', 0.9),
  p('PB15', 'B-09', '酞菁蓝', 'Pigment Blue 15:3', '#123a6b', 1),
  p('PG7', 'G-04', '酞菁绿', 'Pigment Green 7', '#14532d', 1),
  p('PG17', 'G-08', '氧化铬绿', 'Pigment Green 17', '#3f6b3a', 0.95),
  p('PG23', 'G-10', '土绿', 'Pigment Green 23', '#6b7a4a', 0.9),
  p('PY35', 'Y-02', '镉黄浅', 'Pigment Yellow 35', '#f2c014', 1),
  p('PO20', 'O-04', '镉橙', 'Pigment Orange 20', '#e0701a', 1),
  p('PW4', 'W-03', '锌白', 'Pigment White 4', '#fbfaf4', 0.4),
];

const BY_ID = new Map(PIGMENTS.map((p) => [p.id, p]));
export function pigmentById(id: string): Pigment {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`未知颜料: ${id}`);
  return found;
}

// 按比例混合颜料（线性反射率的加权光学平均；staining 修正着色力）
export function mixPigments(items: { pigmentId: string; ratio: number }[]): RGB {
  let r = 0, g = 0, b = 0, wsum = 0;
  for (const it of items) {
    if (it.ratio <= 0) continue;
    const pg = pigmentById(it.pigmentId);
    const w = it.ratio * pg.staining;
    r += pg.lin[0] * w;
    g += pg.lin[1] * w;
    b += pg.lin[2] * w;
    wsum += w;
  }
  if (wsum === 0) return [0, 0, 0];
  return [r / wsum, g / wsum, b / wsum];
}

// 不透明颜料 + 透明釉的分层覆盖（线性光 alpha-over）
export function overLinear(top: RGB, alpha: number, dst: RGB): RGB {
  return [
    top[0] * alpha + dst[0] * (1 - alpha),
    top[1] * alpha + dst[1] * (1 - alpha),
    top[2] * alpha + dst[2] * (1 - alpha),
  ];
}
