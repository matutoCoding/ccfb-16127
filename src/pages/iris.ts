import { h, icon, badge, toast, modal } from '../ui/dom';
import { repo, idb } from '../data/db';
import { loadChainContext } from '../browser/chainContext';
import { EyeStage } from '../browser/EyeStage';
import { PIGMENTS, pigmentById, mixPigments } from '../core/pigments';
import { createScheme, uid, cloneScheme } from '../core/schemeFactory';
import { autoMatch } from '../core/matching';
import { schemeToLdrCanvas } from '../browser/renderView';
import { ldrToCanvas } from '../browser/canvas';
import type { AppCtx } from '../main';
import type { IrisScheme, PigmentMixItem } from '../core/types';

type LayerKey = 'base' | 'radial' | 'collarette' | 'spots' | 'sclera' | 'cornea';

const LAYERS: { key: LayerKey; name: string; desc: string }[] = [
  { key: 'base', name: '底色层（八环带）', desc: '真实颜料混合的径向底色' },
  { key: 'radial', name: '放射纹层', desc: '纤维走向与疏密' },
  { key: 'collarette', name: '卷缩轮层', desc: '波浪环沟与隆起' },
  { key: 'spots', name: '色素斑层', desc: '局部深色斑块' },
  { key: 'sclera', name: '巩膜 / 血管', desc: '分区淡黄底与血管密度' },
  { key: 'cornea', name: '透明角膜凸面', desc: 'Fresnel、高光与湿润' },
];

function slider(label: string, value: number, min: number, max: number, step: number, oninput: (v: number) => void, fmt?: (v: number) => string) {
  const val = h('span', { class: 'range-val' }, fmt ? fmt(value) : value.toFixed(2));
  const input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) }) as HTMLInputElement;
  input.addEventListener('input', () => {
    const v = Number(input.value);
    val.textContent = fmt ? fmt(v) : v.toFixed(2);
    oninput(v);
  });
  return h('div', { class: 'field' },
    h('label', { class: 'flex' }, h('span', null, label), h('span', { class: 'right' }, val)),
    input,
  );
}

function pigmentGrid(activeId: string | null, onPick: (id: string) => void): HTMLElement {
  return h('div', { class: 'pigment-grid' }, ...PIGMENTS.map((p) =>
    h('div', {
      class: `pigment-tile ${activeId === p.id ? 'active' : ''}`,
      style: `background:${p.hex}`,
      title: `${p.studioCode} ${p.name} · ${p.ci}`,
      onclick: () => onPick(p.id),
    }, h('span', null, p.studioCode)),
  ));
}

