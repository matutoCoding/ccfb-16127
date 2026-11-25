import { h, icon, toast, confirmDialog } from '../ui/dom';
import { repo } from '../data/db';
import { runSelfCheck, type SelfCheckReport } from '../core/selfcheck';
import { EyeGpuRenderer } from '../webgpu/eyeGpu';
import type { AppCtx } from '../main';

export async function renderSettings(root: HTMLElement, ctx: AppCtx) {
  const s = ctx.settings;

  root.appendChild(h('div', { class: 'settings-grid' },
    generalCard(),
    selfCheckCard(),
  ));
  root.appendChild(dataCard());

  function generalCard(): HTMLElement {
    const card = h('div', { class: 'card' }, h('div', { class: 'card-hd' }, h('h3', null, '工作室与判据')));
    const bd = h('div', { class: 'card-bd' });
    const studio = h('input', { class: 'input', value: s.studioName }) as HTMLInputElement;
    const operator = h('input', { class: 'input', value: s.operator }) as HTMLInputElement;
    const deTh = h('input', { class: 'input', type: 'number', step: '0.1', value: String(s.deltaEThreshold) }) as HTMLInputElement;
    const hdrTh = h('input', { class: 'input', type: 'number', step: '0.5', value: String(s.hdrErrorThreshold) }) as HTMLInputElement;
    const backend = h('select', { class: 'input' },
      h('option', { value: 'auto' }, '自动（优先 WebGPU）'),
      h('option', { value: 'webgpu' }, '强制 WebGPU'),
      h('option', { value: 'cpu' }, '仅 CPU 参考渲染'),
    ) as HTMLSelectElement;
    backend.value = s.renderBackend;
    bd.append(
      h('div', { class: 'field' }, h('label', null, '工作室名称'), studio),
      h('div', { class: 'field' }, h('label', null, '技师'), operator),
      h('div', { class: 'field-row' },
        h('div', { class: 'field' }, h('label', null, 'ΔE00 超标阈值'), deTh),
        h('div', { class: 'field' }, h('label', null, 'HDR 误差阈值 %'), hdrTh)),
      h('div', { class: 'field' }, h('label', null, '渲染后端'), backend),
      h('div', { class: 'small muted' }, `WebGPU：${EyeGpuRenderer.isSupported() ? '浏览器报告可用，实际以设备初始化为准备' : '当前环境不可用，将使用 CPU 线性 HDR 链路'}`),
      h('button', {
        class: 'btn primary mt16', onclick: async () => {
          s.studioName = studio.value; s.operator = operator.value;
          s.deltaEThreshold = Number(deTh.value) || 3;
          s.hdrErrorThreshold = Number(hdrTh.value) || 5;
          s.renderBackend = backend.value as AppCtx['settings']['renderBackend'];
          await repo.saveSettings(s);
          await ctx.reloadSettings();
          toast('设置已保存', 'good');
        },
      }, '保存设置'),
    );
    card.appendChild(bd);
    return card;
  }

  function selfCheckCard(): HTMLElement {
    const card = h('div', { class: 'card' },
      h('div', { class: 'card-hd' }, h('h3', null, '数值验收自检'), badge2()),
      h('div', { class: 'card-bd' },
        h('p', { class: 'small muted' }, '在浏览器内复算：合成 4 种虹膜颜色 + 手抖组 + 全过曝组，走完整条 HDR/响应曲线/ΔE00 链路（约 10–20 秒）。命令行可运行 npm run verify。'),
        h('button', { class: 'btn primary', id: 'run-check' }, icon('check'), '运行端到端自检'),
        h('div', { id: 'check-progress', class: 'mt16' }),
        h('div', { id: 'check-report', class: 'mt16' }),
      ),
    );
    setTimeout(() => {
      card.querySelector('#run-check')!.addEventListener('click', async (e) => {
        const btn = e.currentTarget as HTMLButtonElement;
        const prog = card.querySelector('#check-progress') as HTMLElement;
        const rep = card.querySelector('#check-report') as HTMLElement;
        btn.disabled = true;
        rep.replaceChildren();
        const bar = h('div', { class: 'loading-bar', style: 'position:static;height:9px' }, h('i', { style: 'width:0%' }));
        const msg = h('div', { class: 'small muted mt8' }, '准备中…');
        prog.replaceChildren(bar, msg);
        const report: SelfCheckReport = await runSelfCheck({
          size: 288,
          onProgress: (m, p) => { bar.querySelector('i')!.setAttribute('style', `width:${p}%`); msg.textContent = m; },
        });
        btn.disabled = false;
        prog.replaceChildren();
        rep.appendChild(renderReport(report));
      });
    }, 0);
    return card;
  }

  function dataCard(): HTMLElement {
    const card = h('div', { class: 'card mt16' }, h('div', { class: 'card-hd' }, h('h3', null, '数据管理')));
    const bd = h('div', { class: 'card-bd flex wrap' },
      h('button', {
        class: 'btn', onclick: async () => {
          if (await confirmDialog('将清空 IndexedDB 并重新生成 6 位合成患者，确认？')) {
            await repo.wipeAll();
            location.reload();
          }
        },
      }, icon('refresh'), '重新生成演示数据'),
      h('button', {
        class: 'btn danger', onclick: async () => {
          if (await confirmDialog('确认清空本机全部患者、照片、方案与交付单？')) {
            await repo.wipeAll();
            toast('已清空，即将刷新', 'good');
            setTimeout(() => location.reload(), 800);
          }
        },
      }, icon('trash'), '清空全部数据'),
      h('span', { class: 'small muted right' }, '所有照片与配色仅存储在本机浏览器 IndexedDB，不上传任何服务器'),
    );
    card.appendChild(bd);
    return card;
  }
}

