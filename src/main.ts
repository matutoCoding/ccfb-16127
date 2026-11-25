import './styles.css';
import { h, icon, clear } from './ui/dom';
import { repo } from './data/db';
import { seedIfNeeded } from './data/seed';
import type { AppSettings, Patient } from './core/types';
import { renderPatients } from './pages/patients';
import { renderCapture } from './pages/capture';
import { renderIris } from './pages/iris';
import { renderCompare } from './pages/compare';
import { renderDelivery } from './pages/delivery';
import { renderSettings } from './pages/settings';

export interface AppCtx {
  patientId: string | null;
  patient: Patient | null;
  settings: AppSettings;
  navigate: (hash: string) => void;
  setPatient: (id: string) => void;
  reloadSettings: () => Promise<void>;
  refresh: () => void;
}

const NAV = [
  { hash: '#/patients', key: 'patients', label: '患者档案', icon: 'patients', step: '1' },
  { hash: '#/capture', key: 'capture', label: '健侧眼拍摄', icon: 'camera', step: '2' },
  { hash: '#/iris', key: 'iris', label: '虹膜绘制', icon: 'brush', step: '3' },
  { hash: '#/compare', key: 'compare', label: '成像比对', icon: 'compare', step: '4' },
  { hash: '#/delivery', key: 'delivery', label: '交付确认', icon: 'deliver', step: '5' },
  { hash: '#/settings', key: 'settings', label: '设置与自检', icon: 'settings', step: '' },
];

function currentPatientId(): string | null {
  return localStorage.getItem('ecs_current_patient');
}

function showLoading(): { set: (msg: string, pct: number) => void; el: HTMLElement } {
  const el = h('div', { class: 'loading-screen' },
    h('div', { class: 'loading-eye' }),
    h('div', { class: 'loading-bar' }, h('i', { style: 'width:0%' })),
    h('div', { class: 'loading-msg' }, '正在初始化…'),
  );
  document.body.appendChild(el);
  const bar = el.querySelector('i')!;
  const msg = el.querySelector('.loading-msg')!;
  return {
    el,
    set: (m, p) => { bar.style.width = `${p}%`; msg.textContent = m; },
  };
}

