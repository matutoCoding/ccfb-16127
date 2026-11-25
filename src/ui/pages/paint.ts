/** 虹膜绘制页：底色/放射纹/卷缩轮/色素斑/巩膜分层选色号与遮盖比例，实时 HDR 渲染，快照留档 */
import { db, uid } from '../../db/idb';
import { getState, setState, navigate } from '../state';
import { PIGMENT_CATALOG, pigmentsByLayer, getPigment } from '../../pigment/catalog';
import { defaultPaintScheme } from '../../render/eyeModel';
import { getRenderBackend } from '../../render/backend';
import { LIGHTING_SCENES, SCENE_ORDER } from '../../render/scenes';
import { drawHdr } from '../canvas';
import { optimizeFixedPupil, fixedPupilFraction, healthyPupilMm } from '../../render/pupil';
import type { PaintLayer, PaintScheme, SceneId } from '../../core/types';
import { linearRgbToHex } from '../../core/color';

type LayerKey = 'base' | 'fibers' | 'collarette' | 'spots' | 'scleraBase' | 'vessels';
const LAYER_META: Array<{ key: LayerKey; title: string; catalog: PaintLayer['key'] extends never ? never : import('../../pigment/catalog').Pigment['layer'] }> = [
  { key: 'base', title: '① 虹膜底色层', catalog: 'base' },
  { key: 'fibers', title: '② 放射纹层', catalog: 'fibers' },
  { key: 'collarette', title: '③ 卷缩轮', catalog: 'collarette' },
  { key: 'spots', title: '④ 色素斑', catalog: 'spots' },
  { key: 'scleraBase', title: '巩膜淡黄底色', catalog: 'sclera' },
  { key: 'vessels', title: '巩膜血管', catalog: 'vessels' },
];

