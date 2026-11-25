/** 应用外壳：导航 + 页面挂载 + 全局状态联动 */
import './styles.css';
import { initRouter, navigate, PAGE_META, subscribe, getState, setState } from './state';
import { renderPatientsPage } from './pages/patients';
import { renderCapturePage } from './pages/capture';
import { renderPaintPage } from './pages/paint';
import { renderComparePage } from './pages/compare';
import { renderDeliveryPage } from './pages/delivery';
import { renderSettingsPage } from './pages/settings';
import { db } from '../db/idb';
import { getRenderBackend } from '../render/backend';
import type { PageId } from './state';

const RENDERERS: Record<PageId, () => Promise<HTMLElement>> = {
  patients: renderPatientsPage,
  capture: renderCapturePage,
  paint: renderPaintPage,
  compare: renderComparePage,
  delivery: renderDeliveryPage,
  settings: renderSettingsPage,
};

async function mount(): Promise<void> {
  const main = document.querySelector('main')!;
  const state = getState();
  main.innerHTML = '<div class="muted">加载中…</div>';
  try {
    const page = await RENDERERS[state.page]();
    main.innerHTML = '';
    main.appendChild(page);
  } catch (err) {
    main.innerHTML = `<div class="card"><h3>页面出错</h3><pre class="muted">${(err as Error).message}\n${(err as Error).stack ?? ''}</pre></div>`;
    console.error(err);
  }
}

function renderNav(): void {
  const nav = document.querySelector('nav.nav')!;
  const state = getState();
  const patient = state.patients.find((p) => p.id === state.currentPatientId);
  nav.innerHTML =
    PAGE_META.map(
      (m) =>
        `<button data-page="${m.id}" class="${state.page === m.id ? 'active' : ''}">
          <span class="nav-icon">${m.icon}</span><span>${m.label}</span></button>`,
    ).join('') +
    `<div class="nav-context">${patient ? `当前患者：<b>${patient.name}</b><br>患侧 ${patient.affectedSide === 'left' ? '左' : '右'}眼` : '未选择患者'}<br><span id="backend-label" class="mono"></span></div>`;
  nav.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
    b.onclick = () => navigate(b.dataset.page as PageId);
  });
}

async function boot(): Promise<void> {
  initRouter();
  // 载入患者列表到全局状态
  setState({ patients: await db.patients.list() });
  // 预热渲染后端并显示类型
  getRenderBackend(true).then((b) => {
    const label = document.querySelector('#backend-label');
    if (label) label.textContent = `后端:${b.kind}`;
  });
  subscribe(() => {
    renderNav();
    mount();
  });
  renderNav();
  mount();
}

boot();
