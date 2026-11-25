import { h, icon, badge, toast } from '../ui/dom';
import { repo } from '../data/db';
import { loadChainContext } from '../browser/chainContext';
import { schemeToLdrCanvas, ldrDataToCanvas } from '../browser/renderView';
import { evaluateVsPhoto, evaluateScenes } from '../core/matching';
import { estimateScenePupils, optimizeFixedPupil } from '../core/pupil';
import { SCENES } from '../core/scenes';
import { deltaEBars, pupilCurveSvg } from '../ui/charts';
import { cloneScheme, uid } from '../core/schemeFactory';
import type { AppCtx } from '../main';
import type { IrisScheme, SceneMetric } from '../core/types';

function ringOverlay(geom: { cx: number; cy: number; irisR: number; pupilR: number }): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
  let inner = '';
  const N = 8;
  for (let b = 0; b <= N; b++) {
    const r = geom.pupilR * 100 + ((geom.irisR - geom.pupilR) * 100 * b) / N;
    inner += `<circle cx="${geom.cx * 100}" cy="${geom.cy * 100}" r="${r}" fill="none" stroke="rgba(120,230,235,${b === 0 || b === N ? 0.9 : 0.4})" stroke-width="${b === 0 || b === N ? 0.5 : 0.28}" stroke-dasharray="${b === 0 || b === N ? '' : '1.2 1.2'}"/>`;
  }
  svg.innerHTML = inner;
  return svg;
}

function panel(title: string, tagKind: 'photo' | 'gpu' | 'ref', tagText: string): { box: HTMLDivElement; host: HTMLDivElement } {
  const host = h('div', { style: 'position:relative' });
  const box = h('div', { class: 'eye-panel' },
    h('span', { class: `pill tag ${tagKind === 'gpu' ? 'good' : ''}` }, tagText),
    host,
  );
  const wrap = h('div', null,
    h('div', { class: 'flex', style: 'margin:0 2px 8px' }, h('h3', { style: 'font-size:14.5px' }, title)),
    box,
  ) as unknown as HTMLDivElement;
  return { box: wrap, host };
}

