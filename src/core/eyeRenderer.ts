// 义眼片 / 健侧眼共用的 CPU 参考渲染器：
// 全程 Float32 线性光，输出可 >1 的 HDR 辐亮度。WebGPU 路径是它的并行实现，
// 指标与验收一律以这里的精确实现为准。
import { clamp, kelvinToLinear, lerp, smoothstep, type RGB } from './color';
import { Rng } from './prng';
import { pigmentById } from './pigments';
import { makeRgbImage } from './image';
import type { RgbImage } from './types';
import type { EyeGeometry, IrisScheme, SceneDef } from './types';
import { sceneById } from './scenes';

// ---------- 确定性 noise（独立哈希，避免对象开销） ----------
function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return lerp(lerp(a, b, sx), lerp(c, d, sx), sy);
}
function fbm(x: number, y: number, seed: number, oct = 3): number {
  let v = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    v += amp * vnoise(x * f, y * f, seed + i * 101);
    norm += amp;
    amp *= 0.5;
    f *= 2.07;
  }
  return v / norm;
}

export interface RenderOptions {
  size: number;
  scene?: SceneDef;
  irisDiameterMm?: number;
  innerCanthusSign?: -1 | 1; // 内眦在 dx 的哪一侧
  quant?: never;
}

interface VesselSeg {
  x0: number; y0: number; x1: number; y1: number;
  w: number; a: number; col: RGB;
}
interface Spot {
  r: number; th: number; rad: number; aspect: number; rot: number; alpha: number; seed: number;
}

