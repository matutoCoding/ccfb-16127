/**
 * 颜料目录：真实义眼制作常用色号（按层分组）。
 * 色号采用工作室常见矿物/丙烯颜料命名，hex 为颜料在标准涂布下的 sRGB 表现色，
 * 运行时统一解码到线性 RGB 参与叠色。
 */
import { hexToLinearRgb, type RGB } from '../core/color';

export interface Pigment {
  id: string;
  name: string;
  code: string;
  hex: string;
  layer: 'base' | 'fibers' | 'collarette' | 'spots' | 'sclera' | 'vessels';
}

export const PIGMENT_CATALOG: Pigment[] = [
  // —— 虹膜底色层 ——
  { id: 'base-brown-deep', name: '深棕褐', code: 'UM-301', hex: '#4a2c14', layer: 'base' },
  { id: 'base-brown-warm', name: '暖栗棕', code: 'UM-302', hex: '#6b4423', layer: 'base' },
  { id: 'base-hazel', name: '榛褐', code: 'UM-303', hex: '#8a6a3a', layer: 'base' },
  { id: 'base-green-olive', name: '橄榄绿', code: 'UM-401', hex: '#5a6b3a', layer: 'base' },
  { id: 'base-green', name: '苔绿', code: 'UM-402', hex: '#3f6b4f', layer: 'base' },
  { id: 'base-blue-grey', name: '灰蓝', code: 'UM-501', hex: '#5a7a94', layer: 'base' },
  { id: 'base-blue', name: '湖蓝', code: 'UM-502', hex: '#3d6f9e', layer: 'base' },
  { id: 'base-blue-deep', name: '深海蓝', code: 'UM-503', hex: '#27496d', layer: 'base' },
  { id: 'base-grey', name: '石板灰', code: 'UM-601', hex: '#6e7478', layer: 'base' },

  // —— 放射纹层 ——
  { id: 'fiber-amber', name: '琥珀金', code: 'FB-101', hex: '#b8863b', layer: 'fibers' },
  { id: 'fiber-rust', name: '铁锈红', code: 'FB-102', hex: '#8a4b2a', layer: 'fibers' },
  { id: 'fiber-ochre', name: '赭黄', code: 'FB-103', hex: '#a07d3c', layer: 'fibers' },
  { id: 'fiber-teal', name: '青绿', code: 'FB-201', hex: '#4d8a7d', layer: 'fibers' },
  { id: 'fiber-slate', name: '岩灰', code: 'FB-301', hex: '#7d8c96', layer: 'fibers' },
  { id: 'fiber-navy', name: '藏青', code: 'FB-302', hex: '#34506e', layer: 'fibers' },

  // —— 卷缩轮 ——
  { id: 'collar-gold', name: '金棕卷缩', code: 'CL-201', hex: '#9c7a3e', layer: 'collarette' },
  { id: 'collar-rust', name: '红棕卷缩', code: 'CL-202', hex: '#7a4526', layer: 'collarette' },
  { id: 'collar-olive', name: '橄榄卷缩', code: 'CL-203', hex: '#6f7a45', layer: 'collarette' },
  { id: 'collar-blue', name: '蓝灰卷缩', code: 'CL-204', hex: '#5b7a92', layer: 'collarette' },

  // —— 色素斑（隐花色素/痣） ——
  { id: 'spot-darkbrown', name: '深褐色素斑', code: 'SP-901', hex: '#2e1b0c', layer: 'spots' },
  { id: 'spot-rust', name: '红棕色素斑', code: 'SP-902', hex: '#5e3220', layer: 'spots' },
  { id: 'spot-charcoal', name: '炭黑色素斑', code: 'SP-903', hex: '#26282b', layer: 'spots' },

  // —— 巩膜 ——
  { id: 'sclera-warm', name: '暖白巩膜', code: 'SC-001', hex: '#e8e2d4', layer: 'sclera' },
  { id: 'sclera-neutral', name: '中性巩膜白', code: 'SC-002', hex: '#e6e8ea', layer: 'sclera' },
  { id: 'sclera-yellow', name: '淡黄巩膜底', code: 'SC-010', hex: '#d8cfa8', layer: 'sclera' },
  { id: 'vessel-red', name: '朱砂红血管', code: 'VS-101', hex: '#b44a42', layer: 'vessels' },
  { id: 'vessel-deep', name: '绛红血管', code: 'VS-102', hex: '#8a3a3a', layer: 'vessels' },
  { id: 'vessel-pink', name: '粉细血管', code: 'VS-103', hex: '#cf8a86', layer: 'vessels' },
];

const pigmentMap = new Map(PIGMENT_CATALOG.map((p) => [p.id, p]));

export function getPigment(id: string): Pigment {
  const p = pigmentMap.get(id);
  if (!p) throw new Error(`未知颜料色号：${id}`);
  return p;
}

export function pigmentLinear(id: string): RGB {
  return hexToLinearRgb(getPigment(id).hex);
}

export function pigmentsByLayer(layer: Pigment['layer']): Pigment[] {
  return PIGMENT_CATALOG.filter((p) => p.layer === layer);
}
