/**
 * 稠密线性方程组求解（Gauss-Jordan 部分主元消元）。
 * Debevec-Malik 响应曲线恢复的归一方程是 256×256 对称正定阵，直接消元即可。
 */

/** 解 A x = b，A 为 n×n 行主序，返回 x；矩阵奇异时抛错 */
export function solveLinear(a: Float64Array, b: Float64Array, n: number): Float64Array {
  const m = new Float64Array(n * (n + 1));
  for (let i = 0; i < n; i++) {
    m.set(a.subarray(i * n, i * n + n), i * (n + 1));
    m[i * (n + 1) + n] = b[i];
  }

  for (let col = 0; col < n; col++) {
    // 部分主元
    let pivot = col;
    let pivotAbs = Math.abs(m[col * (n + 1) + col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(m[r * (n + 1) + col]);
      if (v > pivotAbs) {
        pivotAbs = v;
        pivot = r;
      }
    }
    if (pivotAbs < 1e-12) {
      throw new Error(`线性方程组在第 ${col} 列遇到奇异矩阵（主元=${pivotAbs}）`);
    }
    if (pivot !== col) {
      const rowOff = pivot * (n + 1);
      const baseOff = col * (n + 1);
      for (let k = 0; k <= n; k++) {
        const tmp = m[rowOff + k];
        m[rowOff + k] = m[baseOff + k];
        m[baseOff + k] = tmp;
      }
    }
    const diag = m[col * (n + 1) + col];
    const baseOff = col * (n + 1);
    for (let k = col; k <= n; k++) m[baseOff + k] /= diag;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = m[r * (n + 1) + col];
      if (factor === 0) continue;
      const rowOff = r * (n + 1);
      for (let k = col; k <= n; k++) {
        m[rowOff + k] -= factor * m[baseOff + k];
      }
    }
  }

  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = m[i * (n + 1) + n];
  return x;
}
