/** 交付确认页：配色单（每层色号+遮盖比例）、并排比对图、四场景色差表、患者签字存档 */
import { db, uid } from '../../db/idb';
import { getState, navigate } from '../state';
import { SCENE_ORDER, LIGHTING_SCENES } from '../../render/scenes';
import { getPigment } from '../../pigment/catalog';
import { drawLdr } from '../canvas';
import type { DeliveryRecord, PaintLayer, SceneId } from '../../core/types';

export async function renderDeliveryPage(): Promise<HTMLElement> {
  const el = document.createElement('div');
  const s = getState();
  if (!s.currentPatientId) {
    el.innerHTML = '<h2 class="page-title">交付确认</h2><div class="card">请先选择患者。</div>';
    return el;
  }
  const patient = s.patients.find((p) => p.id === s.currentPatientId)!;
  const schemes = await db.schemes.listFor(patient.id);
  const scheme = schemes.find((x) => x.id === s.currentSchemeId) ?? schemes[0];
  const reports = await db.reports.listFor(patient.id);
  const report = reports.find((r) => r.id === s.currentReportId) ?? reports.sort((a, b) => b.createdAt - a.createdAt)[0];
  const settings = await db.settings();

  if (!scheme || !report) {
    el.innerHTML = '<h2 class="page-title">交付确认</h2><div class="card">需要先完成配色方案与成像比对。</div>';
    return el;
  }

  const layerRows: Array<{ name: string; layer: PaintLayer }> = [
    { name: '虹膜底色层', layer: scheme.base },
    { name: '放射纹层', layer: scheme.fibers },
    { name: '卷缩轮层', layer: scheme.collarette },
    { name: '色素斑层', layer: scheme.spots },
    { name: '巩膜淡黄底色', layer: scheme.scleraBase },
    { name: '巩膜血管', layer: scheme.vessels },
  ];

  el.innerHTML = `
    <h2 class="page-title">交付确认 — ${patient.name}</h2>
    <p class="page-desc">配色单与四场景色差表随患者签字一并存档；下一副义眼片可直接从本方案起步。</p>
    <div class="grid grid-2">
      <div class="card">
        <h3>配色单（颜料色号与遮盖比例）</h3>
        <table><thead><tr><th>图层</th><th>色号</th><th>颜料</th><th>遮盖</th><th>不透明度</th></tr></thead><tbody>
          ${layerRows
            .map(({ name, layer }) => {
              const p = getPigment(layer.pigmentId);
              return `<tr><td>${name}</td><td class="mono">${p.code}</td>
                <td><span class="swatch" style="background:${p.hex}"></span>${p.name}</td>
                <td class="metric">${(layer.coverage * 100).toFixed(0)}%</td>
                <td class="metric">${(layer.opacity * 100).toFixed(0)}%</td></tr>`;
            })
            .join('')}
        </tbody></table>
        <div class="muted" style="margin-top:10px;font-size:12px">
          角膜光泽 ${(scheme.cornea.gloss * 100).toFixed(0)}% ｜ 巩膜湿润 ${(scheme.wetness * 100).toFixed(0)}% ｜
          固定瞳孔 ${scheme.fixedPupilMm?.toFixed(1) ?? '—'} mm
        </div>
      </div>
      <div class="card">
        <h3>四场景色差表（ΔE00，阈值 ${settings.deltaEThreshold}）</h3>
        <table><thead><tr><th>场景</th><th>平均ΔE</th><th>各环带</th><th>结论</th></tr></thead><tbody>
          ${SCENE_ORDER.map((id) => {
            const sc = report.scenes[id];
            const rings = sc.rings.map((r) => r.meanDeltaE.toFixed(1)).join(' / ');
            return `<tr><td>${LIGHTING_SCENES[id].name}</td><td class="metric ${sc.averageDeltaE < 3 ? 'good-text' : 'bad-text'}">${sc.averageDeltaE.toFixed(2)}</td>
              <td class="mono" style="font-size:11px">${rings}</td>
              <td>${sc.averageDeltaE < 3 ? '<span class="badge good">达标</span>' : '<span class="badge bad">需返工</span>'}</td></tr>`;
          }).join('')}
        </tbody></table>
        <div style="margin-top:8px">总平均 <b class="metric ${report.overallAverageDeltaE < 3 ? 'good-text' : 'bad-text'}">${report.overallAverageDeltaE.toFixed(2)}</b></div>
      </div>
    </div>
    <div class="card">
      <h3>并排比对图（诊室灯 / 闪光灯）</h3>
      <div style="display:flex;gap:24px;flex-wrap:wrap">
        ${['clinic', 'flash']
          .map(
            (id) => `<div>
              <div class="muted" style="margin-bottom:6px">${LIGHTING_SCENES[id as SceneId].name}</div>
              <div style="display:flex;gap:8px">
                <canvas id="h-${id}" width="140" height="140" style="border:1px solid var(--border);border-radius:6px"></canvas>
                <canvas id="p-${id}" width="140" height="140" style="border:1px solid var(--border);border-radius:6px"></canvas>
              </div>
              <div class="muted" style="font-size:11px">左：健侧　右：义眼</div>
            </div>`,
          )
          .join('')}
      </div>
    </div>
    <div class="card">
      <h3>患者签字确认</h3>
      <canvas id="sig" class="signature-pad" width="640" height="160"></canvas>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn secondary" id="clear-sig">清除签名</button>
        <button class="btn" id="archive">确认并存档</button>
      </div>
      <div id="archived" class="muted" style="margin-top:10px"></div>
    </div>
    <div class="card"><h3>历史交付记录</h3><div id="history" class="muted">加载中…</div></div>`;

  // 比对图
  for (const id of ['clinic', 'flash'] as const) {
    drawLdr(el.querySelector<HTMLCanvasElement>(`#h-${id}`)!, report.scenes[id].healthyLdr);
    drawLdr(el.querySelector<HTMLCanvasElement>(`#p-${id}`)!, report.scenes[id].prosthesisLdr);
  }

  // 签字板
  const sig = el.querySelector<HTMLCanvasElement>('#sig')!;
  const sctx = sig.getContext('2d')!;
  sctx.lineWidth = 2.2;
  sctx.lineCap = 'round';
  sctx.strokeStyle = '#111';
  let drawing = false;
  const pos = (e: MouseEvent | TouchEvent) => {
    const r = sig.getBoundingClientRect();
    const pt = 'touches' in e ? e.touches[0] : e;
    return { x: ((pt.clientX - r.left) / r.width) * sig.width, y: ((pt.clientY - r.top) / r.height) * sig.height };
  };
  const start = (e: MouseEvent | TouchEvent) => {
    drawing = true;
    const p = pos(e);
    sctx.beginPath();
    sctx.moveTo(p.x, p.y);
    e.preventDefault();
  };
  const move = (e: MouseEvent | TouchEvent) => {
    if (!drawing) return;
    const p = pos(e);
    sctx.lineTo(p.x, p.y);
    sctx.stroke();
    e.preventDefault();
  };
  const end = () => (drawing = false);
  sig.addEventListener('mousedown', start);
  sig.addEventListener('mousemove', move);
  sig.addEventListener('mouseup', end);
  sig.addEventListener('mouseleave', end);
  sig.addEventListener('touchstart', start, { passive: false });
  sig.addEventListener('touchmove', move, { passive: false });
  sig.addEventListener('touchend', end);
  el.querySelector<HTMLButtonElement>('#clear-sig')!.onclick = () => sctx.clearRect(0, 0, sig.width, sig.height);

  el.querySelector<HTMLButtonElement>('#archive')!.onclick = async () => {
    const record: DeliveryRecord = {
      id: uid('del'),
      patientId: patient.id,
      schemeId: scheme.id,
      reportId: report.id,
      createdAt: Date.now(),
      scheme: structuredClone(scheme),
      signature: sig.toDataURL('image/png'),
      technician: settings.technicianName || '未署名技师',
      archived: true,
    };
    await db.deliveries.save(record);
    el.querySelector<HTMLDivElement>('#archived')!.innerHTML =
      '<span class="badge good">已存档</span> 配色单、色差表与签名已保存到本地 IndexedDB，下一副可从本方案起步。';
    loadHistory();
  };

  async function loadHistory(): Promise<void> {
    const list = await db.deliveries.listFor(patient.id);
    const host = el.querySelector<HTMLDivElement>('#history')!;
    host.innerHTML = list.length
      ? list
          .sort((a, b) => b.createdAt - a.createdAt)
          .map((d) => `<div style="padding:8px 0;border-bottom:1px solid var(--border)">${new Date(d.createdAt).toLocaleString('zh-CN')} ｜ ${d.technician} ${d.signature ? '✍️ 已签字' : ''}</div>`)
          .join('')
      : '尚无交付记录';
  }
  loadHistory();
  void navigate;
  return el;
}