export async function renderCompare(root: HTMLElement, ctx: AppCtx) {
  if (!ctx.patient) { root.appendChild(h('div', { class: 'card empty-state' }, '请先选择患者')); return; }
  const patient = ctx.patient;
  const chain = await loadChainContext(patient, ctx.settings);
  if (!chain.curve || !chain.currentScheme) {
    root.appendChild(h('div', { class: 'card empty-state' },
      h('div', null, '还没有可比对的配色方案'),
      h('button', { class: 'btn primary mt16', onclick: () => ctx.navigate(`#/iris/${patient.id}`) }, '前往虹膜绘制 / 一键拟合')));
    return;
  }
  const threshold = ctx.settings.deltaEThreshold;
  let candidate: IrisScheme = cloneScheme(chain.currentScheme);
  const reference: IrisScheme = chain.referenceScheme ? cloneScheme(chain.referenceScheme) : cloneScheme(candidate);
  let activeScene = 'clinic';
  let photoMetric: SceneMetric | null = null;
  let sceneMetrics: SceneMetric[] = [];
  let busy = false;

  root.appendChild(h('div', { class: 'flex wrap mb8' },
    h('div', null, h('h2', { style: 'font-size:19px' }, `成像比对 · ${ctx.patient.name}`),
      h('div', { class: 'small muted' }, '两侧走同一条反演响应曲线、同一曝光与白平衡；环带已叠加显示')),
    h('div', { class: 'right flex' },
      h('button', { class: 'btn', id: 'perturb-btn' }, '模拟手工初稿偏差'),
      h('button', { class: 'btn', id: 'reset-btn' }, '恢复拟合方案'),
      h('button', { class: 'btn primary', id: 'save-btn' }, '保存当前方案'),
    ),
  ));

  // 场景切换
  const sceneBar = h('div', { class: 'scene-switch mt8 mb8' });
  SCENES.forEach((s) => {
    const btn = h('button', { class: `scene-btn ${activeScene === s.id ? 'active' : ''}` }, sceneIcon(s.id), s.name);
    btn.addEventListener('click', () => { activeScene = s.id; sceneBar.querySelectorAll('.scene-btn').forEach((b) => b.classList.remove('active')); btn.classList.add('active'); void paint(); });
    sceneBar.appendChild(btn);
  });
  root.appendChild(sceneBar);

  const grid = h('div', { class: 'compare-grid' });
  const leftPanel = panel('健侧眼', 'photo', '健侧照片 / HDR 反演');
  const rightPanel = panel('定制义眼片（线性 HDR 渲染）', 'gpu', 'CPU 参考链路');
  grid.append(leftPanel.box, rightPanel.box);
  root.appendChild(grid);

  const below = h('div', { class: 'split mt16' });
  const metricCard = h('div', { class: 'card' }, h('div', { class: 'card-hd' }, h('h3', null, '虹膜环带色差与层级诊断')));
  const metricBody = h('div', { class: 'card-bd' });
  metricCard.appendChild(metricBody);
  const pupilCard = h('div', { class: 'card' }, h('div', { class: 'card-hd' }, h('h3', null, '固定瞳孔尺寸优化')));
  const pupilBody = h('div', { class: 'card-bd' });
  pupilCard.appendChild(pupilBody);
  below.append(metricCard, pupilCard);
  root.appendChild(below);

  async function recalc() {
    if (!chain.curve) return;
    busy = true;
    metricBody.innerHTML = '<div class="tac muted" style="padding:30px"><span class="spinner"></span> 正在计算 ΔE00 与层级归因…</div>';
    await new Promise((r) => setTimeout(r, 20));
    try {
      if (chain.photo) {
        photoMetric = evaluateVsPhoto(candidate, chain.photo, chain.geom, chain.curve, chain.wb, chain.gain, chain.irisDiameterMm, chain.capture?.highlightMask ?? null, threshold);
      }
      sceneMetrics = evaluateScenes(candidate, reference, chain.geom, chain.curve, chain.gain, chain.irisDiameterMm, threshold);
    } finally { busy = false; }
    renderMetric();
  }

  function currentMetric(): SceneMetric | null {
    if (activeScene === 'clinic' && photoMetric) return photoMetric;
    return sceneMetrics.find((m) => m.sceneId === activeScene) ?? null;
  }

  function renderMetric() {
    const m = currentMetric();
    metricBody.replaceChildren();
    if (!m) { metricBody.appendChild(h('div', { class: 'muted' }, '暂无指标')); return; }
    const kpis = h('div', { class: 'grid cols-3 mb8' },
      kpi('平均 ΔE00', m.meanDeltaE.toFixed(2), m.pass ? 'good' : 'bad', `阈值 ${threshold}`),
      kpi('最大环带 ΔE', m.maxBandDeltaE.toFixed(2), m.maxBandDeltaE < threshold ? 'good' : 'warn', ''),
      kpi('超标环带', String(m.failingBands.length), m.failingBands.length ? 'bad' : 'good', m.failingBands.length ? m.failingBands.map((b) => b + 1).join('、') : '全部合格'),
    );
    metricBody.appendChild(kpis);
    metricBody.appendChild(deltaEBars(m.bandDeltaE, threshold));
    if (m.layerAdvice.length) {
      metricBody.appendChild(h('div', { class: 'section-title' }, '可能偏色的颜料层'));
      for (const a of m.layerAdvice) {
        metricBody.appendChild(h('div', { class: `advice-card ${a.deltaE > threshold * 1.6 ? 'bad' : ''}` },
          h('b', null, `环带 ${a.band + 1} · ${a.layer} · ΔE ${a.deltaE.toFixed(2)}`),
          h('div', null, a.direction),
          h('div', { class: 'small mt8' }, '调整建议：', a.suggestion),
        ));
      }
    } else {
      metricBody.appendChild(h('div', { class: 'advice-card', style: 'background:var(--green-soft)' }, h('b', { style: 'color:var(--green)' }, '各环带均在阈值内'), '当前配方与健侧眼成像一致。'));
    }
  }

  async function paint() {
    if (!chain.curve) return;
    const scene = SCENES.find((s) => s.id === activeScene)!;
    leftPanel.host.replaceChildren();
    rightPanel.host.replaceChildren();

    if (activeScene === 'clinic' && chain.photo) {
      const pc = ldrDataToCanvas(chain.photo.data, chain.photo.width, chain.photo.height);
      pc.style.width = '100%';
      leftPanel.host.append(pc, ringOverlay(chain.geom));
    } else {
      const rc = schemeToLdrCanvas(reference, chain.geom, chain.curve, { size: 320, gain: chain.gain, sceneId: activeScene, irisDiameterMm: chain.irisDiameterMm });
      rc.style.width = '100%';
      leftPanel.host.append(rc, ringOverlay(chain.geom));
      leftPanel.box.querySelector('.pill.tag')!.textContent = '健侧数字孪生（场景光照估计）';
    }
    const cc = schemeToLdrCanvas(candidate, chain.geom, chain.curve, {
      size: chain.photo?.width ?? 320, gain: candidate.fitGain ?? chain.gain,
      wb: activeScene === 'clinic' ? chain.wb : undefined, sceneId: activeScene, irisDiameterMm: chain.irisDiameterMm,
    });
    cc.style.width = '100%';
    rightPanel.host.append(cc, ringOverlay(chain.geom));

    if (!busy) renderMetric();
  }

  function renderPupil() {
    const measuredMm = Math.round((chain.geom.pupilR / chain.geom.irisR) * chain.irisDiameterMm * 10) / 10;
    const { estimates } = estimateScenePupils(measuredMm, 650, SCENES);
    const opt = optimizeFixedPupil(estimates.map((e) => e.healthyMm));
    pupilBody.replaceChildren();
    pupilBody.appendChild(h('div', { class: 'flex' },
      h('div', null, h('div', { class: 'small muted' }, '拍摄实测瞳孔'), h('div', { class: 'pupil-mm' }, `${measuredMm.toFixed(1)} mm`)),
      h('div', { class: 'right tac' }, h('div', { class: 'small muted' }, '推荐固定瞳孔'), h('div', { class: 'pupil-mm' }, `${opt.bestMm.toFixed(2)} mm`)),
    ));
    const table = h('table', { class: 'data mt8' });
    table.innerHTML = '<thead><tr><th>场景</th><th>健侧估计</th><th>采用固定值差值</th></tr></thead>';
    const tb = h('tbody');
    for (const e of estimates) {
      const diff = opt.bestMm - e.healthyMm;
      tb.appendChild(h('tr', null,
        h('td', null, e.sceneName),
        h('td', { class: 'mono' }, `${e.healthyMm.toFixed(2)} mm`),
        h('td', null, badge(`${diff >= 0 ? '+' : ''}${diff.toFixed(2)} mm`, Math.abs(diff) < 0.6 ? 'green' : 'amber')),
      ));
    }
    table.appendChild(tb);
    pupilBody.append(table, pupilCurveSvg(opt.curve, opt.bestMm));
    pupilBody.appendChild(h('div', { class: 'small muted' }, `RMS ${opt.rms.toFixed(2)}mm · 最大偏差 ${opt.worst.toFixed(2)}mm；按四种场景总体最接近选取。`));
    pupilBody.appendChild(h('button', {
      class: 'btn primary mt16', style: 'width:100%',
      onclick: () => { candidate.pupilDiameterMm = opt.bestMm; void paint(); toast(`已将固定瞳孔设为 ${opt.bestMm.toFixed(2)}mm（保存后生效）`, 'good'); },
    }, `采用 ${opt.bestMm.toFixed(2)}mm 为义眼固定瞳孔`));
  }

  root.querySelector('#perturb-btn')!.addEventListener('click', () => {
    candidate = cloneScheme(chain.currentScheme!);
    candidate.radial.pigment = 'PB29';
    candidate.radial.coverage = 0.95;
    candidate.radial.opacity = 0.95;
    candidate.bandRGB = candidate.bandRGB.map((c) => [c[0] * 0.82, c[1] * 0.92, Math.min(1, c[2] * 1.22)] as [number, number, number]);
    void recalc().then(paint);
    toast('已注入一处典型偏差：放射纹过厚且偏蓝，观察超标环带与诊断');
  });
  root.querySelector('#reset-btn')!.addEventListener('click', () => {
    candidate = cloneScheme(chain.currentScheme!);
    void recalc().then(paint);
    toast('已恢复为已保存的拟合方案');
  });
  root.querySelector('#save-btn')!.addEventListener('click', async () => {
    candidate.id = chain.currentScheme!.id;
    await repo.saveScheme(candidate);
    await repo.saveSnapshot({
      id: uid('snap'), patientId: ctx.patient!.id, schemeId: candidate.id,
      version: (await repo.listSnapshots(ctx.patient!.id)).length + 1,
      createdAt: Date.now(), reason: '成像比对后确认', scheme: JSON.parse(JSON.stringify(candidate)),
      metrics: photoMetric ? [photoMetric, ...sceneMetrics] : sceneMetrics,
    });
    toast('方案已保存并留存快照', 'good');
  });

  renderPupil();
  await recalc();
  await paint();
}

function kpi(label: string, value: string, kind: 'good' | 'warn' | 'bad', sub: string): HTMLElement {
  return h('div', { class: `card kpi ${kind}` },
    h('div', { class: 'label' }, label),
    h('div', { class: 'value' }, value),
    h('div', { class: 'sub' }, sub));
}

function sceneIcon(id: string): SVGSVGElement {
  const name = id === 'daylight' ? 'sun' : id === 'flash' ? 'zap' : id === 'warm' ? 'alert' : 'eye';
  return icon(name, 'si');
}
