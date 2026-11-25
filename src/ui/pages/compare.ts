/** 成像比对页：四场景并排、过同一响应曲线、虹膜环带 ΔE00 与图层归因 */
import { db, uid } from '../../db/idb';
import { getState, navigate, setState } from '../state';
import { buildComparisonReport } from '../../core/comparison';
import { LIGHTING_SCENES, SCENE_ORDER } from '../../render/scenes';
import { drawLdr, drawHdr } from '../canvas';
import { makeMask } from '../../core/image';
import { fixedPupilFraction } from '../../render/pupil';
import { irisGeometry } from '../../render/eyeModel';
import type { ComparisonReport, SceneId } from '../../core/types';

export async function renderComparePage(): Promise<HTMLElement> {
  const el = document.createElement('div');
  const s = getState();
  if (!s.currentPatientId || !s.currentCaptureId) {
    el.innerHTML = '<h2 class="page-title">成像比对</h2><div class="card">需要先完成健侧眼拍摄并选择配色方案。</div>';
    return el;
  }
  const patient = s.patients.find((p) => p.id === s.currentPatientId)!;
  const capture = await db.captures.get(s.currentCaptureId);
  const schemes = await db.schemes.listFor(patient.id);
  const scheme = schemes.find((x) => x.id === s.currentSchemeId) ?? schemes[0];
  if (!capture || !scheme) {
    el.innerHTML = '<h2 class="page-title">成像比对</h2><div class="card">缺少 HDR 拍摄记录或配色方案。</div>';
    return el;
  }
  const settings = await db.settings();

  el.innerHTML = `
    <h2 class="page-title">成像比对 — ${patient.name}</h2>
    <p class="page-desc">义眼渲染结果与健侧照片过<b>同一条相机响应曲线</b>、同一曝光与白平衡，在四种场景下并排比较；虹膜 5 个同心环带计算 CIEDE2000，超标环带标注并归因到颜料层。</p>
    <div class="card">
      <div class="btn-row">
        <button class="btn" id="run">运行四场景比对</button>
        <span id="overall" class="muted"></span>
      </div>
    </div>
    <div id="results"></div>
    <div class="card" id="attr-card" style="display:none"><h3>超标环带图层归因与调整建议</h3><div id="attributions"></div></div>`;

  el.querySelector<HTMLButtonElement>('#run')!.onclick = async () => {
    const btn = el.querySelector<HTMLButtonElement>('#run')!;
    btn.disabled = true;
    btn.textContent = '计算中…';
    await new Promise((r) => setTimeout(r, 30));
    const pupilFraction = scheme.fixedPupilMm ? fixedPupilFraction(scheme.fixedPupilMm) : scheme.pupilFraction;
    const report: ComparisonReport = buildComparisonReport({
      id: uid('report'),
      patientId: patient.id,
      captureId: capture.id,
      schemeId: scheme.id,
      healthyHdr: capture.hdr,
      healthyMask: makeMask(capture.hdr.width, capture.hdr.height),
      geometry: irisGeometry(capture.hdr.width, pupilFraction),
      scheme,
      curve: capture.response,
      ev: 0,
      deltaEThreshold: settings.deltaEThreshold,
      renderSize: capture.hdr.width,
    });
    // sequenceGeometry 需要完整序列，这里直接用渲染几何（与 eyeModel 一致：irisRadius=0.27·size）
    await db.reports.save(report);
    renderResults(report);
    btn.disabled = false;
    btn.textContent = '重新运行四场景比对';
    el.querySelector<HTMLSpanElement>('#overall')!.innerHTML =
      `四场景总平均 ΔE00 = <b class="${report.overallAverageDeltaE < 3 ? 'good-text' : 'bad-text'} metric">${report.overallAverageDeltaE.toFixed(2)}</b>（阈值 ${settings.deltaEThreshold}）`;
  };

  function renderResults(report: ComparisonReport): void {
    const host = el.querySelector<HTMLDivElement>('#results')!;
    host.innerHTML = `<div class="grid grid-2">${SCENE_ORDER.map((id) => sceneCard(id, report)).join('')}</div>`;
    SCENE_ORDER.forEach((id) => {
      const sc = report.scenes[id];
      const hc = el.querySelector<HTMLCanvasElement>(`#h-${id}`)!;
      const pc = el.querySelector<HTMLCanvasElement>(`#p-${id}`)!;
      drawLdr(hc, sc.healthyLdr);
      drawLdr(pc, sc.prosthesisLdr);
    });
    const attrCard = el.querySelector<HTMLElement>('#attr-card')!;
    const attrHost = el.querySelector<HTMLDivElement>('#attributions')!;
    if (report.attributions.length === 0) {
      attrCard.style.display = 'none';
    } else {
      attrCard.style.display = 'block';
      attrHost.innerHTML = report.attributions
        .map(
          (a) => `<div style="padding:8px 0;border-bottom:1px solid var(--border)">
          <span class="badge bad">${LIGHTING_SCENES[a.sceneId].name} · 环带${a.ringIndex + 1}</span>
          <b>${a.layerName}</b> <span class="muted">ΔE00=${a.deltaE.toFixed(2)}</span>
          <div class="muted" style="margin-top:4px">${a.advice}</div></div>`,
        )
        .join('');
    }
    // 交付入口
    const go = document.createElement('button');
    go.className = 'btn';
    go.style.marginTop = '14px';
    go.textContent = '生成交付确认单 →';
    go.onclick = () => {
      setState({ currentReportId: report.id });
      navigate('delivery');
    };
    host.appendChild(go);
    void drawHdr;
  }

  function sceneCard(id: SceneId, report: ComparisonReport): string {
    const sc = report.scenes[id];
    const avg = sc.averageDeltaE;
    return `<div class="card">
      <h3>${LIGHTING_SCENES[id].name} <span class="badge ${avg < 3 ? 'good' : 'bad'}">平均 ΔE00 ${avg.toFixed(2)}</span></h3>
      <div style="display:flex;gap:10px;justify-content:center">
        <div><div class="muted" style="text-align:center;font-size:12px">健侧（过曲线）</div><canvas id="h-${id}" class="thumb" style="width:150px;height:150px"></canvas></div>
        <div><div class="muted" style="text-align:center;font-size:12px">义眼渲染（过曲线）</div><canvas id="p-${id}" class="thumb" style="width:150px;height:150px"></canvas></div>
      </div>
      <table style="margin-top:10px"><thead><tr><th>环带</th><th>均值ΔE</th><th>峰值</th><th>状态</th></tr></thead><tbody>
        ${sc.rings
          .map(
            (r) => `<tr>
            <td>${r.ringIndex + 1} <span class="muted mono" style="font-size:11px">${r.rInner.toFixed(2)}-${r.rOuter.toFixed(2)}</span></td>
            <td class="metric">${r.meanDeltaE.toFixed(2)}</td>
            <td class="metric">${r.maxDeltaE.toFixed(2)}</td>
            <td>${r.exceeded ? '<span class="badge bad">超标</span>' : '<span class="badge good">合格</span>'}</td></tr>`,
          )
          .join('')}
      </tbody></table>
      <div class="muted" style="font-size:12px;margin-top:6px">健侧动态瞳孔 ${sc.healthyPupilMm.toFixed(2)} mm ｜ 样本 ${sc.rings[0].samples}</div>
    </div>`;
  }

  return el;
}
