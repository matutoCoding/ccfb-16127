/**
 * 程序化义眼/健侧眼模型（CPU 参考实现，scene-linear HDR 输出）。
 *
 * 分层结构与技师手绘一致，从下到上：
 *   巩膜淡黄底 → 巩膜血管 → 虹膜底色层（含根部加深 + 基质噪声）
 *   → 放射纹层 → 卷缩轮 → 色素斑 → 瞳孔 → 角膜缘暗环
 *   → 透明角膜凸面（菲涅耳缘 + 镜面高光）→ 巩膜湿润光泽
 *
 * 颜色混合全部在线性 RGB 域按 coverage/opacity 加权，不做位深截断。
 * WGSL 渲染器（render/shaders/eye.wgsl）逐函数移植本文件，数学保持一致；
 * 本实现是验收测试的数值基准。
 */
import type { FloatImage, LightingScene, PaintScheme } from '../core/types';
import { makeFloatImage } from '../core/image';
import { fbm, hash2, mulberry32, valueNoise } from '../core/rng';
import { pigmentLinear } from '../pigment/catalog';
import type { RGB } from '../core/color';

export interface IrisGeometry {
  centerX: number;
  centerY: number;
  irisRadius: number;
  pupilRadius: number;
}

export interface RenderEyeOptions {
  size: number;
  /** 覆盖方案里的瞳孔比例（场景动态瞳孔用）；不传则用 scheme.pupilFraction */
  pupilFractionOverride?: number;
  /** 巩膜血管/纤维形态的种子覆盖（默认用 scheme.seed） */
  seedOffset?: number;
}

export interface EyeRenderOutput {
  hdr: FloatImage;
  geometry: IrisGeometry;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function mixRgb(a: RGB, b: RGB, t: number): RGB {
  return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
}

function scaleRgb(a: RGB, k: number): RGB {
  return [a[0] * k, a[1] * k, a[2] * k];
}

function addRgb(a: RGB, b: RGB): RGB {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

/** 巩膜血管：随机游走折线，返回像素覆盖率场（0..1） */
function buildVesselField(size: number, seed: number, count: number, coverage: number): Float32Array {
  const field = new Float32Array(size * size);
  const rand = mulberry32(seed * 7919 + 17);
  const cx = size / 2;
  const cy = size / 2;
  const eyeR = size * 0.48;
  for (let v = 0; v < count; v++) {
    // 从眼白边缘向虹膜方向生长
    const angle = rand() * Math.PI * 2;
    const startR = eyeR * (0.75 + rand() * 0.22);
    let x = cx + Math.cos(angle) * startR;
    let y = cy + Math.sin(angle) * startR;
    let dir = angle + Math.PI + (rand() - 0.5) * 0.9;
    const steps = 6 + Math.floor(rand() * 10);
    const width = 0.55 + rand() * 0.9;
    for (let s = 0; s < steps; s++) {
      dir += (rand() - 0.5) * 0.55;
      const nx = x + Math.cos(dir) * size * 0.018;
      const ny = y + Math.sin(dir) * size * 0.018;
      stampLine(field, size, x, y, nx, ny, width);
      x = nx;
      y = ny;
      const r = Math.hypot(x - cx, y - cy);
      if (r < eyeR * 0.62) break; // 不越过虹膜区
    }
  }
  // 全局强度按 coverage 收敛
  const gain = coverage * 2.2;
  for (let i = 0; i < field.length; i++) field[i] = clamp01(field[i] * gain);
  return field;
}

function stampLine(field: Float32Array, size: number, x0: number, y0: number, x1: number, y1: number, width: number): void {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(dist));
  const r = Math.ceil(width) + 1;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = mix(x0, x1, t);
    const y = mix(y0, y1, t);
    const ix = Math.round(x);
    const iy = Math.round(y);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const px = ix + dx;
        const py = iy + dy;
        if (px < 0 || py < 0 || px >= size || py >= size) continue;
        const d = Math.hypot(px - x, py - y);
        const a = Math.exp(-(d * d) / (2 * width * width));
        const idx = py * size + px;
        field[idx] = Math.max(field[idx], a);
      }
    }
  }
}

/** 放射纹：以角度+半径索引的 fbm 脊线，返回局部纤维强度 0..1 */
function fiberStrength(theta: number, rNorm: number, seed: number, density: number): number {
  // 沿角度快速变化、沿半径缓慢变化 → 放射状条纹
  const a = theta * 26 + fbm(Math.cos(theta) * 3, Math.sin(theta) * 3, seed, 3) * 6;
  const ridge = 0.5 + 0.5 * Math.sin(a + rNorm * 2.2);
  const sharp = Math.pow(ridge, 3);
  const gate = fbm(Math.cos(theta) * 6 + 5, Math.sin(theta) * 6 + 5, seed + 7, 3);
  return clamp01(sharp * gate * density * 1.6);
}