export function renderEyeLinear(scheme: IrisScheme, geom: EyeGeometry, opts: RenderOptions): RgbImage {
  const S = opts.size;
  const img = makeRgbImage(S, S);
  const d = img.data;
  const scene = opts.scene ?? sceneById('clinic');
  const light = kelvinToLinear(scene.kelvin);
  const li = scene.intensity;
  const flash = scene.flash;
  const innerSign = opts.innerCanthusSign ?? -1;

  const cx = geom.cx * S;
  const cy = geom.cy * S;
  const irisPx = geom.irisR * S;
  const eyeHW = irisPx * 1.38;
  // 睑裂高度需完整容纳虹膜圆盘，保证八环带采到的都是虹膜而非眼睑/皮肤
  const eyeHH = irisPx * 1.04;

  let pupilRatio = geom.pupilR / geom.irisR;
  if (scheme.pupilDiameterMm != null && opts.irisDiameterMm && opts.irisDiameterMm > 0) {
    pupilRatio = clamp(scheme.pupilDiameterMm / opts.irisDiameterMm, 0.18, 0.6);
  }
  const rpPx = pupilRatio * irisPx;

  const bandN = scheme.bandCount;
  const bandCol: RGB[] = scheme.bandRGB.map((c) => [c[0], c[1], c[2]]);

  // 放射纹纤维参数
  const fibN = Math.floor(scheme.radial.count);
  const fibRng = new Rng(scheme.radial.seed);
  const fibGain = new Float32Array(fibN);
  const fibW = new Float32Array(fibN);
  const fibTone = new Float32Array(fibN);
  for (let i = 0; i < fibN; i++) {
    fibGain[i] = fibRng.float(0.35, 1.25) * (fibRng.bool(0.18) ? -0.55 : 1);
    fibW[i] = fibRng.float(0.55, 1.7);
    fibTone[i] = fibRng.float();
  }
  const radPig = pigmentById(scheme.radial.pigment).lin;
  const colPig = pigmentById(scheme.collarette.pigment).lin;
  const spotPig = pigmentById(scheme.spots.pigment).lin;

  // 色素斑
  const spotRng = new Rng(scheme.spots.seed);
  const spots: Spot[] = [];
  for (let i = 0; i < scheme.spots.count; i++) {
    spots.push({
      r: spotRng.float(0.28, 0.95),
      th: spotRng.float(-Math.PI, Math.PI),
      rad: spotRng.float(0.02, 0.075),
      aspect: spotRng.float(0.55, 1.5),
      rot: spotRng.float(0, Math.PI),
      alpha: spotRng.float(0.5, 1),
      seed: spotRng.int(1, 1e6),
    });
  }

  const scleraBase = pigmentById(scheme.sclera.basePigment).lin;
  const scleraYellow = pigmentById(scheme.sclera.yellowPigment).lin;

  const eyeMask = new Uint8Array(S * S);

  // ---------- Pass 1：皮肤 / 巩膜 / 虹膜 ----------
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const p = (y * S + x) * 3;
      const nx = x / S, ny = y / S;
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const dist = Math.hypot(dx, dy);
      const rRel = dist / irisPx; // 1 = 虹膜外缘
      const theta = Math.atan2(dy, dx);

      // 皮肤底色 + 柔和明暗
      const skinN = fbm(nx * 5, ny * 5, 7, 3);
      let col: RGB = [
        0.78 + (skinN - 0.5) * 0.05,
        0.55 + (skinN - 0.5) * 0.04,
        0.43 + (skinN - 0.5) * 0.035,
      ];
      // 眼眶周围微微泛红/暗
      const orbit = Math.exp(-(((dx / (eyeHW * 1.25)) ** 2) + ((dy / (eyeHH * 1.5)) ** 2)) * 1.4);
      col[0] *= 1 - orbit * 0.06;
      col[1] *= 1 - orbit * 0.1;
      col[2] *= 1 - orbit * 0.1;

      // 杏仁状睑裂
      const ex = dx / eyeHW;
      let inEye = false;
      let lidT = 0;
      if (Math.abs(ex) < 1) {
        const arc = Math.sqrt(Math.max(0, 1 - ex * ex));
        const top = -eyeHH * arc * 0.95 - eyeHH * 0.05;
        const bottom = eyeHH * arc * 1.08;
        if (dy > top && dy < bottom) {
          inEye = true;
          lidT = clamp((dy - top) / (bottom - top), 0, 1);
        }
      }

      if (inEye) {
        eyeMask[y * S + x] = 1;
        // ---- 巩膜 ----
        // 区域淡黄：内/外眦 + 上下缘
        const cn = innerSign * ex; // >0 靠近内眦
        const innerW = Math.exp(-((cn - 0.85) ** 2) / 0.12);
        const outerW = Math.exp(-((ex * innerSign + 0.85) ** 2) / 0.12);
        const upperW = smoothstep(0.45, 0.05, lidT) * 0.5;
        const lowerW = smoothstep(0.55, 0.98, lidT) * 0.55;
        const regs = scheme.sclera.regions;
        const rInner = regs.find((r) => r.key === 'innerCanthus')!;
        const rOuter = regs.find((r) => r.key === 'outerCanthus')!;
        const rUpper = regs.find((r) => r.key === 'upper')!;
        const rLower = regs.find((r) => r.key === 'lower')!;
        let yellowAmt = scheme.sclera.baseYellow * 0.25;
        yellowAmt += innerW * rInner.yellow + outerW * rOuter.yellow;
        yellowAmt += upperW * rUpper.yellow + lowerW * rLower.yellow;
        yellowAmt = clamp(yellowAmt, 0, 0.85);
        let scl: RGB = [
          lerp(scleraBase[0], scleraYellow[0], yellowAmt),
          lerp(scleraBase[1], scleraYellow[1], yellowAmt),
          lerp(scleraBase[2], scleraYellow[2], yellowAmt),
        ];
        // 巩膜球体明暗：边缘略暗、带极淡的蓝灰
        const sphere = 0.82 + 0.18 * Math.sqrt(Math.max(0, 1 - ex * ex * 0.7 - (dy / (eyeHH * 1.2)) ** 2 * 0.7));
        scl = [scl[0] * sphere, scl[1] * sphere * 1.01, scl[2] * sphere * 1.03];
        // 湿润基底微光
        scl = [scl[0] + 0.015, scl[1] + 0.015, scl[2] + 0.02];
        col = scl;

        // ---- 虹膜 ----
        if (dist <= irisPx) {
          const r = clamp(rRel, 0, 1);
          // 环带底色（平滑梯度）
          const t = clamp((dist - rpPx) / (irisPx - rpPx), 0, 1);
          const bf = t * bandN;
          const bi = Math.min(bandN - 1, Math.floor(bf));
          const bfrac = smoothstep(0, 1, bf - bi);
          const c0 = bandCol[bi];
          const c1 = bandCol[Math.min(bandN - 1, bi + 1)];
          let iris: RGB = [
            lerp(c0[0], c1[0], bfrac),
            lerp(c0[1], c1[1], bfrac),
            lerp(c0[2], c1[2], bfrac),
          ];

          // 放射纹（角度 bin + 沿半径断续）
          if (scheme.radial.enabled && rRel > pupilRatio * 0.92) {
            const af = ((theta + Math.PI) / (2 * Math.PI)) * fibN;
            const i0 = ((Math.floor(af) % fibN) + fibN) % fibN;
            const i1 = (i0 + 1) % fibN;
            const ff = af - Math.floor(af);
            const sm = ff * ff * (3 - 2 * ff);
            const f0 = hash2(i0, 13, scheme.radial.seed);
            const f1 = hash2(i1, 13, scheme.radial.seed);
            const fh = lerp(f0, f1, sm);
            const gain = lerp(fibGain[i0], fibGain[i1], sm) * (0.55 + 0.45 * fh);
            const brk = 0.7 + 0.55 * fbm(r * 6.5, (i0 % 97) * 0.37, scheme.radial.seed + 3, 3);
            let sig = gain * brk; // 正=亮纹 负=暗纹
            const mask = scheme.radial.coverage * scheme.radial.opacity;
            if (sig < 0) {
              const a = clamp(-sig * 0.5 * mask * scheme.radial.contrast, 0, 0.85);
              iris = [lerp(iris[0], radPig[0], a), lerp(iris[1], radPig[1], a), lerp(iris[2], radPig[2], a)];
            } else {
              const a = clamp(sig * 0.28 * mask * scheme.radial.contrast, 0, 0.5);
              iris = [
                lerp(iris[0], Math.min(1, iris[0] * 1.5 + 0.12), a),
                lerp(iris[1], Math.min(1, iris[1] * 1.4 + 0.1), a),
                lerp(iris[2], Math.min(1, iris[2] * 1.3 + 0.08), a),
              ];
            }
          }

          // 卷缩轮（波浪环 + 沟状 AO + 隆起亮边）
          if (scheme.collarette.enabled) {
            const wave = (fbm(Math.cos(theta) * 2.2 + 4, Math.sin(theta) * 2.2 + 4, scheme.collarette.seed, 3) - 0.5);
            const rc = scheme.collarette.radius + wave * scheme.collarette.irregularity * 0.16;
            const dd = r - rc;
            const w = scheme.collarette.width;
            const ridge = Math.exp(-((dd - w * 0.9) ** 2) / (2 * (w * 0.55) ** 2));
            const groove = Math.exp(-((dd + w * 0.25) ** 2) / (2 * (w * 0.5) ** 2));
            const m = scheme.collarette.coverage * scheme.collarette.opacity;
            const ca = clamp((ridge * 0.55 + groove * 0.5) * m, 0, 0.8);
            iris = [lerp(iris[0], colPig[0], ca * (groove > ridge ? 0.85 : 0.5)), lerp(iris[1], colPig[1], ca * 0.7), lerp(iris[2], colPig[2], ca * 0.6)];
            const ao = 1 - 0.28 * scheme.depth * groove * m;
            iris = [iris[0] * ao + ridge * 0.05 * m, iris[1] * ao + ridge * 0.04 * m, iris[2] * ao + ridge * 0.03 * m];
          }

          // 色素斑
          if (scheme.spots.enabled) {
            for (const s of spots) {
              const dth = Math.atan2(Math.sin(theta - s.th), Math.cos(theta - s.th));
              // 近似沿径向/角向的椭圆距离
              const lx = dth * r;
              const ly = r - s.r;
              const cr = Math.cos(s.rot), sr2 = Math.sin(s.rot);
              const rx = (lx * cr - ly * sr2) / s.rad;
              const ry = (lx * sr2 + ly * cr) / (s.rad * s.aspect);
              const q = rx * rx + ry * ry;
              if (q < 2.2) {
                const edge = fbm(rx * 2 + s.seed % 50, ry * 2, s.seed, 2);
                const a = smoothstep(1.0 + (edge - 0.5) * 0.7, 0.25, q) * scheme.spots.coverage * scheme.spots.opacity * s.alpha;
                iris = [lerp(iris[0], spotPig[0], a * 0.8), lerp(iris[1], spotPig[1], a * 0.75), lerp(iris[2], spotPig[2], a * 0.7)];
              }
            }
          }

          // 瞳孔
          if (dist < rpPx) {
            const pr = dist / rpPx;
            const pupN = fbm(nx * 22, ny * 22, 31, 2);
            iris = [0.012 + pupN * 0.012 * pr, 0.011 + pupN * 0.01 * pr, 0.013 + pupN * 0.012 * pr];
          } else {
            // 瞳孔缘纵深阴影
            const pupAo = Math.exp(-((rRel - pupilRatio) ** 2) / (2 * 0.012 ** 2));
            const aoP = 1 - 0.4 * scheme.depth * pupAo;
            iris = [iris[0] * aoP, iris[1] * aoP, iris[2] * aoP];
          }

          // 外缘缘环（limbal ring）
          const lim = smoothstep(0.8, 1.0, r);
          iris = [iris[0] * (1 - lim * 0.42), iris[1] * (1 - lim * 0.4), iris[2] * (1 - lim * 0.36)];

          // 虹膜整体径向体积光
          const vol = 0.9 + 0.1 * smoothstep(1, 0.25, r);
          iris = [iris[0] * vol, iris[1] * vol, iris[2] * vol];

          // 光照（线性光源色 × 强度）
          col = [iris[0] * light[0] * li, iris[1] * light[1] * li, iris[2] * light[2] * li];
        }
      }

      d[p] = Math.max(0, col[0]);
      d[p + 1] = Math.max(0, col[1]);
      d[p + 2] = Math.max(0, col[2]);
    }
  }

  // ---------- 血管 ----------
  const segs = generateVessels(scheme, cx, cy, eyeHW, eyeHH, innerSign, S);
  for (const sg of segs) stampSegment(img, sg, S);

  // ---------- Pass 3：角膜凸面高光 + 巩膜湿润光泽（HDR 加色） ----------
  const hlx = cx + (scheme.cornea.highlightX - 0.5) * 2 * irisPx;
  const hly = cy + (scheme.cornea.highlightY - 0.5) * 2 * irisPx;
  const sharpSigma = irisPx * lerp(0.16, 0.05, scheme.cornea.gloss);
  const sharpI = scheme.cornea.highlightHdr * lerp(0.5, 1.6, scheme.cornea.gloss) * (0.65 + 0.35 * li) * (1 + flash * 2.4);
  // 柔光箱大反光
  const softSigma = irisPx * 0.34;
  const ldirX = scene.lightDir[0], ldirY = scene.lightDir[1];
  const softCx = cx + ldirX * irisPx * 0.55;
  const softCy = cy + ldirY * irisPx * 0.55;
  const wet = scheme.sclera.wetness;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const idx = y * S + x;
      if (!eyeMask[idx]) continue;
      const p = idx * 3;
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const dist = Math.hypot(dx, dy);
      // 锐利角膜高光
      const hdx = x + 0.5 - hlx, hdy = y + 0.5 - hly;
      const sharp = Math.exp(-(hdx * hdx + hdy * hdy) / (2 * sharpSigma * sharpSigma));
      // 闪光灯同轴时高光移到瞳孔上方正中
      let flashSpot = 0;
      if (flash > 0) {
        const fdx = dx - irisPx * 0.02, fdy = dy + irisPx * 0.12;
        flashSpot = Math.exp(-(fdx * fdx + fdy * fdy) / (2 * (irisPx * 0.1) ** 2)) * flash;
      }
      const soft = Math.exp(-(((x + 0.5 - softCx) ** 2) / (2 * softSigma ** 2) + ((y + 0.5 - softCy) ** 2) / (2 * (softSigma * 0.55) ** 2)));
      // Fresnel 边缘
      const rn = clamp(dist / (irisPx * 1.02), 0, 1);
      const fres = Math.pow(1 - Math.sqrt(Math.max(0, 1 - rn * rn)), 3) * scheme.cornea.fresnel;
      const add = sharp * sharpI + flashSpot * 6.0 * li + soft * 0.22 * scheme.cornea.gloss + fres * 0.35 * li;
      d[p] += add;
      d[p + 1] += add * (flash ? 0.98 : 1.0);
      d[p + 2] += add * (flash ? 1.02 : 1.04);

      // 巩膜湿润高光（虹膜外）
      if (dist > irisPx * 1.02) {
        const wx = dx - ldirX * eyeHW * 0.2;
        const wy = dy - ldirY * eyeHH * 0.4 - eyeHH * 0.15;
        const wsheen = Math.exp(-((wx * wx) / (2 * (eyeHW * 0.5) ** 2) + (wy * wy) / (2 * (eyeHH * 0.32) ** 2)));
        const wadd = wsheen * wet * 0.5 * li * (1 + flash * 1.5);
        d[p] += wadd; d[p + 1] += wadd; d[p + 2] += wadd * 1.02;
      }
    }
  }

  // ---------- 睫毛 / 睑缘 ----------
  drawLashes(img, cx, cy, eyeHW, eyeHH, S, scheme.radial.seed);

  // ---------- HDR 尺度统一：环带以外的绝对材质（皮肤/巩膜/瞳孔/血管）
  // 与拟合 bandRGB 的归一化尺度对齐；不动虹膜环带，故不影响环带 ΔE。
  const hdrScale = scheme.hdrScale ?? 1;
  if (Math.abs(hdrScale - 1) > 1e-3) {
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        const d = Math.hypot(dx, dy);
        if (d >= rpPx && d <= irisPx) continue; // 虹膜环带
        const i = (y * S + x) * 3;
        img.data[i] *= hdrScale;
        img.data[i + 1] *= hdrScale;
        img.data[i + 2] *= hdrScale;
      }
    }
  }

  return img;
}

