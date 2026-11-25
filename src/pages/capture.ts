import { h, icon, badge, toast, clear } from '../ui/dom';
import { repo, idb } from '../data/db';
import { processBracket, hdrFromBuffer } from '../data/process';
import { responseCurveSvg } from '../ui/charts';
import { hdrToDisplayCanvas, fileToLdrSquare, ldrToCanvas } from '../browser/canvas';
import { autoMatch } from '../core/matching';
import { createScheme, uid } from '../core/schemeFactory';
import type { AppCtx } from '../main';
import type { CaptureRecord, LdrImage } from '../core/types';

function maskCanvas(mask: Uint8Array, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    if (mask[i]) { img.data[i * 4] = 255; img.data[i * 4 + 1] = 60; img.data[i * 4 + 2] = 40; img.data[i * 4 + 3] = 150; }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export async function renderCapture(root: HTMLElement, ctx: AppCtx) {
  if (!ctx.patient) { root.appendChild(noPatient(ctx)); return; }
  const patient = ctx.patient;
  let capture = await repo.latestCapture(patient.id);

  root.appendChild(h('div', { class: 'flex wrap mb8' },
    h('div', null, h('h2', { style: 'font-size:19px' }, `健侧眼档案 · ${patient.name}`),
      h('div', { class: 'small muted' }, `术眼为${patient.prostheticSide === 'L' ? '左' : '右'}眼，拍摄的是${patient.prostheticSide === 'L' ? '右' : '左'}眼`)),
    h('div', { class: 'right flex' },
      h('label', { class: 'btn primary', style: 'cursor:pointer' },
        icon('upload'), '导入 3–5 张不同曝光',
        h('input', {
          type: 'file', accept: 'image/*', multiple: true, style: 'display:none',
          onchange: async (e: Event) => {
            const files = Array.from((e.target as HTMLInputElement).files ?? []);
            if (files.length < 2) { toast('请至少选择 2 张不同曝光照片（建议 5 张）', 'bad'); return; }
            await importBracket(files);
          },
        }),
      ),
    ),
  ));

  if (!capture) {
    root.appendChild(h('div', { class: 'card empty-state' }, icon('camera', 'big-ico'),
      h('div', null, '该患者还没有拍摄序列'),
      h('div', { class: 'small' }, '点击右上角导入同一机位的 3–5 张不同曝光照片')));
    return;
  }

  await renderWorkspace(capture);

  async function importBracket(files: File[]) {
    toast('正在读取并对齐照片…');
    const n = Math.min(5, files.length);
    const chosen = files.slice(0, n);
    const frames: LdrImage[] = [];
    for (const f of chosen) frames.push(await fileToLdrSquare(f, 320));
    const evs = n === 5 ? [-2, -1, 0, 1, 2] : n === 4 ? [-1.5, -0.5, 0.5, 1.5] : [-1, 0, 1];
    const dts = evs.map((ev) => 8 * 2 ** ev);
    const referenceIndex = evs.indexOf(0) >= 0 ? evs.indexOf(0) : Math.floor(n / 2);
    const geom = { cx: 0.5, cy: 0.515, irisR: 0.335, pupilR: 0.095 };
    const processed = processBracket(frames, dts, geom, referenceIndex);

    const frameMetas = [];
    for (let j = 0; j < frames.length; j++) {
      const blobId = uid('img');
      const blob = await new Promise<Blob>((res) => ldrToCanvas(frames[j]).toBlob((b) => res(b!), 'image/png'));
      await idb.putBlob(blobId, blob);
      frameMetas.push({ ev: evs[j], exposureUs: Math.round(dts[j] * 125), blobId, width: 320, height: 320, shiftX: processed.align.mtbOffset[j].x, shiftY: processed.align.mtbOffset[j].y, mismatch: processed.align.errorAfter });
    }
    const rec: CaptureRecord = {
      id: uid('cap'), patientId: patient.id, createdAt: Date.now(), source: 'upload',
      width: 320, height: 320, frames: frameMetas, referenceEv: 0, geometry: geom,
      curve: processed.curve, wbGains: [1, 1, 1], hdrBuffer: processed.merged.hdr.data.buffer as ArrayBuffer,
      highlightMask: processed.highlightMask, quality: processed.quality,
    };
    await repo.saveCapture(rec);

    if (!processed.quality.allOverexposed) {
      toast('HDR 合成完成，正在拟合初始配色…', '', 5000);
      const tpl = createScheme(patient);
      const fit = autoMatch(tpl, processed.merged.hdr, frames[referenceIndex], geom, processed.curve, [1, 1, 1], {
        highlightMask: processed.highlightMask, validMask: processed.merged.valid, irisDiameterMm: patient.irisDiameterMm,
      });
      fit.scheme.patientId = patient.id;
      fit.scheme.fittedFromCaptureId = rec.id;
      fit.scheme.fitGain = fit.gain;
      await repo.saveScheme(fit.scheme);
      await repo.saveSnapshot({
        id: uid('snap'), patientId: patient.id, schemeId: fit.scheme.id, version: 1,
        createdAt: Date.now(), reason: '导入序列一键拟合', scheme: JSON.parse(JSON.stringify(fit.scheme)),
        metrics: [fitOutcomeMetric(fit)],
      });
    }
    toast('处理完成', 'good');
    ctx.refresh();
  }

  async function renderWorkspace(cap: CaptureRecord) {
    const q = cap.quality;
    const layout = h('div', { class: 'split wide-right mt16' });
    const left = h('div', { class: 'grid' });

    // 舞台卡片
    const stageCard = h('div', { class: 'card' });
    const stageBd = h('div', { class: 'card-bd' });
    const stageWrap = h('div', { class: 'canvas-wrap', style: 'max-width:560px;margin:0 auto' });
    const stageCanvasHost = h('div');
    const overlayBadges = h('div', { class: 'overlay-badges' });
    if (q?.allOverexposed) overlayBadges.appendChild(h('span', { class: 'pill bad' }, '整组过曝 · 无法恢复'));
    else if (q && !q.aligned) overlayBadges.appendChild(h('span', { class: 'pill warn' }, '对齐残差偏高'));
    else overlayBadges.appendChild(h('span', { class: 'pill good' }, '对齐与曝光可用'));
    overlayBadges.appendChild(h('span', { class: 'pill' }, cap.source === 'synthetic' ? '合成测试序列' : '导入照片'));
    stageWrap.append(stageCanvasHost, overlayBadges);

    const viewTabs = h('div', { class: 'flex wrap', style: 'gap:6px;margin:12px 0 4px;justify-content:center' });
    type ViewMode = 'frame' | 'hdr' | 'mask';
    let mode: ViewMode = 'frame';
    let activeFrame = cap.frames.findIndex((f) => f.ev === cap.referenceEv);
    if (activeFrame < 0) activeFrame = 0;

    const drawStage = async () => {
      clear(stageCanvasHost);
      if (mode === 'frame') {
        const f = cap.frames[activeFrame];
        const url = f.blobId ? await idb.getBlobUrl(f.blobId) : null;
        if (url) {
          const img = new Image();
          await new Promise((r) => { img.onload = r; img.src = url; });
          const c = document.createElement('canvas');
          c.width = cap.width; c.height = cap.height;
          c.getContext('2d')!.drawImage(img, 0, 0, cap.width, cap.height);
          c.style.width = '100%'; c.style.borderRadius = '10px';
          stageCanvasHost.appendChild(c);
        }
      } else if (mode === 'hdr') {
        const hdr = hdrFromBuffer(cap.width, cap.height, cap.hdrBuffer);
        if (hdr) {
          const c = hdrToDisplayCanvas(hdr, exposure);
          c.style.width = '100%'; c.style.borderRadius = '10px';
          stageCanvasHost.appendChild(c);
        }
      } else {
        const m = cap.highlightMask ? new Uint8Array(cap.highlightMask) : new Uint8Array(cap.width * cap.height);
        const c = maskCanvas(m, cap.width, cap.height);
        c.style.width = '100%'; c.style.borderRadius = '10px';
        stageCanvasHost.appendChild(c);
      }
    };

    let exposure = 1.0;
    const expSlider = h('input', { type: 'range', min: '0.2', max: '3', step: '0.05', value: '1', style: 'max-width:220px' }) as HTMLInputElement;
    expSlider.oninput = () => { exposure = Number(expSlider.value); if (mode === 'hdr') void drawStage(); };

    const mkTab = (key: ViewMode, label: string) => h('button', {
      class: `btn sm ${mode === key ? 'primary' : ''}`,
      onclick: () => {
        mode = key;
        Array.from(viewTabs.children).forEach((ch, i) => {
          const keys: ViewMode[] = ['frame', 'hdr', 'mask'];
          (ch as HTMLButtonElement).classList.toggle('primary', keys[i] === key);
        });
        expSlider.style.display = key === 'hdr' ? '' : 'none';
        void drawStage();
      },
    }, label);
    viewTabs.append(mkTab('frame', '曝光帧'), mkTab('hdr', 'HDR 合成（线性预览）'), mkTab('mask', '角膜高光剔除区'));
    const expRow = h('div', { class: 'flex', style: 'justify-content:center;gap:10px' }, h('span', { class: 'small muted' }, 'HDR 预览曝光'), expSlider);
    expSlider.style.display = 'none';

    stageBd.append(stageWrap, viewTabs, expRow);
    stageCard.appendChild(stageBd);

    // 胶片条
    const stripCard = h('div', { class: 'card' }, h('div', { class: 'card-hd' }, h('h3', null, '多曝光序列'), h('span', { class: 'hint' }, '点击切换；角标为 EV')));
    const stripBd = h('div', { class: 'card-bd tight' });
    const strip = h('div', { class: 'filmstrip' });
    for (let i = 0; i < cap.frames.length; i++) {
      const f = cap.frames[i];
      const url = f.blobId ? await idb.getBlobUrl(f.blobId) : null;
      const thumb = h('div', { class: `frame-thumb ${i === activeFrame && mode === 'frame' ? 'active' : ''}` },
        url ? h('img', { src: url, alt: `EV${f.ev}` }) : null,
        h('div', { class: 'cap' }, h('span', null, `EV ${f.ev > 0 ? '+' : ''}${f.ev}`), f.shiftX || f.shiftY ? h('span', null, `↔${f.shiftX},${f.shiftY}`) : null),
      );
      thumb.onclick = () => {
        activeFrame = i; mode = 'frame';
        strip.querySelectorAll('.frame-thumb').forEach((e) => e.classList.remove('active'));
        thumb.classList.add('active');
        void drawStage();
      };
      strip.appendChild(thumb);
    }
    stripBd.appendChild(strip);
    stripCard.appendChild(stripBd);
    left.append(stageCard, stripCard);

    // 右侧：曲线 + 质量 + 操作
    const right = h('div', { class: 'grid' });
    const curveCard = h('div', { class: 'card' },
      h('div', { class: 'card-hd' }, h('h3', null, '相机响应曲线'), badge('Debevec–Malik', 'teal')),
      h('div', { class: 'card-bd tight' }, cap.curve ? responseCurveSvg(cap.curve.g) : h('div', { class: 'muted' }, '无曲线')),
    );

    const qCard = h('div', { class: 'card' }, h('div', { class: 'card-hd' }, h('h3', null, '对齐与质量')));
    const qb = h('div', { class: 'card-bd' });
    if (q) {
      qb.appendChild(h('div', { class: 'metric-line' }, h('span', { class: 'name' }, 'MTB 失配率'),
        h('div', { class: 'track' }, h('i', { class: 'fill', style: `width:${Math.min(100, q.mtbErrorAfter * 100 * 3)}%;background:var(--teal)` })),
        h('span', { class: 'num' }, `${(q.mtbErrorAfter * 100).toFixed(1)}%`)));
      qb.appendChild(h('div', { class: 'small muted mb8' }, `对齐前 ${(q.mtbErrorBefore * 100).toFixed(1)}% → 对齐后 ${(q.mtbErrorAfter * 100).toFixed(1)}% · 可用帧 ${q.usableFrames}/${cap.frames.length}`));
      qb.appendChild(h('div', { class: 'metric-line' }, h('span', { class: 'name' }, '虹膜饱和率'),
        h('div', { class: 'track' }, h('i', { class: 'fill', style: `width:${Math.min(100, q.clippedFraction * 100)}%;background:${q.clippedFraction > 0.8 ? 'var(--red)' : 'var(--amber)'}` })),
        h('span', { class: 'num' }, `${(q.clippedFraction * 100).toFixed(1)}%`)));
      qb.appendChild(h('p', { class: `small ${q.allOverexposed ? '' : 'muted'} mt8`, style: q.allOverexposed ? 'color:var(--red);font-weight:600' : '' }, q.message));
    }
    qCard.appendChild(qb);

    const actCard = h('div', { class: 'card' }, h('div', { class: 'card-bd grid', style: 'gap:9px' },
      h('button', { class: 'btn primary', onclick: () => ctx.navigate(`#/iris/${patient.id}`) }, icon('brush'), '前往虹膜绘制'),
      h('button', { class: 'btn', onclick: () => ctx.navigate(`#/compare/${patient.id}`) }, icon('compare'), '前往成像比对'),
    ));

    right.append(curveCard, qCard, actCard);
    layout.append(left, right);
    root.appendChild(layout);
    void drawStage();
  }
}

function fitOutcomeMetric(fit: { meanDeltaE: number; bandDeltaE: number[] }) {
  return {
    sceneId: 'clinic', sceneName: '诊室灯（健侧照片）', meanDeltaE: fit.meanDeltaE,
    maxBandDeltaE: Math.max(...fit.bandDeltaE), bandDeltaE: fit.bandDeltaE,
    failingBands: fit.bandDeltaE.map((d, i) => (d > 3 ? i : -1)).filter((i) => i >= 0),
    layerAdvice: [], pass: fit.meanDeltaE < 3,
  };
}

function noPatient(ctx: AppCtx) {
  return h('div', { class: 'card empty-state' }, h('div', null, '请先选择或新建一位患者'),
    h('button', { class: 'btn primary mt16', onclick: () => ctx.navigate('#/patients') }, '前往患者档案'));
}