/** 卷缩轮：带锯齿边界的环带，rNorm ∈ [0.34, 0.56] */
function collaretteStrength(theta: number, rNorm: number, seed: number): number {
  const wobbleInner = 0.36 + 0.035 * Math.sin(theta * 7 + fbm(2, 3, seed, 2) * 4);
  const wobbleOuter = 0.55 + 0.04 * Math.sin(theta * 6 + 1.7);
  const inner = smoothStep(wobbleInner, wobbleInner + 0.03, rNorm);
  const outer = 1 - smoothStep(wobbleOuter - 0.03, wobbleOuter, rNorm);
  return clamp01(inner * outer);
}

function smoothStep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** 色素斑：若干确定性高斯斑 */
function spotStrength(x: number, y: number, seed: number, count: number, coverage: number): number {
  const rand = mulberry32(seed * 131 + 99);
  let strength = 0;
  for (let i = 0; i < count; i++) {
    const ang = rand() * Math.PI * 2;
    const rr = 0.52 + rand() * 0.4;
    const sx = Math.cos(ang) * rr;
    const sy = Math.sin(ang) * rr;
    const sigma = 0.02 + rand() * 0.05;
    const d2 = (x - sx) ** 2 + (y - sy) ** 2;
    strength = Math.max(strength, Math.exp(-d2 / (2 * sigma * sigma)));
  }
  return clamp01(strength * coverage * 1.5);
}

/**
 * 渲染一只眼睛的 HDR 辐照图。
 * 健侧眼与义眼共用本函数：区别只在 PaintScheme 与瞳孔比例。
 */
