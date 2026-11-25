import { h, icon, badge, toast, modal } from '../ui/dom';
import { repo } from '../data/db';
import { loadChainContext } from '../browser/chainContext';
import { schemeToLdrCanvas, ldrDataToCanvas } from '../browser/renderView';
import { buildFormula, evaluateScenes, evaluateVsPhoto } from '../core/matching';
import { estimateScenePupils, optimizeFixedPupil } from '../core/pupil';
import { SCENES } from '../core/scenes';
import { cloneScheme, uid } from '../core/schemeFactory';
import type { AppCtx } from '../main';
import type { DeliveryRecord, IrisScheme, SceneMetric } from '../core/types';

export async function renderDelivery(root: HTMLElement, ctx: AppCtx) {
  if (!ctx.patient) { root.appendChild(h('div', { class: 'card empty-state' }, '请先选择患者')); return; }
  const patient = ctx.patient;
  const chain = await loadChainContext(patient, ctx.settings);
  if (!chain.curve || !chain.currentScheme) {
    root.appendChild(h('div', { class: 'card empty-state' }, h('div', null, '还没有可交付的配色方案'),
      h('button', { class: 'btn primary mt16', onclick: () => ctx.navigate(`#/iris/${patient.id}`) }, '前往虹膜绘制')));
    return;
  }
  const p = patient;
  const scheme = chain.currentScheme;
  const threshold = ctx.settings.deltaEThreshold;
  const formula = buildFormula(scheme);

  const measuredMm = (chain.geom.pupilR / chain.geom.irisR) * chain.irisDiameterMm;
  const pupilOpt = optimizeFixedPupil(estimateScenePupils(measuredMm, 650, SCENES).estimates.map((e) => e.healthyMm));
  const pupilMm = scheme.pupilDiameterMm ?? pupilOpt.bestMm;

  let photoMetric: SceneMetric | null = null;
  if (chain.photo) photoMetric = evaluateVsPhoto(scheme, chain.photo, chain.geom, chain.curve, chain.wb, chain.gain, chain.irisDiameterMm, chain.capture?.highlightMask ?? null, threshold);
  const sceneMetrics = evaluateScenes(scheme, chain.referenceScheme ?? scheme, chain.geom, chain.curve, chain.gain, chain.irisDiameterMm, threshold);
  const allMetrics: SceneMetric[] = photoMetric ? [photoMetric, ...sceneMetrics] : sceneMetrics;
  const allPass = allMetrics.every((m) => m.pass);

  // ---------- 配色单 ----------
  const sheet = h('div', { class: 'sheet' });
  const today = new Date().toLocaleDateString('zh-CN');
  sheet.appendChild(h('div', { class: 'sheet-head' },
    h('div', null,
      h('div', { class: 'sheet-title' }, '定制义眼片配色确认单'),
      h('div', { class: 'sheet-sub' }, `${ctx.settings.studioName} · 线性 HDR 配色 / CIEDE2000 质控`),
    ),
    h('div', { class: 'tac', style: 'font-size:12.5px;color:var(--ink-2)' },
      h('div', null, `单号 DL-${Date.now().toString(36).toUpperCase()}`),
      h('div', null, today),
      allPass ? badge('四场景全部达标', 'green') : badge('存在超标场景', 'amber')),
  ));

  sheet.appendChild(h('div', { class: 'grid cols-4 mb8', style: 'gap:8px;font-size:13px' },
    info('患者', p.name), info('档案号', p.code),
    info('术眼', p.prostheticSide === 'L' ? '左眼' : '右眼'),
    info('健侧', p.prostheticSide === 'L' ? '右眼' : '左眼'),
    info('片子直径', `${p.shellDiameterMm} mm`), info('厚度', `${p.thicknessMm} mm`),
    info('虹膜横径', `${p.irisDiameterMm} mm`), info('固定瞳孔', `${pupilMm.toFixed(2)} mm`),
  ));
  sheet.appendChild(h('div', { class: 'small muted mb8' }, `眼窝：${p.socketCondition || '—'}　义眼台：${p.implantType}`));

  // 并排比对图
  sheet.appendChild(h('div', { class: 'section-title' }, '并排成像比对（同一响应曲线 / 曝光 / 白平衡）'));
  const compareRow = h('div', { class: 'compare-grid' });
  const imgLeft = h('div', { class: 'tac' });
  if (chain.photo) {
    const c = ldrDataToCanvas(chain.photo.data, chain.photo.width, chain.photo.height);
    c.style.cssText = 'width:100%;max-width:300px;border-radius:10px;border:1px solid var(--line)';
    imgLeft.append(c, h('div', { class: 'small muted mt8' }, '健侧眼照片（基准曝光）'));
  }
  const imgRight = h('div', { class: 'tac' });
  const rc = schemeToLdrCanvas(scheme, chain.geom, chain.curve, { size: 320, gain: scheme.fitGain ?? chain.gain, wb: chain.wb, irisDiameterMm: chain.irisDiameterMm });
  rc.style.cssText = 'width:100%;max-width:300px;border-radius:10px;border:1px solid var(--line)';
  imgRight.append(rc, h('div', { class: 'small muted mt8' }, '定制义眼片渲染（过同一响应曲线）'));
  compareRow.append(imgLeft, imgRight);
  sheet.appendChild(compareRow);

  // 配色公式表
  sheet.appendChild(h('div', { class: 'section-title' }, '分层颜料配方与遮盖比例'));
  const table = h('table', { class: 'formula' });
  table.innerHTML = '<thead><tr><th>图层</th><th>工作室色号</th><th>颜料</th><th>Colour Index</th><th style="text-align:right">有效遮盖%</th></tr></thead>';
  const tb = h('tbody');
  let lastLayer = '';
  for (const r of formula) {
    const tr = h('tr');
    tr.innerHTML = `<td>${r.layer === lastLayer ? '' : r.layer}</td><td class="mono">${r.pigmentCode}</td><td>${r.pigmentName}</td><td class="small">${r.ciName}</td><td style="text-align:right;font-variant-numeric:tabular-nums">${r.coveragePct.toFixed(1)}%</td>`;
    lastLayer = r.layer;
    tb.appendChild(tr);
  }
  table.appendChild(tb);
  sheet.appendChild(table);

  // 四场景色差表
  sheet.appendChild(h('div', { class: 'section-title' }, '四种光照场景环带色差（平均 ΔE00）'));
  const deTable = h('table', { class: 'data' });
  deTable.innerHTML = '<thead><tr><th>场景</th><th>平均 ΔE00</th><th>最大环带</th><th>超标环带</th><th>结论</th></tr></thead>';
  const dtb = h('tbody');
  for (const m of sceneMetrics) {
    dtb.appendChild(h('tr', null,
      h('td', null, m.sceneName.replace('（健侧照片）', '')),
      h('td', { class: 'mono', style: `font-weight:700;color:${m.pass ? 'var(--green)' : 'var(--red)'}` }, m.meanDeltaE.toFixed(2)),
      h('td', { class: 'mono' }, m.maxBandDeltaE.toFixed(2)),
      h('td', null, m.failingBands.length ? m.failingBands.map((b) => b + 1).join(',') : '—'),
      h('td', null, badge(m.pass ? '通过' : '需调整', m.pass ? 'green' : 'red')),
    ));
  }
  if (photoMetric) {
    dtb.appendChild(h('tr', null,
      h('td', null, '健侧照片实测（诊室基准）'),
      h('td', { class: 'mono', style: `font-weight:700;color:${photoMetric.pass ? 'var(--green)' : 'var(--red)'}` }, photoMetric.meanDeltaE.toFixed(2)),
      h('td', { class: 'mono' }, photoMetric.maxBandDeltaE.toFixed(2)),
      h('td', null, photoMetric.failingBands.length ? photoMetric.failingBands.map((b) => b + 1).join(',') : '—'),
      h('td', null, badge(photoMetric.pass ? '通过' : '需调整', photoMetric.pass ? 'green' : 'red')),
    ));
  }
  deTable.appendChild(dtb);
  sheet.appendChild(deTable);

  // 签字
  sheet.appendChild(h('div', { class: 'section-title' }, '患者确认签字'));
  sheet.appendChild(h('p', { class: 'small muted' }, '本人确认上述虹膜颜色、血管纹理与瞳孔尺寸经比对满意，同意按此配方制作交付。签字后单据归档，下一副可直接从本单配方起步。'));
  const sigCanvas = h('canvas', { class: 'sig-pad', width: 900, height: 150 }) as HTMLCanvasElement;
  const sigCtx = sigCanvas.getContext('2d')!;
  sigCtx.lineWidth = 2.6; sigCtx.lineCap = 'round'; sigCtx.strokeStyle = '#10242c';
  let drawing = false; let hasSig = false;
  const pos = (e: PointerEvent) => {
    const r = sigCanvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * sigCanvas.width, y: ((e.clientY - r.top) / r.height) * sigCanvas.height };
  };
  sigCanvas.addEventListener('pointerdown', (e) => { drawing = true; const { x, y } = pos(e); sigCtx.beginPath(); sigCtx.moveTo(x, y); sigCanvas.setPointerCapture(e.pointerId); });
  sigCanvas.addEventListener('pointermove', (e) => { if (!drawing) return; const { x, y } = pos(e); sigCtx.lineTo(x, y); sigCtx.stroke(); hasSig = true; sigCanvas.classList.add('signed'); });
  sigCanvas.addEventListener('pointerup', () => { drawing = false; });
  const sigActions = h('div', { class: 'flex mt8' },
    h('button', { class: 'btn sm', onclick: () => { sigCtx.clearRect(0, 0, sigCanvas.width, sigCanvas.height); hasSig = false; sigCanvas.classList.remove('signed'); } }, '清除重签'),
    h('span', { class: 'small muted right' }, '支持鼠标 / 触屏签名'),
  );
  sheet.appendChild(sigCanvas);
  sheet.appendChild(sigActions);

  const noteInput = h('textarea', { class: 'input mt16', placeholder: '交付备注（适应情况、复查时间等）' }) as HTMLTextAreaElement;
  sheet.appendChild(noteInput);

  let signedRecord: DeliveryRecord | null = null;
  const signBtn = h('button', { class: 'btn primary lg', disabled: true as unknown as boolean }, icon('check'), '签字并归档');
  // 有笔迹后启用
  const enable = () => { (signBtn as HTMLButtonElement).disabled = false; };
  sigCanvas.addEventListener('pointerdown', enable, { once: true });
  signBtn.addEventListener('click', async () => {
    if (!hasSig) { toast('请先在签名区签字', 'bad'); return; }
    signBtn.disabled = true;
    // 合成并排图
    const comp = document.createElement('canvas');
    comp.width = 680; comp.height = 360;
    const cx = comp.getContext('2d')!;
    cx.fillStyle = '#0e1b20'; cx.fillRect(0, 0, 680, 360);
    if (chain.photo) { const pc = ldrDataToCanvas(chain.photo.data, chain.photo.width, chain.photo.height); cx.drawImage(pc, 20, 40, 300, 300); }
    cx.drawImage(rc, 360, 40, 300, 300);
    cx.fillStyle = '#cfe6ea'; cx.font = '20px sans-serif'; cx.fillText('健侧眼', 140, 28); cx.fillText('义眼片', 480, 28);
    const rec: DeliveryRecord = {
      id: uid('dlv'), patientId: p.id, snapshotId: '', schemeVersion: scheme.version ?? 1,
      createdAt: Date.now(), formulaRows: formula, metrics: allMetrics, pupilMm,
      signatureDataUrl: sigCanvas.toDataURL('image/png'), compareImageDataUrl: comp.toDataURL('image/jpeg', 0.85),
      signedAt: Date.now(), note: noteInput.value,
    };
    signedRecord = rec;
    await repo.saveDelivery(rec);
    await repo.saveSnapshot({
      id: uid('snap'), patientId: p.id, schemeId: scheme.id, version: (await repo.listSnapshots(p.id)).length + 1,
      createdAt: Date.now(), reason: `交付归档 ${rec.id.slice(-6)}`, scheme: JSON.parse(JSON.stringify(scheme)), metrics: allMetrics,
    });
    toast('交付单已签字归档', 'good');
    ctx.refresh();
  });
  sheet.appendChild(h('div', { class: 'flex mt16' },
    h('button', { class: 'btn', onclick: () => window.print() }, icon('download'), '打印 / 另存 PDF'),
    h('span', { class: 'right' }, signBtn)));

  root.appendChild(sheet);

  // 历史交付
  const history = await repo.listDeliveries(p.id);
  if (history.length) {
    const hc = h('div', { class: 'card mt16' }, h('div', { class: 'card-hd' }, h('h3', null, `历史交付单（${history.length}）`)));
    const bd = h('div', { class: 'card-bd grid' });
    for (const d of history) {
      bd.appendChild(h('div', { class: 'flex wrap', style: 'gap:14px;align-items:center;border:1px solid var(--line);border-radius:10px;padding:12px' },
        d.compareImageDataUrl ? h('img', { src: d.compareImageDataUrl, style: 'width:130px;border-radius:8px;border:1px solid var(--line)' }) : null,
        h('div', null,
          h('div', { style: 'font-weight:700' }, new Date(d.createdAt).toLocaleString('zh-CN')),
          h('div', { class: 'small muted' }, `固定瞳孔 ${d.pupilMm.toFixed(2)}mm · 颜料行 ${d.formulaRows.length} · ${d.signedAt ? '已签字' : '未签字'}`),
          h('div', { class: 'flex mt8', style: 'gap:6px;flex-wrap:wrap' }, ...d.metrics.slice(0, 5).map((m) => badge(`${m.sceneName.slice(0, 4)} ${m.meanDeltaE.toFixed(1)}`, m.pass ? 'green' : 'red'))),
        ),
        h('span', { class: 'right flex', style: 'gap:8px' },
          h('button', { class: 'btn sm', onclick: () => viewDelivery(d) }, '查看单据'),
          h('button', {
            class: 'btn sm primary', onclick: async () => {
              const ns = cloneScheme(scheme);
              ns.id = uid('sch'); ns.version = (await repo.currentScheme(p.id))?.version ?? 1 + 1;
              ns.name = `源自交付 ${d.id.slice(-6)}`;
              await repo.saveScheme(ns);
              toast('已复制该交付配方为下一副新方案', 'good');
              ctx.navigate(`#/iris/${p.id}`);
            },
          }, '下一副从这份起步'),
        ),
      ));
    }
    hc.appendChild(bd);
    root.appendChild(hc);
  }
  void signedRecord;
}

function info(label: string, value: string): HTMLElement {
  return h('div', null, h('div', { class: 'small muted' }, label), h('div', { style: 'font-weight:650' }, value));
}

function viewDelivery(d: DeliveryRecord) {
  const body = h('div', { class: 'grid' });
  if (d.compareImageDataUrl) body.appendChild(h('img', { src: d.compareImageDataUrl, style: 'width:100%;border-radius:10px' }));
  body.appendChild(h('div', { class: 'small muted' }, `瞳孔 ${d.pupilMm.toFixed(2)}mm · ${d.note || '无备注'}`));
  if (d.signatureDataUrl) body.appendChild(h('img', { src: d.signatureDataUrl, style: 'height:90px;border:1px solid var(--line);border-radius:8px;background:#fff' }));
  modal({ title: '交付单详情', body, wide: true, footer: [] });
}
