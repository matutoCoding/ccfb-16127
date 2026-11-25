// 确定性随机数（合成测试数据必须可复现，不能用 Math.random）
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private next01: () => number;
  constructor(seed: number) {
    this.next01 = mulberry32(seed);
  }
  float(min = 0, max = 1): number {
    return min + this.next01() * (max - min);
  }
  int(min: number, max: number): number {
    return Math.floor(this.float(min, max + 1));
  }
  bool(p = 0.5): boolean {
    return this.next01() < p;
  }
  // Box-Muller 高斯
  gaussian(mean = 0, sd = 1): number {
    let u = 0, v = 0;
    while (u === 0) u = this.next01();
    while (v === 0) v = this.next01();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next01() * arr.length)];
  }
  // 近似二维 value noise 所需的哈希格点
  hash2(ix: number, iy: number): number {
    let h = (ix * 374761393 + iy * 668265263) ^ 0x5bf03635;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }
}

// 双线性 value noise + fBm，供合成与 CPU 渲染共用
export function valueNoise2D(rng: Rng, x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = rng.hash2(ix, iy);
  const b = rng.hash2(ix + 1, iy);
  const c = rng.hash2(ix, iy + 1);
  const d = rng.hash2(ix + 1, iy + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
export function fbm(rng: Rng, x: number, y: number, octaves = 4): number {
  let v = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    v += amp * valueNoise2D(rng, x * f, y * f);
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return v / norm;
}