export async function renderIris(root: HTMLElement, ctx: AppCtx) {
  if (!ctx.patient) { root.appendChild(h('div', { class: 'card empty-state' }, '请先选择患者')); return; }
  const chain = await loadChainContext(ctx.patient, ctx.settings);
  let scheme: IrisScheme = chain.currentScheme ? cloneScheme(chain.currentScheme) : createScheme(ctx.patient);
  if (!scheme.fitGain && chain.currentScheme?.fitGain) scheme.fitGain = chain.currentScheme.fitGain;
  const gain = scheme.fitGain ?? chain.gain;
  let selected: LayerKey = 'base';
  let selectedBand = 3;
  let stage: EyeStage | null = null;

  root.appendChild(h('div', { class: 'flex wrap mb8' },
    h('div', null, h('h2', { style: 'font-size:19px' }, `虹膜分层绘制 · ${ctx.patient.name}`),
      h('div', { class: 'small muted' }, '所有颜色以线性 RGB 参与 HDR 渲染；颜料色号对应真实 Colour Index 颜料')),
    h('div', { class: 'right flex' },
      h('button', { class: 'btn', id: 'hist-btn' }, '快照历史'),
      h('button', { class: 'btn', id: 'refit-btn' }, icon('refresh'), '重新一键拟合'),
      h('button', { class: 'btn primary', id: 'save-btn' }, icon('save'), '保存并留快照'),
    ),
  ));

  if (!chain.curve) {
    root.appendChild(h('div', { class: 'card' }, h('div', { class: 'card-bd' }, '该患者还没有拍摄与响应曲线，请先到「健侧眼拍摄」导入或生成序列。')));
    return;
  }

  const layout = h('div', { class: 'iris-layout mt8' });
  const left = h('div', { class: 'card' }, h('div', { class: 'card-hd' }, h('h3', null, '图层')));
  const layerBox = h('div', { class: 'card-bd tight' });
  const paramBox = h('div', { style: 'padding:4px 14px 14px' });
  left.append(layerBox, h('div', { class: 'section-title', style: 'padding:0 14px' }, '参数 / 颜料'), paramBox);

  const center = h('div', { class: 'grid' });
  const stageCard = h('div', { class: 'iris-stage' });
  const stageHost = h('div', { style: 'width:100%;max-width:520px' });
  stageCard.appendChild(stageHost);
  const bandStrip = h('div', { class: 'flex wrap', style: 'gap:7px;justify-content:center' });
  const hint = h('div', { class: 'small', style: 'color:#9fc4ca' }, '');
  stageCard.append(bandStrip, hint);
  center.appendChild(stageCard);

  const right = h('div', { class: 'grid iris-right' });
  const recipeCard = h('div', { class: 'card' }, h('div', { class: 'card-hd' }, h('h3', null, '当前环带颜料配方')));
  const recipeBox = h('div', { class: 'card-bd tight' });
  recipeCard.appendChild(recipeBox);
  right.appendChild(recipeCard);

  layout.append(left, center, right);
  root.appendChild(layout);

  stage = await EyeStage.mount(stageHost, {
    geom: chain.geom, curve: chain.curve, gain, wb: chain.wb,
    irisDiameterMm: chain.irisDiameterMm, prefer: ctx.settings.renderBackend,
  });
  stage.update(scheme);

  function markDirty() {
    stage?.update(scheme);
  }

  function renderLayerList() {
    layerBox.replaceChildren();
    for (const l of LAYERS) {
      const enabled = isLayerEnabled(l.key);
      const item = h('div', { class: `layer-item ${selected === l.key ? 'active' : ''}`, onclick: () => { selected = l.key; renderAll(); } },
        h('span', null, l.name),
        h('span', { class: 'eye-toggle right', title: '显示/隐藏', onclick: (e: Event) => { e.stopPropagation(); toggleLayer(l.key); renderAll(); } }, enabled ? '👁' : '—'),
      );
      layerBox.appendChild(item);
    }
  }
  function isLayerEnabled(k: LayerKey): boolean {
    if (k === 'base') return true;
    if (k === 'radial') return scheme.radial.enabled;
    if (k === 'collarette') return scheme.collarette.enabled;
    if (k === 'spots') return scheme.spots.enabled;
    return true;
  }
  function toggleLayer(k: LayerKey) {
    if (k === 'radial') scheme.radial.enabled = !scheme.radial.enabled;
    if (k === 'collarette') scheme.collarette.enabled = !scheme.collarette.enabled;
    if (k === 'spots') scheme.spots.enabled = !scheme.spots.enabled;
    markDirty();
  }

  function renderBandStrip() {
    bandStrip.replaceChildren();
    for (let b = 0; b < scheme.bandCount; b++) {
      const c = scheme.bandRGB[b];
      const hex = `#${[c[0], c[1], c[2]].map((v) => Math.round(255 * Math.pow(Math.max(0, Math.min(1, v)), 1 / 2.2))).map((v) => v.toString(16).padStart(2, '0')).join('')}`;
      const sw = h('button', {
        title: `环带 ${b + 1}`,
        style: `width:34px;height:34px;border-radius:50%;border:2px solid ${selectedBand === b ? 'var(--teal)' : 'rgba(255,255,255,.25)'};background:${hex};cursor:pointer`,
        onclick: () => { selectedBand = b; renderParams(); renderRecipe(); renderBandStrip(); },
      });
      bandStrip.appendChild(sw);
    }
  }

  function renderRecipe() {
    recipeBox.replaceChildren();
    if (selected !== 'base') {
      recipeBox.appendChild(h('div', { class: 'small muted', style: 'padding:8px 6px' }, '在左侧选择「底色层」可编辑八环带颜料配方。当前层使用单一主颜料。'));
      const pid = singlePigmentOf(selected);
      if (pid) recipeBox.appendChild(h('div', { style: 'padding:6px' }, pigmentById(pid).name, ' · ', h('span', { class: 'pigment-code' }, pigmentById(pid).studioCode)));
      return;
    }
    if (scheme.bandCalibrated) {
      recipeBox.appendChild(h('div', { class: 'advice-card', style: 'margin:6px' },
        h('b', null, 'HDR 闭环校准底色'),
        'bandRGB 为实测权威色；下方是最接近的真实颜料配方。手动改配比后将切换为纯颜料混合渲染。'));
    }
    const mix = scheme.bandMix[selectedBand] ?? [];
    const rows = h('div', { style: 'padding:4px 8px' });
    mix.forEach((it: PigmentMixItem, idx) => {
      const pg = pigmentById(it.pigmentId);
      const rng = h('input', { type: 'range', min: '0', max: '1', step: '0.01', value: String(it.ratio), style: 'flex:1' }) as HTMLInputElement;
      rng.oninput = () => {
        it.ratio = Number(rng.value);
        const sum = mix.reduce((a, x) => a + x.ratio, 0) || 1;
        mix.forEach((x) => (x.ratio = x.ratio / sum));
        applyMix();
      };
      rows.appendChild(h('div', { class: 'recipe-row' },
        h('span', { class: 'swatch sm', style: `background:${pg.hex}` }),
        h('div', { style: 'width:118px' }, h('div', { style: 'font-size:12.5px;font-weight:600' }, pg.name), h('span', { class: 'pigment-code' }, pg.studioCode)),
        rng,
        h('span', { class: 'mono small', style: 'width:44px;text-align:right' }, `${(it.ratio * 100).toFixed(0)}%`),
        h('button', { class: 'btn ghost sm', onclick: () => { mix.splice(idx, 1); applyMix(); } }, '✕'),
      ));
    });
    const addBox = h('div', { style: 'padding:8px 6px 2px' },
      h('div', { class: 'small muted mb8' }, '加入颜料（点击目录色号）：'),
      pigmentGrid(null, (pid) => {
        const ex = mix.find((x) => x.pigmentId === pid);
        if (ex) ex.ratio += 0.2; else mix.push({ pigmentId: pid, ratio: 0.2 });
        const sum = mix.reduce((a, x) => a + x.ratio, 0);
        mix.forEach((x) => (x.ratio = x.ratio / sum));
        applyMix();
      }),
    );
    function applyMix() {
      // 从 HDR 归一化校准色切到纯颜料物理色时，同步把 gain 换成物理尺度
      if (scheme.bandCalibrated && scheme.hdrScale && scheme.fitGain) {
        scheme.fitGain = scheme.fitGain * scheme.hdrScale;
        scheme.hdrScale = 1;
      }
      scheme.bandCalibrated = false;
      scheme.bandMix[selectedBand] = mix;
      scheme.bandRGB[selectedBand] = mixPigments(mix);
      renderRecipe(); renderBandStrip(); markDirty();
    }
    recipeBox.append(h('div', { class: 'small', style: 'padding:8px 8px 0;font-weight:700' }, `环带 ${selectedBand + 1} 配方`), rows, addBox);
  }

  function singlePigmentOf(k: LayerKey): string | null {
    if (k === 'radial') return scheme.radial.pigment;
    if (k === 'collarette') return scheme.collarette.pigment;
    if (k === 'spots') return scheme.spots.pigment;
    if (k === 'sclera') return scheme.sclera.basePigment;
    return null;
  }

  function renderParams() {
    paramBox.replaceChildren();
    const k = selected;
    if (k === 'base') {
      paramBox.appendChild(h('div', { class: 'small muted mb8' }, '点选下方八个环带之一，在右侧编辑其颜料配比。环带从瞳孔缘向外编号。'));
      paramBox.appendChild(renderBandStripInline());
      return;
    }
    if (k === 'radial') {
      paramBox.appendChild(pigmentGrid(scheme.radial.pigment, (id) => { scheme.radial.pigment = id; renderParams(); renderRecipe(); markDirty(); }));
      paramBox.appendChild(h('div', { class: 'mt16' },
        slider('遮盖比例', scheme.radial.coverage, 0, 1, .01, (v) => { scheme.radial.coverage = v; markDirty(); }, (v) => `${(v * 100).toFixed(0)}%`),
        slider('透明度', scheme.radial.opacity, 0, 1, .01, (v) => { scheme.radial.opacity = v; markDirty(); }, (v) => `${(v * 100).toFixed(0)}%`),
        slider('纤维密度', scheme.radial.count, 40, 320, 1, (v) => { scheme.radial.count = Math.round(v); markDirty(); }, (v) => `${Math.round(v)} 根`),
        slider('明暗对比', scheme.radial.contrast, 0, 2, .05, (v) => { scheme.radial.contrast = v; markDirty(); }),
      ));
    } else if (k === 'collarette') {
      paramBox.appendChild(pigmentGrid(scheme.collarette.pigment, (id) => { scheme.collarette.pigment = id; renderParams(); renderRecipe(); markDirty(); }));
      paramBox.appendChild(h('div', { class: 'mt16' },
        slider('遮盖比例', scheme.collarette.coverage, 0, 1, .01, (v) => { scheme.collarette.coverage = v; markDirty(); }, (v) => `${(v * 100).toFixed(0)}%`),
        slider('透明度', scheme.collarette.opacity, 0, 1, .01, (v) => { scheme.collarette.opacity = v; markDirty(); }, (v) => `${(v * 100).toFixed(0)}%`),
        slider('轮位置', scheme.collarette.radius, .25, .7, .01, (v) => { scheme.collarette.radius = v; markDirty(); }),
        slider('轮宽度', scheme.collarette.width, .02, .12, .005, (v) => { scheme.collarette.width = v; markDirty(); }),
        slider('不规则度', scheme.collarette.irregularity, 0, 1.5, .05, (v) => { scheme.collarette.irregularity = v; markDirty(); }),
      ));
    } else if (k === 'spots') {
      paramBox.appendChild(pigmentGrid(scheme.spots.pigment, (id) => { scheme.spots.pigment = id; renderParams(); renderRecipe(); markDirty(); }));
      paramBox.appendChild(h('div', { class: 'mt16' },
        slider('遮盖比例', scheme.spots.coverage, 0, .6, .01, (v) => { scheme.spots.coverage = v; markDirty(); }, (v) => `${(v * 100).toFixed(0)}%`),
        slider('透明度', scheme.spots.opacity, 0, 1, .01, (v) => { scheme.spots.opacity = v; markDirty(); }, (v) => `${(v * 100).toFixed(0)}%`),
        slider('斑数量', scheme.spots.count, 0, 30, 1, (v) => { scheme.spots.count = Math.round(v); markDirty(); }, (v) => `${Math.round(v)}`),
      ));
    } else if (k === 'sclera') {
      paramBox.appendChild(h('div', { class: 'small', style: 'font-weight:700' }, '巩膜底色颜料'));
      paramBox.appendChild(pigmentGrid(scheme.sclera.basePigment, (id) => { scheme.sclera.basePigment = id; renderParams(); markDirty(); }));
      paramBox.appendChild(h('div', { class: 'small mt16', style: 'font-weight:700' }, '淡黄底色颜料'));
      paramBox.appendChild(pigmentGrid(scheme.sclera.yellowPigment, (id) => { scheme.sclera.yellowPigment = id; renderParams(); markDirty(); }));
      paramBox.appendChild(h('div', { class: 'mt16' },
        slider('整体淡黄强度', scheme.sclera.baseYellow, 0, .6, .01, (v) => { scheme.sclera.baseYellow = v; markDirty(); }, (v) => `${(v * 100).toFixed(0)}%`),
        slider('湿润光泽', scheme.sclera.wetness, 0, 1, .01, (v) => { scheme.sclera.wetness = v; markDirty(); }, (v) => `${(v * 100).toFixed(0)}%`),
        slider('血管浓度', scheme.sclera.vesselOpacity, 0, 1, .01, (v) => { scheme.sclera.vesselOpacity = v; markDirty(); }, (v) => `${(v * 100).toFixed(0)}%`),
      ));
      for (const r of scheme.sclera.regions) {
        paramBox.appendChild(slider(`${r.label} · 淡黄`, r.yellow, 0, .8, .01, (v) => { r.yellow = v; markDirty(); }, (v) => v.toFixed(2)));
        paramBox.appendChild(slider(`${r.label} · 血管密度`, r.vesselDensity, 0, 1, .01, (v) => { r.vesselDensity = v; markDirty(); }, (v) => v.toFixed(2)));
      }
    } else if (k === 'cornea') {
      paramBox.appendChild(slider('高光强度(HDR)', scheme.cornea.highlightHdr, 0, 4, .1, (v) => { scheme.cornea.highlightHdr = v; markDirty(); }));
      paramBox.appendChild(slider('高光锐度/光泽', scheme.cornea.gloss, 0, 1, .01, (v) => { scheme.cornea.gloss = v; markDirty(); }, (v) => `${(v * 100).toFixed(0)}%`));
      paramBox.appendChild(slider('Fresnel 边缘反射', scheme.cornea.fresnel, 0, 1.2, .02, (v) => { scheme.cornea.fresnel = v; markDirty(); }));
      paramBox.appendChild(slider('高光水平位置', scheme.cornea.highlightX, .25, .75, .01, (v) => { scheme.cornea.highlightX = v; markDirty(); }));
      paramBox.appendChild(slider('高光垂直位置', scheme.cornea.highlightY, .2, .6, .01, (v) => { scheme.cornea.highlightY = v; markDirty(); }));
      paramBox.appendChild(h('div', { class: 'small muted mt8' }, '最上层透明 PMMA 角膜凸面，不加颜料；高光以 >1 的 HDR 强度在线性目标上叠加。'));
    }
  }

  function renderBandStripInline(): HTMLElement {
    const wrap = h('div', { class: 'flex wrap', style: 'gap:6px' });
    scheme.bandRGB.forEach((c, b) => {
      const hex = rgbToHex(c);
      wrap.appendChild(h('button', {
        style: `width:30px;height:30px;border-radius:7px;border:2px solid ${selectedBand === b ? 'var(--teal)' : 'var(--line)'};background:${hex};cursor:pointer`,
        title: `环带 ${b + 1}`,
        onclick: () => { selectedBand = b; renderParams(); renderRecipe(); renderBandStrip(); },
      }));
    });
    return wrap;
  }

  function renderAll() {
    renderLayerList(); renderParams(); renderRecipe(); renderBandStrip();
  }
  renderAll();

  // 顶部动作
  root.querySelector('#save-btn')!.addEventListener('click', async () => {
    await repo.saveScheme(scheme);
    let thumb = '';
    try {
      thumb = schemeToLdrCanvas(scheme, chain.geom, chain.curve!, {
        size: 220, gain, wb: chain.wb, irisDiameterMm: chain.irisDiameterMm,
      }).toDataURL('image/jpeg', 0.8);
    } catch { thumb = ''; }
    const snap = {
      id: uid('snap'), patientId: ctx.patient!.id, schemeId: scheme.id,
      version: (await repo.listSnapshots(ctx.patient!.id)).length + 1,
      createdAt: Date.now(), reason: '技师手工调整快照', scheme: JSON.parse(JSON.stringify(scheme)), thumbnail: thumb,
    };
    await repo.saveSnapshot(snap);
    toast('已保存并留存配色快照', 'good');
  });

  root.querySelector('#refit-btn')!.addEventListener('click', async (e) => {
    if (!chain.hdr || !chain.photo || !chain.curve) { toast('缺少 HDR/照片，无法拟合', 'bad'); return; }
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 拟合中…';
    await new Promise((r) => setTimeout(r, 30));
    try {
      const fitted = autoMatch(createScheme(ctx.patient!), chain.hdr, chain.photo, chain.geom, chain.curve, chain.wb, {
        highlightMask: chain.capture?.highlightMask ?? undefined, validMask: undefined, irisDiameterMm: chain.irisDiameterMm,
      });
      scheme = fitted.scheme;
      scheme.patientId = ctx.patient!.id;
      scheme.fitGain = fitted.gain;
      scheme.fittedFromCaptureId = chain.capture?.id;
      await repo.saveScheme(scheme);
      stage?.update(scheme);
      renderAll();
      toast(`重新拟合完成，照片环带平均 ΔE00 ${fitted.meanDeltaE.toFixed(2)}`, 'good', 5000);
    } finally {
      btn.disabled = false; btn.textContent = '重新一键拟合';
    }
  });

  root.querySelector('#hist-btn')!.addEventListener('click', async () => {
    const snaps = await repo.listSnapshots(ctx.patient!.id);
    const body = h('div', { class: 'grid' });
    if (!snaps.length) body.appendChild(h('div', { class: 'muted' }, '暂无快照'));
    for (const s of snaps) {
      body.appendChild(h('div', { class: 'flex', style: 'gap:12px;padding:8px;border:1px solid var(--line);border-radius:10px' },
        s.thumbnail ? h('img', { src: s.thumbnail, style: 'width:64px;height:64px;border-radius:50%;object-fit:cover' }) : h('div', { style: 'width:64px;height:64px;border-radius:50%;background:#223' }),
        h('div', { style: 'min-width:0' },
          h('div', { style: 'font-weight:600' }, `v${s.version} · ${s.reason}`),
          h('div', { class: 'small muted' }, new Date(s.createdAt).toLocaleString('zh-CN')),
          s.metrics?.[0] ? badge(`ΔE ${s.metrics[0].meanDeltaE.toFixed(2)}`, s.metrics[0].pass ? 'green' : 'red') : null,
        ),
        h('span', { class: 'right' }, h('button', {
          class: 'btn sm primary', onclick: async () => {
            scheme = cloneScheme(s.scheme);
            await repo.saveScheme(scheme);
            stage?.update(scheme); renderAll(); m.close(); toast('已从快照恢复并设为当前方案', 'good');
          },
        }, '从此起步')),
      ));
    }
    const m = modal({ title: '配色快照历史', body, wide: true, footer: [h('button', { class: 'btn', onclick: () => m.close() }, '关闭')] });
  });
}

function rgbToHex(c: [number, number, number]): string {
  const f = (v: number) => Math.round(255 * Math.pow(Math.max(0, Math.min(1, v)), 1 / 2.2)).toString(16).padStart(2, '0');
  return `#${f(c[0])}${f(c[1])}${f(c[2])}`;
}

// 保持 ldrToCanvas 引用（未来导出用），避免 tree-shake 提示无关
void ldrToCanvas;
void idb;
