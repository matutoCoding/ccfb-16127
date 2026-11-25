// 轻量 SVG 图表：响应曲线 / ΔE 环带 / 瞳孔 RMS 曲线。
import { h } from '../ui/dom';

export function responseCurveSvg(g: number[], trueG?: number[], width = 460, height = 240): SVGSVGElement {
  const padL = 46, padR = 16, padT = 18, padB = 34;
  const iw = width - padL - padR, ih = height - padT - padB;
  const vals = trueG ? [...g, ...trueG] : g;
  let mn = Math.min(...vals), mx = Math.max(...vals);
  if (mx - mn < 1e-6) { mx += 1; mn -= 1; }
  const X = (z: number) => padL + (z / 255) * iw;
  const Y = (v: number) => padT + ih - ((v - mn) / (mx - mn)) * ih;
  const pathOf = (curve: number[]) => curve.map((v, z) => `${z === 0 ? 'M' : 'L'}${X(z).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');

  const ticks = [0, 64, 128, 192, 255];
  const yTicks = 4;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.style.width = '100%';
  svg.style.height = 'auto';

  let inner = '';
  // 网格 + x 刻度
  for (const z of ticks) {
    inner += `<line x1="${X(z)}" y1="${padT}" x2="${X(z)}" y2="${padT + ih}" stroke="#e6edf0"/>`;
    inner += `<text x="${X(z)}" y="${height - 12}" font-size="10.5" fill="#7b8d96" text-anchor="middle">${z}</text>`;
  }
  for (let i = 0; i <= yTicks; i++) {
    const v = mn + ((mx - mn) * i) / yTicks;
    const y = Y(v);
    inner += `<line x1="${padL}" y1="${y}" x2="${padL + iw}" y2="${y}" stroke="#e6edf0"/>`;
    inner += `<text x="${padL - 7}" y="${y + 3.5}" font-size="10" fill="#7b8d96" text-anchor="end">${v.toFixed(1)}</text>`;
  }
  inner += `<text x="${padL + iw / 2}" y="${height - 0}" font-size="11" fill="#546872" text-anchor="middle">像素码值 Z</text>`;
  inner += `<text transform="translate(13 ${padT + ih / 2}) rotate(-90)" font-size="11" fill="#546872" text-anchor="middle">ln 曝光量 g(Z)</text>`;
  if (trueG) inner += `<path d="${pathOf(trueG)}" fill="none" stroke="#9fb4bd" stroke-width="2" stroke-dasharray="6 4"/>`;
  inner += `<path d="${pathOf(g)}" fill="none" stroke="#0e7c86" stroke-width="2.6"/>`;
  inner += `<circle cx="${X(127)}" cy="${Y(g[127])}" r="4" fill="#0e7c86" stroke="#fff" stroke-width="1.5"/>`;
  svg.innerHTML = inner;
  return svg;
}

export function deltaEBars(bandDE: number[], threshold: number): HTMLElement {
  const wrap = h('div', null);
  const maxV = Math.max(6, ...bandDE, threshold * 1.4);
  bandDE.forEach((de, b) => {
    const pct = Math.min(100, (de / maxV) * 100);
    const over = de > threshold;
    const row = h('div', { class: 'ring-de-row' },
      h('span', { class: 'small muted' }, `环带 ${b + 1}`),
      h('div', { class: 'bar' },
        h('i', { style: `width:${pct}%;background:${over ? 'linear-gradient(90deg,#e08a7d,#c0392b)' : 'linear-gradient(90deg,#3aa7b0,#0e7c86)'}` }),
        h('span', { class: 'mark', style: `left:${(threshold / maxV) * 100}%` }),
      ),
      h('span', { style: `font-weight:700;color:${over ? 'var(--red)' : 'var(--teal-strong)'};font-variant-numeric:tabular-nums` }, de.toFixed(2)),
    );
    wrap.appendChild(row);
  });
  return wrap;
}

export function pupilCurveSvg(curve: { mm: number; rms: number; worst: number }[], bestMm: number, width = 460, height = 210): SVGSVGElement {
  const padL = 42, padR = 14, padT = 16, padB = 32;
  const iw = width - padL - padR, ih = height - padT - padB;
  const xs = curve.map((c) => c.mm);
  const ys = curve.map((c) => c.rms);
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const ymax = Math.max(...ys) * 1.15;
  const X = (x: number) => padL + ((x - xmin) / (xmax - xmin)) * iw;
  const Y = (y: number) => padT + ih - (y / ymax) * ih;
  const path = curve.map((c, i) => `${i ? 'L' : 'M'}${X(c.mm).toFixed(1)},${Y(c.rms).toFixed(1)}`).join(' ');
  const best = curve.reduce((a, b) => (b.mm === bestMm ? b : a), curve[0]);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.style.width = '100%';
  let inner = '';
  for (let i = 0; i <= 4; i++) {
    const x = xmin + ((xmax - xmin) * i) / 4;
    inner += `<text x="${X(x)}" y="${height - 12}" font-size="10" fill="#7b8d96" text-anchor="middle">${x.toFixed(1)}</text>`;
  }
  inner += `<path d="${path}" fill="none" stroke="#0e7c86" stroke-width="2.5"/>`;
  inner += `<line x1="${X(bestMm)}" y1="${padT}" x2="${X(bestMm)}" y2="${padT + ih}" stroke="#c0392b" stroke-dasharray="4 3" stroke-width="1.4"/>`;
  inner += `<circle cx="${X(bestMm)}" cy="${Y(best.rms)}" r="5" fill="#c0392b" stroke="#fff" stroke-width="2"/>`;
  inner += `<text x="${X(bestMm) + 8}" y="${padT + 14}" font-size="11.5" font-weight="700" fill="#c0392b">最优 ${bestMm.toFixed(2)}mm</text>`;
  inner += `<text x="${padL + iw / 2}" y="${height - 0}" font-size="11" fill="#546872" text-anchor="middle">固定瞳孔直径 mm</text>`;
  svg.innerHTML = inner;
  return svg;
}
