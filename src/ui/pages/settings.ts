/** 设置页：技师/工作室信息、ΔE 阈值、HDR 平滑权重、渲染尺寸、WebGPU 偏好与后端状态 */
import { db } from '../../db/idb';
import { detectWebGpu, resetRenderBackend, getRenderBackend } from '../../render/backend';
import type { AppSettings } from '../../core/types';

export async function renderSettingsPage(): Promise<HTMLElement> {
  const el = document.createElement('div');
  const settings = await db.settings();
  const webgpuAvailable = await detectWebGpu();

  el.innerHTML = `
    <h2 class="page-title">设置</h2>
    <p class="page-desc">全局参数保存在本地 IndexedDB。HDR 与色差的数值管线在 WebGPU 不可用时自动回退到 CPU 参考渲染器，结果一致。</p>
    <div class="card" style="max-width:640px">
      <div class="grid grid-2">
        <label class="field">工作室名称<input id="s-studio" value="${settings.studioName}"></label>
        <label class="field">技师姓名<input id="s-tech" value="${settings.technicianName}"></label>
        <label class="field">环带色差阈值 ΔE00<input id="s-de" type="number" step="0.1" min="1" max="10" value="${settings.deltaEThreshold}"></label>
        <label class="field">HDR 响应曲线平滑权重 λ<input id="s-lambda" type="number" step="1" min="1" max="50" value="${settings.responseLambda}"></label>
        <label class="field">渲染分辨率 (px)<input id="s-size" type="number" step="32" min="96" max="512" value="${settings.renderSize}"></label>
        <label class="field">渲染后端偏好<select id="s-gpu">
          <option value="1" ${settings.preferWebGpu ? 'selected' : ''}>优先 WebGPU（自动回退 CPU）</option>
          <option value="0" ${!settings.preferWebGpu ? 'selected' : ''}>强制 CPU 参考渲染器</option></select></label>
      </div>
      <div class="btn-row" style="margin-top:16px">
        <button class="btn" id="s-save">保存设置</button>
        <button class="btn secondary" id="s-check">检测当前后端</button>
      </div>
      <div id="s-msg" class="muted" style="margin-top:12px"></div>
      <div class="muted" style="margin-top:16px;font-size:12px;line-height:1.7">
        WebGPU 浏览器支持：${webgpuAvailable ? '<span class="badge good">可用</span>' : '<span class="badge warn">不可用，将用 CPU</span>'}<br>
        验收指标：HDR 辐照重建相对误差 &lt; 5%；虹膜环带平均 ΔE00 &lt; 3（测试见 <span class="mono">test/</span>）。
      </div>
    </div>`;

  el.querySelector<HTMLButtonElement>('#s-save')!.onclick = async () => {
    const next: AppSettings = {
      ...settings,
      studioName: el.querySelector<HTMLInputElement>('#s-studio')!.value,
      technicianName: el.querySelector<HTMLInputElement>('#s-tech')!.value,
      deltaEThreshold: Number(el.querySelector<HTMLInputElement>('#s-de')!.value),
      responseLambda: Number(el.querySelector<HTMLInputElement>('#s-lambda')!.value),
      renderSize: Number(el.querySelector<HTMLInputElement>('#s-size')!.value),
      preferWebGpu: el.querySelector<HTMLSelectElement>('#s-gpu')!.value === '1',
    };
    await db.saveSettings(next);
    resetRenderBackend();
    el.querySelector<HTMLDivElement>('#s-msg')!.innerHTML = '<span class="badge good">已保存</span>';
  };

  el.querySelector<HTMLButtonElement>('#s-check')!.onclick = async () => {
    const backend = await getRenderBackend(settings.preferWebGpu);
    el.querySelector<HTMLDivElement>('#s-msg')!.textContent =
      `当前渲染后端：${backend.kind === 'webgpu' ? 'WebGPU（GPU 着色器）' : 'CPU 参考渲染器'}`;
  };

  return el;
}