async function bootstrap() {
  const loader = showLoading();
  try {
    await seedIfNeeded((m, p) => loader.set(m, p));
  } catch (err) {
    console.error(err);
    loader.set(`初始化失败：${(err as Error).message}`, 100);
  }
  loader.el.remove();

  let settings = await repo.getSettings();
  let patients = await repo.listPatients();
  let pid = currentPatientId();
  if ((!pid || !patients.some((p) => p.id === pid)) && patients[0]) {
    pid = patients[0].id;
    localStorage.setItem('ecs_current_patient', pid);
  }

  const sidebar = document.getElementById('sidebar')!;
  const topbar = document.getElementById('topbar')!;
  const view = document.getElementById('view')!;

  const navigate = (hash: string) => { window.location.hash = hash; };
  const setPatient = (id: string) => {
    pid = id;
    localStorage.setItem('ecs_current_patient', id);
    const base = parseRoute().base;
    if (['capture', 'iris', 'compare', 'delivery'].includes(base)) {
      window.location.hash = `#/${base}/${id}`;
    } else {
      render();
    }
  };
  const reloadSettings = async () => { settings = await repo.getSettings(); renderShell(); };

  function parseRoute(): { base: string; param?: string } {
    const raw = window.location.hash.replace(/^#\/?/, '');
    const [base, param] = raw.split('/');
    return { base: base || 'patients', param };
  }

  function renderShell() {
    const route = parseRoute();
    const activeKey = ['capture', 'iris', 'compare', 'delivery'].includes(route.base) ? route.base : route.base === 'settings' ? 'settings' : 'patients';
    clear(sidebar);
    sidebar.appendChild(h('div', { class: 'brand' },
      h('div', { class: 'brand-mark' }),
      h('div', null,
        h('div', { class: 'brand-name' }, '瞳色工坊'),
        h('div', { class: 'brand-sub' }, 'PROSTHETIC EYE HDR'),
      ),
    ));
    const nav = h('nav', { class: 'nav' });
    for (const n of NAV) {
      const target = ['capture', 'iris', 'compare', 'delivery'].includes(n.key) && pid ? `#/${n.key}/${pid}` : n.hash;
      const item = h('button', {
        class: `nav-item ${activeKey === n.key ? 'active' : ''}`,
        onclick: () => navigate(target),
      }, icon(n.icon), h('span', null, n.label), ...(n.step ? [h('span', { class: 'step-no' }, n.step)] : []));
      nav.appendChild(item);
    }
    sidebar.appendChild(nav);
    sidebar.appendChild(h('div', { class: 'sidebar-foot' },
      h('div', null, '数据仅存于本机 IndexedDB'),
      h('div', null, '线性 HDR · CIEDE2000'),
      h('span', { class: 'gpu-badge' }, h('i', { class: `gpu-dot ${'gpu' in navigator ? '' : 'off'}` }), 'gpu' in navigator ? 'WebGPU 可用' : 'WebGPU 不可用 · CPU 模式'),
    ));

    // topbar
    clear(topbar);
    const current = patients.find((p) => p.id === pid) ?? null;
    const titleMap: Record<string, [string, string]> = {
      patients: ['患者档案', '眼窝情况 · 义眼台 · 片子规格 · 配色快照'],
      capture: ['健侧眼拍摄', '多曝光对齐 · HDR 合成 · 响应曲线反演 · 高光剔除'],
      iris: ['虹膜绘制', '底色 / 放射纹 / 卷缩轮 / 色素斑 · 真实颜料色号分层'],
      compare: ['成像比对', '同一响应曲线与白平衡 · 四场景 · 环带 ΔE00 诊断'],
      delivery: ['交付确认', '配色单 · 四场景色差表 · 患者签字存档'],
      settings: ['设置与数值自检', '验收指标复算 · 渲染后端 · 数据管理'],
    };
    const [title, sub] = titleMap[activeKey] ?? titleMap.patients;
    topbar.appendChild(h('div', null, h('h1', null, title), h('div', { class: 'crumb-sub' }, sub)));

    const sw = h('div', { class: 'patient-switch' });
    if (activeKey !== 'patients' && activeKey !== 'settings') {
      const select = h('select', { class: 'input', style: 'width:auto;min-width:190px', onchange: (e: Event) => setPatient((e.target as HTMLSelectElement).value) }) as HTMLSelectElement;
      if (!patients.length) select.appendChild(h('option', { value: '' }, '暂无患者'));
      for (const p of patients) {
        const o = h('option', { value: p.id }, `${p.code} · ${p.name}（${p.prostheticSide === 'L' ? '左眼' : '右眼'}术眼）`) as HTMLOptionElement;
        if (p.id === pid) o.selected = true;
        select.appendChild(o);
      }
      sw.appendChild(select);
      if (current) sw.appendChild(h('div', { class: `avatar ${current.prostheticSide}`, title: `术眼：${current.prostheticSide === 'L' ? '左' : '右'} · 健侧：${current.prostheticSide === 'L' ? '右' : '左'}` }, current.name.slice(0, 1)));
    }
    topbar.appendChild(sw);
  }

  async function render() {
    renderShell();
    const route = parseRoute();
    patients = await repo.listPatients();
    // 患者作用域路由优先使用 URL 中的 id，并同步到 localStorage
    if (['capture', 'iris', 'compare', 'delivery'].includes(route.base) && route.param) {
      if (patients.some((p) => p.id === route.param)) {
        pid = route.param;
        localStorage.setItem('ecs_current_patient', pid);
      }
    }
    if ((!pid || !patients.some((p) => p.id === pid)) && patients[0]) {
      pid = patients[0].id;
      localStorage.setItem('ecs_current_patient', pid);
    }
    const current = patients.find((p) => p.id === pid) ?? null;
    const ctx: AppCtx = {
      patientId: pid, patient: current, settings, navigate, setPatient, reloadSettings,
      refresh: () => { void render(); },
    };
    clear(view);
    try {
      if (route.base === 'patients') await renderPatients(view, ctx);
      else if (route.base === 'capture') await renderCapture(view, ctx);
      else if (route.base === 'iris') await renderIris(view, ctx);
      else if (route.base === 'compare') await renderCompare(view, ctx);
      else if (route.base === 'delivery') await renderDelivery(view, ctx);
      else if (route.base === 'settings') await renderSettings(view, ctx);
      else await renderPatients(view, ctx);
    } catch (err) {
      console.error(err);
      clear(view);
      view.appendChild(h('div', { class: 'card' }, h('div', { class: 'card-bd' },
        h('h3', { style: 'color:var(--red)' }, '页面渲染出错'),
        h('pre', { class: 'small muted', style: 'white-space:pre-wrap' }, String((err as Error)?.stack ?? err)),
      )));
    }
    renderShell();
  }

  let renderChain: Promise<void> = Promise.resolve();
  function scheduleRender() {
    renderChain = renderChain.then(() => render()).catch((err) => console.error('render failed', err));
  }
  window.addEventListener('hashchange', scheduleRender);
  if (!window.location.hash) window.history.replaceState(null, '', '#/patients');
  scheduleRender();
}

void bootstrap();