function badge2(): HTMLElement {
  return h('span', { class: 'badge teal' }, 'HDR <5% · ΔE00 <3');
}

function renderReport(r: SelfCheckReport): HTMLElement {
  const wrap = h('div');
  wrap.appendChild(h('div', { class: 'grid cols-3 mb8' },
    kpi('总体 HDR 误差', `${r.overallHdrRelErrorPct.toFixed(2)}%`, r.overallHdrRelErrorPct < r.hdrThresholdPct ? 'good' : 'bad', `阈值 < ${r.hdrThresholdPct}%`),
    kpi('总体平均 ΔE00', r.overallMeanDeltaE.toFixed(2), r.overallMeanDeltaE < r.deThreshold ? 'good' : 'bad', `阈值 < ${r.deThreshold}`),
    kpi('全过曝拦截', r.blownCorrectlyRejected ? '正确拦截' : '未拦截', r.blownCorrectlyRejected ? 'good' : 'bad', ''),
  ));
  const t = h('table', { class: 'data' });
  t.innerHTML = '<thead><tr><th>眼睛</th><th>类型</th><th>HDR 误差%</th><th>平均ΔE</th><th>最大ΔE</th><th>对齐后失配</th></tr></thead>';
  const tb = h('tbody');
  for (const e of r.eyes) {
    tb.appendChild(h('tr', null,
      h('td', null, e.archetype),
      h('td', null, e.kind),
      h('td', { class: 'mono', style: `color:${e.hdrRelErrorPct < 5 ? 'var(--green)' : 'var(--red)'};font-weight:700` }, e.hdrRelErrorPct.toFixed(2)),
      h('td', { class: 'mono', style: `color:${e.meanDeltaE < 3 ? 'var(--green)' : 'var(--red)'};font-weight:700` }, e.meanDeltaE.toFixed(2)),
      h('td', { class: 'mono' }, e.maxBandDeltaE.toFixed(2)),
      h('td', { class: 'mono' }, `${(e.alignAfter * 100).toFixed(1)}%`),
    ));
  }
  t.appendChild(tb);
  wrap.appendChild(t);
  if (r.failures.length) wrap.appendChild(h('div', { class: 'advice-card bad mt16' }, h('b', null, '未通过项'), ...r.failures.map((f) => h('div', null, `· ${f}`))));
  else wrap.appendChild(h('div', { class: 'advice-card mt16', style: 'background:var(--green-soft)' }, h('b', { style: 'color:var(--green)' }, '✅ 全部验收通过'), 'HDR 辐照度相对误差 <5%，虹膜环带平均 ΔE00 <3。'));
  return wrap;
}

function kpi(label: string, value: string, kind: 'good' | 'warn' | 'bad', sub: string): HTMLElement {
  return h('div', { class: `card kpi ${kind}` }, h('div', { class: 'label' }, label), h('div', { class: 'value', style: 'font-size:21px' }, value), h('div', { class: 'sub' }, sub));
}