function generateVessels(
  scheme: IrisScheme,
  cx: number, cy: number, eyeHW: number, eyeHH: number,
  innerSign: -1 | 1, S: number,
): VesselSeg[] {
  const rng = new Rng(scheme.sclera.seed + 99);
  const segs: VesselSeg[] = [];
  const vesselCol = pigmentById(scheme.sclera.regions[0]?.vesselPigment ?? 'PR206').lin;
  const opacity = scheme.sclera.vesselOpacity;
  for (const region of scheme.sclera.regions) {
    const density = region.vesselDensity;
    const trunks = Math.round(density * 9);
    for (let i = 0; i < trunks; i++) {
      // 起点：眦部或上下睑缘
      let sx: number, sy: number, ang: number;
      if (region.key === 'innerCanthus') {
        sx = cx + innerSign * eyeHW * rng.float(0.82, 1.0);
        sy = cy + rng.gaussian(0, eyeHH * 0.18);
        ang = innerSign > 0 ? Math.PI + rng.gaussian(0, 0.35) : rng.gaussian(0, 0.35);
      } else if (region.key === 'outerCanthus') {
        sx = cx - innerSign * eyeHW * rng.float(0.82, 1.0);
        sy = cy + rng.gaussian(0, eyeHH * 0.18);
        ang = innerSign > 0 ? rng.gaussian(0, 0.4) : Math.PI + rng.gaussian(0, 0.4);
      } else if (region.key === 'upper') {
        sx = cx + rng.float(-0.7, 0.7) * eyeHW;
        sy = cy - eyeHH * rng.float(0.7, 0.95);
        ang = Math.PI / 2 + rng.gaussian(0, 0.5);
      } else {
        sx = cx + rng.float(-0.7, 0.7) * eyeHW;
        sy = cy + eyeHH * rng.float(0.75, 1.0);
        ang = -Math.PI / 2 + rng.gaussian(0, 0.5);
      }
      const steps = rng.int(4, 7);
      let x = sx / S, y = sy / S;
      let w = rng.float(0.004, 0.009);
      const col: RGB = [
        lerp(vesselCol[0], 0.5, 0.25),
        vesselCol[1] * 0.7,
        vesselCol[2] * 0.7,
      ];
      for (let s = 0; s < steps; s++) {
        ang += rng.gaussian(0, 0.22);
        const len = rng.float(0.018, 0.04);
        const nx = x + (Math.cos(ang) * len * S) / S;
        const ny = y + (Math.sin(ang) * len * S * 0.7) / S;
        segs.push({ x0: x, y0: y, x1: nx, y1: ny, w: (w * (1 - s / steps * 0.7)) * S, a: opacity * rng.float(0.25, 0.6), col });
        // 分支
        if (rng.bool(0.3)) {
          const ba = ang + rng.pick([-1, 1]) * rng.float(0.5, 1.0);
          const bl = len * rng.float(0.5, 0.9);
          segs.push({
            x0: nx, y0: ny,
            x1: nx + Math.cos(ba) * bl, y1: ny + Math.sin(ba) * bl * 0.7,
            w: w * 0.5 * S, a: opacity * 0.4, col,
          });
        }
        x = nx; y = ny;
      }
    }
  }
  return segs;
}

