// 把目标线性 RGB 求解为目录内真实颜料的配比。
// 策略：Lab 最近候选池 → 枚举 2~4 颜料组合 → 单纯形成对坐标搜索直接最小化 ΔE00。
import { deltaE2000, linearToLab, type Lab, type RGB } from './color';
import { PIGMENTS, mixPigments } from './pigments';
import type { PigmentMixItem } from './types';

function mixAt(indices: number[], w: number[]): RGB {
  let r = 0, g = 0, b = 0, ws = 0;
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    const weight = w[k] * PIGMENTS[i].staining;
    r += PIGMENTS[i].lin[0] * weight;
    g += PIGMENTS[i].lin[1] * weight;
    b += PIGMENTS[i].lin[2] * weight;
    ws += weight;
  }
  if (ws === 0) return [0, 0, 0];
  return [r / ws, g / ws, b / ws];
}

function optimizeRatios(indices: number[], targetLab: Lab): { w: number[]; de: number } {
  const k = indices.length;
  const w = new Array(k).fill(1 / k);
  let bestDE = deltaE2000(linearToLab(mixAt(indices, w)), targetLab);
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 0; i < k; i++) {
      for (let j = i + 1; j < k; j++) {
        const s = w[i] + w[j];
        let bestX = w[i];
        const trial = w.slice();
        for (let step = 0; step <= 24; step++) {
          const x = (s * step) / 24;
          trial[i] = x;
          trial[j] = s - x;
          const de = deltaE2000(linearToLab(mixAt(indices, trial)), targetLab);
          if (de < bestDE) {
            bestDE = de;
            bestX = x;
          }
        }
        w[i] = bestX;
        w[j] = s - bestX;
      }
    }
  }
  // 最后一轮细搜
  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      const s = w[i] + w[j];
      let lo = 0, hi = s, bx = w[i], bd = bestDE;
      for (let step = 0; step <= 30; step++) {
        const x = lo + ((hi - lo) * step) / 30;
        const trial = w.slice();
        trial[i] = x;
        trial[j] = s - x;
        const de = deltaE2000(linearToLab(mixAt(indices, trial)), targetLab);
        if (de < bd) { bd = de; bx = x; }
      }
      w[i] = bx; w[j] = s - bx; bestDE = bd;
    }
  }
  return { w, de: bestDE };
}

function* combinations(pool: number[], size: number): Generator<number[]> {
  const n = pool.length;
  const idx = Array.from({ length: size }, (_, i) => i);
  while (true) {
    yield idx.map((i) => pool[i]);
    let i = size - 1;
    while (i >= 0 && idx[i] === n - size + i) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < size; j++) idx[j] = idx[j - 1] + 1;
  }
}

const cache = new Map<string, PigmentMixItem[]>();

export function solvePigmentMix(target: RGB, maxPigments = 4): PigmentMixItem[] {
  const key = target.map((v) => Math.round(v * 400)).join('_') + `_${maxPigments}`;
  const cached = cache.get(key);
  if (cached) return cached.map((c) => ({ ...c }));

  const targetLab = linearToLab(target);
  // 候选池：Lab 最近的 9 种颜料（黑/白/主色相基本都在）
  const pool = PIGMENTS.map((pg, i) => ({ i, d: deltaE2000(linearToLab(pg.lin), targetLab) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 9)
    .map((x) => x.i);

  type Best = { de: number; indices: number[]; w: number[] };
  const consider = (indices: number[]): Best => {
    const { w, de } = optimizeRatios(indices, targetLab);
    return { de, indices, w };
  };
  let best: Best = consider([pool[0]]);
  for (const i of pool) {
    const r = consider([i]);
    if (r.de < best.de) best = r;
  }
  for (let s = 2; s <= maxPigments; s++) {
    for (const combo of combinations(pool, s)) {
      const r = consider(combo);
      if (r.de < best.de) best = r;
    }
    // 已经非常准就不必再往上加颜料
    if (best.de < 0.6) break;
  }

  const b = best;
  const sum = b.w.reduce((a, x) => a + x, 0) || 1;
  const items: PigmentMixItem[] = b.indices
    .map((pigmentIndex, k) => ({
      pigmentId: PIGMENTS[pigmentIndex].id,
      ratio: Math.round((b.w[k] / sum) * 1000) / 1000,
    }))
    .filter((it) => it.ratio >= 0.02)
    .sort((a, z) => z.ratio - a.ratio);
  cache.set(key, items);
  return items.map((c) => ({ ...c }));
}

export function recipeFitDeltaE(mix: PigmentMixItem[], target: RGB): number {
  return deltaE2000(linearToLab(mixPigments(mix)), linearToLab(target));
}
