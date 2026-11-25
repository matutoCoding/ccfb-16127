/** 全局应用状态与极简路由（无第三方框架，哈希路由 + 发布订阅） */
import type { Patient } from '../core/types';

export type PageId = 'patients' | 'capture' | 'paint' | 'compare' | 'delivery' | 'settings';

export const PAGE_META: Array<{ id: PageId; label: string; icon: string }> = [
  { id: 'patients', label: '患者档案', icon: '👤' },
  { id: 'capture', label: '健侧眼拍摄', icon: '📷' },
  { id: 'paint', label: '虹膜绘制', icon: '🎨' },
  { id: 'compare', label: '成像比对', icon: '🔍' },
  { id: 'delivery', label: '交付确认', icon: '✅' },
  { id: 'settings', label: '设置', icon: '⚙️' },
];

interface AppState {
  page: PageId;
  currentPatientId: string | null;
  currentCaptureId: string | null;
  currentSchemeId: string | null;
  currentReportId: string | null;
  patients: Patient[];
  backendKind: 'webgpu' | 'cpu' | 'pending';
}

const listeners = new Set<() => void>();
const state: AppState = {
  page: 'patients',
  currentPatientId: null,
  currentCaptureId: null,
  currentSchemeId: null,
  currentReportId: null,
  patients: [],
  backendKind: 'pending',
};

export function getState(): Readonly<AppState> {
  return state;
}

export function setState(patch: Partial<AppState>): void {
  // 跳过无实际变化的更新，避免「挂载 → setState → 再挂载」的渲染循环。
  // patients 是每次从 IDB 读出的新数组，按 id+updatedAt 内容比较。
  let changed = false;
  for (const k of Object.keys(patch) as (keyof AppState)[]) {
    const nv = patch[k];
    if (k === 'patients') {
      const old = state[k] as Patient[];
      const next = nv as Patient[];
      if (old.length !== next.length || old.some((p, i) => p.id !== next[i].id || p.updatedAt !== next[i].updatedAt)) {
        changed = true;
        break;
      }
    } else if (state[k] !== nv) {
      changed = true;
      break;
    }
  }
  if (!changed) return;
  Object.assign(state, patch);
  listeners.forEach((l) => l());
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function navigate(page: PageId): void {
  state.page = page;
  location.hash = page;
  listeners.forEach((l) => l());
}

export function initRouter(): void {
  const apply = () => {
    const h = location.hash.replace('#', '') as PageId;
    if (PAGE_META.some((m) => m.id === h)) state.page = h;
    listeners.forEach((l) => l());
  };
  window.addEventListener('hashchange', apply);
  if (!location.hash) location.hash = state.page;
  apply();
}

export function currentPatient(): Patient | undefined {
  return state.patients.find((p) => p.id === state.currentPatientId);
}