function stampSegment(img: RgbImage, sg: VesselSeg, S: number) {
  const x0 = sg.x0 * S, y0 = sg.y0 * S, x1 = sg.x1 * S, y1 = sg.y1 * S;
  const minX = Math.max(0, Math.floor(Math.min(x0, x1) - sg.w - 1));
  const maxX = Math.min(S - 1, Math.ceil(Math.max(x0, x1) + sg.w + 1));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - sg.w - 1));
  const maxY = Math.min(S - 1, Math.ceil(Math.max(y0, y1) + sg.w + 1));
  const vx = x1 - x0, vy = y1 - y0;
  const len2 = vx * vx + vy * vy || 1e-6;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5, py = y + 0.5;
      let t = ((px - x0) * vx + (py - y0) * vy) / len2;
      t = clamp(t, 0, 1);
      const cx = x0 + t * vx, cy = y0 + t * vy;
      const dist = Math.hypot(px - cx, py - cy);
      if (dist > sg.w) continue;
      const cov = smoothstep(sg.w, sg.w * 0.2, dist) * sg.a;
      const i = (y * S + x) * 3;
      img.data[i] = img.data[i] * (1 - cov) + sg.col[0] * cov;
      img.data[i + 1] = img.data[i + 1] * (1 - cov) + sg.col[1] * cov;
      img.data[i + 2] = img.data[i + 2] * (1 - cov) + sg.col[2] * cov;
    }
  }
}