export async function renderPaintPage(): Promise<HTMLElement> {
  const el = document.createElement('div');
  const s = getState();
  if (!s.currentPatientId) {
    el.innerHTML = '<h2 class="page-title">虹膜绘制</h2><div class="card">请先选择患者。</div>';
    return el;
  }
  const patient = s.patients.find((p) => p.id === s.currentPatientId)!;

  // 载入或新建方案
  let scheme: PaintScheme;
  const existing = s.currentSchemeId ? await db.schemes.get(s.currentSchemeId) : undefined;
  if (existing) {
    scheme = structuredClone(existing);
  } else {
    const list = await db.schemes.listFor(patient.id);
    scheme = list[0] ? structuredClone(list[0]) : defaultPaintScheme(patient.id, (Date.now() % 100000) + 1);
    scheme.id = uid('scheme');
    scheme.patientId = patient.id;
  }

  let sceneId: SceneId = 'clinic';
  const renderSize = 224;

  el.innerHTML = `
    <h2 class="page-title">虹膜绘制 — ${patient.name}</h2>
    <p class="page-desc">按技师手绘顺序分层叠加真实颜料色号，全程在线性 HDR 域混合；右侧实时渲染角膜高光、虹膜纵深与巩膜湿润光泽。</p>
    <div class="grid" style="grid-template-columns: 360px 1fr; gap:18px">
      <div>
        <div class="card" id="layers"></div>
        <div class="card">
          <h3>透明角膜凸面 / 湿润</h3>
          <label class="field">角膜光泽（高光锐度）<input type="range" id="gloss" min="0" max="1" step="0.01" value="${scheme.cornea.gloss}"></label>
          <label class="field">巩膜湿润度<input type="range" id="wetness" min="0" max="1" step="0.01" value="${scheme.wetness}"></label>
          <h3 style="margin-top:14px">固定瞳孔</h3>
          <div id="pupil-info" class="muted" style="font-size:12px;margin-bottom:8px"></div>
          <div class="btn-row">
            <button class="btn secondary" id="pupil-opt">按四场景估算最优固定瞳孔</button>
          </div>
        </div>
        <div class="card">
          <div class="btn-row">
            <button class="btn" id="save">保存方案</button>
            <button class="btn secondary" id="snapshot">存配色快照</button>
            <button class="btn secondary" id="to-compare">去成像比对 →</button>
          </div>
        </div>
      </div>
      <div>
        <div class="card">
          <div class="pill-group" id="scene-tabs" style="margin-bottom:12px">
            ${SCENE_ORDER.map((id) => `<button data-scene="${id}" class="${id === sceneId ? 'selected' : ''}">${LIGHTING_SCENES[id].name}</button>`).join('')}
          </div>
          <div class="canvas-wrap"><canvas id="render-canvas"></canvas></div>
          <div class="muted" style="margin-top:8px;font-size:12px">渲染后端：<span id="backend-kind">…</span> ｜ 输出为 scene-linear Float32 HDR，未经 8 位截断</div>
        </div>
        <div class="card"><h3>配色快照历史</h3><div id="snap-list" class="muted">加载中…</div></div>
      </div>
    </div>`;

  const layersEl = el.querySelector<HTMLDivElement>('#layers')!;
  function renderLayerEditors(): void {
    layersEl.innerHTML = LAYER_META.map((meta) => {
      const layer = scheme[meta.key] as PaintLayer;
      const pigments = pigmentsByLayer(meta.catalog);
      const cur = getPigment(layer.pigmentId);
      return `<div class="layer-block">
        <h4>${meta.title}</h4>
        <label class="field">颜料色号<select data-layer="${meta.key}" data-prop="pigment">
          ${pigments.map((p) => `<option value="${p.id}" ${p.id === layer.pigmentId ? 'selected' : ''}>${p.code} ${p.name}</option>`).join('')}
        </select></label>
        <label class="field">遮盖比例 <span class="mono" id="cov-${meta.key}">${(layer.coverage * 100).toFixed(0)}%</span>
          <input type="range" data-layer="${meta.key}" data-prop="coverage" min="0" max="1" step="0.01" value="${layer.coverage}"></label>
        <label class="field">不透明度 <span class="mono" id="op-${meta.key}">${(layer.opacity * 100).toFixed(0)}%</span>
          <input type="range" data-layer="${meta.key}" data-prop="opacity" min="0" max="1" step="0.01" value="${layer.opacity}"></label>
        <div class="muted" style="font-size:12px;margin-top:4px"><span class="swatch" style="background:${cur.hex}"></span>当前 ${cur.code} ${cur.name}</div>
      </div>`;
    }).join('');

    layersEl.querySelectorAll<HTMLSelectElement>('select[data-prop="pigment"]').forEach((sel) => {
      sel.onchange = () => {
        (scheme[sel.dataset.layer as LayerKey] as PaintLayer).pigmentId = sel.value;
        renderLayerEditors();
        scheduleRender();
      };
    });
    layersEl.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach((inp) => {
      inp.oninput = () => {
        const layer = scheme[inp.dataset.layer as LayerKey] as PaintLayer;
        const v = Number(inp.value);
        if (inp.dataset.prop === 'coverage') {
          layer.coverage = v;
          el.querySelector<HTMLSpanElement>(`#cov-${inp.dataset.layer}`)!.textContent = `${(v * 100).toFixed(0)}%`;
        } else {
          layer.opacity = v;
          el.querySelector<HTMLSpanElement>(`#op-${inp.dataset.layer}`)!.textContent = `${(v * 100).toFixed(0)}%`;
        }
        scheduleRender();
      };
    });
  }
  renderLayerEditors();

  // 角膜/湿润
  el.querySelector<HTMLInputElement>('#gloss')!.oninput = (e) => {
    scheme.cornea.gloss = Number((e.target as HTMLInputElement).value);
    scheduleRender();
  };
  el.querySelector<HTMLInputElement>('#wetness')!.oninput = (e) => {
    scheme.wetness = Number((e.target as HTMLInputElement).value);
    scheduleRender();
  };

  // 场景切换
  el.querySelector<HTMLDivElement>('#scene-tabs')!.querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      sceneId = b.dataset.scene as SceneId;
      el.querySelectorAll('#scene-tabs button').forEach((x) => x.classList.toggle('selected', x === b));
      scheduleRender();
    };
  });

  // 瞳孔优化
  function refreshPupilInfo(): void {
    const opt = optimizeFixedPupil();
    el.querySelector<HTMLDivElement>('#pupil-info')!.innerHTML =
      `四场景健侧瞳孔：${SCENE_ORDER.map((id) => `${LIGHTING_SCENES[id].name} ${healthyPupilMm(id).toFixed(1)}mm`).join('；')}<br>` +
      `当前固定瞳孔：${(scheme.fixedPupilMm ?? opt.fixedPupilMm).toFixed(1)} mm（占虹膜半径 ${(fixedPupilFraction(scheme.fixedPupilMm ?? opt.fixedPupilMm) * 100).toFixed(0)}%）`;
  }
  refreshPupilInfo();
  el.querySelector<HTMLButtonElement>('#pupil-opt')!.onclick = () => {
    const opt = optimizeFixedPupil();
    scheme.fixedPupilMm = opt.fixedPupilMm;
    scheme.pupilFraction = fixedPupilFraction(opt.fixedPupilMm);
    refreshPupilInfo();
    scheduleRender();
  };

  // 渲染（防抖）
  const backend = await getRenderBackend(true);
  el.querySelector<HTMLElement>('#backend-kind')!.textContent = backend.kind === 'webgpu' ? 'WebGPU（GPU 着色器）' : 'CPU 回退（参考渲染器）';
  let timer = 0;
  async function doRender(): Promise<void> {
    const fixedFraction = scheme.fixedPupilMm ? fixedPupilFraction(scheme.fixedPupilMm) : scheme.pupilFraction;
    const hdr = await backend.render({ scheme, scene: LIGHTING_SCENES[sceneId], size: renderSize, pupilFractionOverride: fixedFraction });
    drawHdr(el.querySelector<HTMLCanvasElement>('#render-canvas')!, hdr, 1);
  }
  function scheduleRender(): void {
    clearTimeout(timer);
    timer = window.setTimeout(doRender, 60);
  }
  await doRender();

  // 保存
  el.querySelector<HTMLButtonElement>('#save')!.onclick = async () => {
    scheme.createdAt = Date.now();
    await db.schemes.save(scheme);
    setState({ currentSchemeId: scheme.id });
    alert('方案已保存到 IndexedDB');
  };
  // 快照
  el.querySelector<HTMLButtonElement>('#snapshot')!.onclick = async () => {
    await db.snapshots.save({
      id: uid('snap'),
      patientId: patient.id,
      schemeId: scheme.id,
      label: `快照 ${new Date().toLocaleTimeString('zh-CN')}`,
      scheme: structuredClone(scheme),
      createdAt: Date.now(),
    });
    loadSnapshots();
  };
  el.querySelector<HTMLButtonElement>('#to-compare')!.onclick = async () => {
    await db.schemes.save(scheme);
    setState({ currentSchemeId: scheme.id });
    navigate('compare');
  };

  async function loadSnapshots(): Promise<void> {
    const snaps = await db.snapshots.listFor(patient.id);
    const host = el.querySelector<HTMLDivElement>('#snap-list')!;
    if (!snaps.length) {
      host.textContent = '尚无快照。每次调整后点「存配色快照」留档，可回溯每版配色。';
      return;
    }
    host.innerHTML = snaps
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((sn) => {
        const layers = [sn.scheme.base, sn.scheme.fibers, sn.scheme.collarette, sn.scheme.spots, sn.scheme.vessels]
          .map((l) => getPigment(l.pigmentId).code)
          .join(' / ');
        return `<div style="padding:8px 0;border-bottom:1px solid var(--border)">
          <b>${sn.label}</b> <span class="muted mono" style="font-size:11px">${layers}</span></div>`;
      })
      .join('');
  }
  loadSnapshots();
  void PIGMENT_CATALOG;
  void linearRgbToHex;
  return el;
}