export function renderEye(scheme: PaintScheme, scene: LightingScene, opts: RenderEyeOptions): EyeRenderOutput {
  const size = opts.size;
  const hdr = makeFloatImage(size, size);
  const seed = scheme.seed + (opts.seedOffset ?? 0);
  const cx = size / 2;
  const cy = size / 2;
  const eyeRadius = size * 0.48;
  const irisRadius = size * 0.27;
  const pupilFraction = opts.pupilFractionOverride ?? scheme.pupilFraction;
  const pupilRadius = irisRadius * pupilFraction;

  // —— 预计算颜料线性色 ——
  const cBase = pigmentLinear(scheme.base.pigmentId);
  const cFiber = pigmentLinear(scheme.fibers.pigmentId);
  const cCollar = pigmentLinear(scheme.collarette.pigmentId);
  const cSpot = pigmentLinear(scheme.spots.pigmentId);
  const cSclera = pigmentLinear(scheme.scleraBase.pigmentId);
  const cYellow = pigmentLinear('sclera-yellow');
  const cVessel = pigmentLinear(scheme.vessels.pigmentId);

  const vesselField = buildVesselField(size, seed, Math.round(14 + scheme.vessels.coverage * 26), scheme.vessels.coverage);

  // 高光中心（角膜凸面把主光反射到对侧偏移位）
  const hlX = cx + scene.lightDir[0] * irisRadius * 0.95 - irisRadius * 0.15;
  const hlY = cy + scene.lightDir[1] * irisRadius * 0.95 - irisRadius * 0.25;
  const hlSigma = irisRadius * (0.16 - scheme.cornea.gloss * 0.07);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const dx = (px - cx) / irisRadius;
      const dy = (py - cy) / irisRadius;
      const rIris = Math.hypot(dx, dy); // 以虹膜半径归一
      const rEye = Math.hypot(px - cx, py - cy) / eyeRadius;
      const theta = Math.atan2(dy, dx);
      const idx = (py * size + px) * 3;

      if (rEye > 1) {
        // 眼球外：暗背景（眼皮/诊室环境的极简替代）
        const bg = 0.02 * scene.diffuseGain;
        hdr.data[idx] = bg * scene.whitePoint[0];
        hdr.data[idx + 1] = bg * scene.whitePoint[1];
        hdr.data[idx + 2] = bg * scene.whitePoint[2];
        continue;
      }

      let color: RGB;

      if (rIris >= 1) {
        // —— 巩膜区 ——
        const edgeShade = 1 - 0.35 * smoothStep(0.75, 1, rEye);
        // 淡黄底色：边缘（内外眦）更黄，用 fbm 做不均匀色块
        const yellowPatch = fbm(px / size * 7, py / size * 7, seed + 31, 4) * (0.35 + 0.65 * rEye);
        let sclera = mixRgb(cSclera, cYellow, clamp01(yellowPatch * scheme.scleraBase.coverage));
        // 血管
        const vAlpha = clamp01(vesselField[py * size + px] * scheme.vessels.opacity);
        sclera = mixRgb(sclera, cVessel, vAlpha);
        color = scaleRgb(sclera, edgeShade);
      } else {
        // —— 虹膜区 ——
        // 1) 底色层：瞳孔根部加深，周边略亮，叠基质噪声；
        //    再加像素级高频微纹理（真实虹膜基质的细密纤维），也为多曝光配准提供可靠梯度特征。
        const rootDarken = 1 - 0.45 * (1 - smoothStep(pupilFraction, pupilFraction + 0.18, rIris));
        const stroma = 0.82 + 0.36 * fbm(dx * 4 + 9, dy * 4 + 9, seed + 3, 4);
        const micro = 1 + (hash2(px, py, seed + 77) - 0.5) * 0.12 + (valueNoise(px * 0.9, py * 0.9, seed + 5) - 0.5) * 0.1;
        let iris = scaleRgb(cBase, rootDarken * stroma * micro);
        iris = scaleRgb(iris, scheme.base.opacity);

        if (rIris > pupilFraction) {
          // 2) 放射纹层
          const fStr = fiberStrength(theta, rIris, seed + 11, scheme.fibers.coverage) * scheme.fibers.opacity;
          iris = mixRgb(iris, cFiber, clamp01(fStr));

          // 3) 卷缩轮
          const cStr = collaretteStrength(theta, rIris, seed + 21) * scheme.collarette.coverage * scheme.collarette.opacity;
          iris = mixRgb(iris, cCollar, clamp01(cStr));

          // 4) 色素斑
          const sStr = spotStrength(dx, dy, seed + 41, Math.round(4 + scheme.spots.coverage * 10), scheme.spots.coverage) *
            scheme.spots.opacity;
          iris = mixRgb(iris, cSpot, clamp01(sStr));
        }

        // 5) 角膜缘暗环
        const limbal = smoothStep(0.9, 1.0, rIris);
        iris = scaleRgb(iris, 1 - 0.55 * limbal);

        // 6) 瞳孔（深色，带极弱的眼底暗红）
        if (rIris <= pupilFraction) {
          const pupilGlow = 0.012 + 0.006 * fbm(dx * 10, dy * 10, seed + 51, 2);
          iris = [pupilGlow * 0.8, pupilGlow * 0.35, pupilGlow * 0.3];
        }
        color = iris;
      }

      // —— 场景光照：漫射 × 白点染色 ——
      color = scaleRgb([color[0] * scene.whitePoint[0], color[1] * scene.whitePoint[1], color[2] * scene.whitePoint[2]], scene.diffuseGain);

      // —— 透明角膜凸面 ——
      if (rIris <= 1.06) {
        // 菲涅耳缘：虹膜边缘一圈冷色反射
        const fresnel = 0.12 * smoothStep(0.82, 1.05, rIris);
        color = addRgb(color, scaleRgb(scene.whitePoint, fresnel * scene.diffuseGain));
        // 镜面高光（高斯亮斑），凸面曲率越大越集中。
        // 增益足够大，使亮斑在最暗曝光帧仍接近饱和——真实角膜反光正是如此，
        // 也让高光掩膜能可靠地把它识别出来（亮斑绝不参与虹膜取色）。
        const dhl = Math.hypot(px - hlX, py - hlY);
        const spec = Math.exp(-(dhl * dhl) / (2 * hlSigma * hlSigma)) * scene.specularGain * scheme.cornea.gloss;
        color = addRgb(color, scaleRgb(scene.whitePoint, spec * 7.0));
      }

      // —— 巩膜湿润光泽：低强度宽幅 sheen ——
      if (rIris > 1) {
        const wet = scheme.wetness * 0.10 * Math.max(0, 1 - rEye) * scene.specularGain;
        color = addRgb(color, scaleRgb(scene.whitePoint, wet));
      }

      hdr.data[idx] = color[0];
      hdr.data[idx + 1] = color[1];
      hdr.data[idx + 2] = color[2];
    }
  }

  return {
    hdr,
    geometry: { centerX: cx, centerY: cy, irisRadius, pupilRadius },
  };
}

/** 默认配色方案工厂（深棕眼，中性参数） */
export function defaultPaintScheme(patientId: string, seed = 20261126): PaintScheme {
  const layer = (key: string, pigmentId: string, coverage: number, opacity = 1): PaintScheme['base'] => ({
    key,
    pigmentId,
    coverage,
    opacity,
    params: {},
  });
  return {
    id: `scheme-${patientId}`,
    patientId,
    name: '初始方案',
    base: layer('base', 'base-brown-warm', 1),
    fibers: layer('fibers', 'fiber-amber', 0.55),
    collarette: layer('collarette', 'collar-gold', 0.7),
    spots: layer('spots', 'spot-darkbrown', 0.35),
    scleraBase: layer('scleraBase', 'sclera-warm', 0.45),
    vessels: layer('vessels', 'vessel-red', 0.5),
    cornea: { curvature: 1.0, ior: 1.376, gloss: 0.75 },
    pupilFraction: 0.42,
    wetness: 0.5,
    seed,
    createdAt: Date.now(),
  };
}

/** 供测试/合成数据使用的环形几何（与渲染输出一致） */
export function irisGeometry(size: number, pupilFraction: number): IrisGeometry {
  const irisRadius = size * 0.27;
  return {
    centerX: size / 2,
    centerY: size / 2,
    irisRadius,
    pupilRadius: irisRadius * pupilFraction,
  };
}

export { hash2 };