function drawLashes(img: RgbImage, cx: number, cy: number, eyeHW: number, eyeHH: number, S: number, seed: number) {
  const rng = new Rng(seed + 555);
  const n = 16;
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    const ex = lerp(-0.92, 0.92, f);
    const x = cx + ex * eyeHW;
    const arc = Math.sqrt(Math.max(0, 1 - ex * ex));
    const y = cy - eyeHH * arc * 0.95 - eyeHH * 0.05;
    const dir = -Math.PI / 2 + ex * 0.85 + rng.gaussian(0, 0.06);
    const len = eyeHH * rng.float(0.28, 0.5) * (1 - Math.abs(ex) * 0.25);
    // 睫毛带一点弧度：用两段折线
    const mx = x + Math.cos(dir + 0.12) * len * 0.55;
    const my = y + Math.sin(dir + 0.12) * len * 0.55;
    const ex2 = x + Math.cos(dir + 0.28) * len;
    const ey2 = y + Math.sin(dir + 0.28) * len;
    stampSegment(img, {
      x0: x / S, y0: y / S, x1: mx / S, y1: my / S,
      w: rng.float(1.0, 1.6), a: 0.85, col: [0.05, 0.035, 0.03],
    }, S);
    stampSegment(img, {
      x0: mx / S, y0: my / S, x1: ex2 / S, y1: ey2 / S,
      w: rng.float(0.6, 1.0), a: 0.8, col: [0.05, 0.035, 0.03],
    }, S);
  }
  // 睑缘淡淡眼线
  for (let i = 0; i < 24; i++) {
    const f = i / 23;
    const ex = lerp(-0.95, 0.95, f);
    const arc = Math.sqrt(Math.max(0, 1 - ex * ex));
    const x = cx + ex * eyeHW;
    const y = cy - eyeHH * arc * 0.95 - eyeHH * 0.05;
    stampSegment(img, {
      x0: (x - 2) / S, y0: y / S, x1: (x + 2) / S, y1: y / S,
      w: 1.4, a: 0.5, col: [0.12, 0.07, 0.05],
    }, S);
  }
}
