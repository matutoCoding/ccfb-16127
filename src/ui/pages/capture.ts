/** 健侧眼拍摄页：导入 3~5 张同机位不同曝光照片 → 对齐 → HDR 合成 → 响应曲线展示 */
import { db, uid } from '../../db/idb';
import { getState, navigate, setState } from '../state';
import { buildHdr, AllOverexposedError, downscaleLdr } from '../../hdr/pipeline';
import { drawHdr, drawResponseCurve, drawLdr } from '../canvas';
import type { LdrImage } from '../../core/types';
import { generateDemoDataset } from '../../synth/dataset';
import { LIGHTING_SCENES } from '../../render/scenes';

export async function renderCapturePage(): Promise<HTMLElement> {
  const el = document.createElement('div');
  const s = getState();
  if (!s.currentPatientId) {
    el.innerHTML = '<h2 class="page-title">健侧眼拍摄</h2><div class="card">请先在「患者档案」选择一位患者。</div>';
    return el;
  }
  const patient = s.patients.find((p) => p.id === s.currentPatientId)!;
  const priorCaptures = await db.captures.listFor(patient.id);

  el.innerHTML = `
    <h2 class="page-title">健侧眼拍摄 — ${patient.name}</h2>
    <p class="page-desc">导入同一机位 3~5 张不同曝光的照片（EV 间隔约 1 档）。系统自动亚像素对齐、合成线性 HDR，并反推相机响应曲线；角膜反光高光会被单独掩膜，不参与取色。</p>
    <div class="card">
      <div class="btn-row">
        <label class="btn" style="cursor:pointer">选择多曝光照片<input id="file-input" type="file" accept="image/*" multiple hidden></label>
        <button class="btn secondary" id="demo-btn">载入合成演示序列（5 色眼）</button>
        <button class="btn secondary" id="demo-anomaly">载入异常演示（手抖 / 全过曝）</button>
      </div>
      <div id="status" class="muted" style="margin-top:12px"></div>
      <div id="warnings"></div>
    </div>
    <div class="grid grid-2">
      <div class="card"><h3>HDR 合成结果（线性浮点，可调显示曝光）</h3>
        <div class="canvas-wrap"><canvas id="hdr-canvas"></canvas></div>
        <label class="field" style="margin-top:10px">显示曝光增益（仅影响查看，不改变 HDR 数据）<input type="range" id="gain" min="0.25" max="4" step="0.05" value="1"></label>
      </div>
      <div class="card"><h3>恢复的相机响应曲线 g(z)</h3>
        <div class="canvas-wrap"><canvas id="curve-canvas" width="320" height="220"></canvas></div>
        <div id="quality" class="muted" style="margin-top:8px"></div>
      </div>
    </div>
    <div class="card"><h3>输入帧（缩略图）</h3><div id="thumbs" class="thumb-row"></div></div>
    <div class="card"><h3>历史拍摄记录</h3>
      <table><thead><tr><th>时间</th><th>眼别</th><th>曝光数</th><th>有效像素</th><th>操作</th></tr></thead><tbody>
        ${priorCaptures
          .map(
            (c) => `<tr><td>${new Date(c.createdAt).toLocaleString('zh-CN')}</td><td>${c.eye === 'left' ? '左' : '右'}眼</td><td>${c.exposures.length}</td><td>${(c.quality.validPixelRatio * 100).toFixed(1)}%</td>
            <td><button class="btn secondary" data-use="${c.id}">用于绘制</button></td></tr>`,
          )
          .join('') || '<tr><td colspan="5" class="muted">暂无记录</td></tr>'}
      </tbody></table>
    </div>`;

  const statusEl = el.querySelector<HTMLDivElement>('#status')!;
  const warnEl = el.querySelector<HTMLDivElement>('#warnings')!;
  let lastHdr: import('../../core/types').FloatImage | null = null;
  let lastCaptureId: string | null = null;

  const fileInput = el.querySelector<HTMLInputElement>('#file-input')!;
  fileInput.onchange = async () => {
    const files = Array.from(fileInput.files ?? []).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (files.length < 2) {
      statusEl.textContent = '至少需要 2 张不同曝光的照片。';
      return;
    }
    try {
      statusEl.textContent = `读取 ${files.length} 张照片…`;
      const frames: LdrImage[] = [];
      for (let i = 0; i < files.length; i++) {
        frames.push(await loadImageFile(files[i], i - Math.floor(files.length / 2)));
      }
      await runBuild(frames);
    } catch (err) {
      reportError(err);
    }
  };

  el.querySelector<HTMLButtonElement>('#demo-btn')!.onclick = async () => {
    const ds = generateDemoDataset(160);
    await runBuild(ds.normal[0].frames);
  };
  el.querySelector<HTMLButtonElement>('#demo-anomaly')!.onclick = async () => {
    const ds = generateDemoDataset(160);
    warnEl.innerHTML = '';
    // 手抖组
    try {
      await runBuild(ds.handshake.frames, true);
    } catch (e) {
      reportError(e);
    }
    // 全过曝组单独演示
    setTimeout(async () => {
      try {
        buildHdr(ds.allOverexposed.frames, { id: 'x', patientId: patient.id, eye: patient.healthySide });
      } catch (err) {
        appendWarn((err as Error).message, 'bad');
      }
    }, 100);
  };

  async function runBuild(frames: LdrImage[], isHandshake = false): Promise<void> {
    try {
      statusEl.textContent = '对齐与 HDR 合成中…';
      await new Promise((r) => setTimeout(r, 30));
      const { capture, warnings } = buildHdr(frames, {
        id: uid('cap'),
        patientId: patient.id,
        eye: patient.healthySide,
        lambda: 8,
      });
      await db.captures.save(capture);
      lastHdr = capture.hdr;
      lastCaptureId = capture.id;
      statusEl.innerHTML = `合成完成 ✅ 有效像素 ${(capture.quality.validPixelRatio * 100).toFixed(1)}%，曲线拟合 RMS ${capture.quality.fitRms.map((v) => v.toFixed(3)).join(' / ')}`;
      warnEl.innerHTML = '';
      // buildHdr 的 warnings 与 capture.quality.warnings 同源，去重后展示
      const allWarnings = [...new Set([...warnings, ...capture.quality.warnings])];
      for (const w of allWarnings) appendWarn(w, w.includes('过曝') ? 'bad' : 'warn');
      if (isHandshake) appendWarn('（演示）该序列注入了手抖偏移，应出现对齐置信度警告', 'info');

      const canvas = el.querySelector<HTMLCanvasElement>('#hdr-canvas')!;
      const draw = () => drawHdr(canvas, capture.hdr, Number(el.querySelector<HTMLInputElement>('#gain')!.value));
      draw();
      el.querySelector<HTMLInputElement>('#gain')!.oninput = draw;
      drawResponseCurve(el.querySelector<HTMLCanvasElement>('#curve-canvas')!, capture.response);
      el.querySelector<HTMLDivElement>('#quality')!.innerHTML =
        `场景：${LIGHTING_SCENES.clinic.name} ｜ 锚定 g(128)=0 ｜ 掩膜外像素进入辐照合并，亮斑已剔除`;
      const thumbs = el.querySelector<HTMLDivElement>('#thumbs')!;
      thumbs.innerHTML = '';
      capture.thumbnails.forEach((t, i) => {
        const c = document.createElement('canvas');
        c.className = 'thumb';
        drawLdr(c, downscaleLdr(t, 96));
        c.title = `EV ${capture.exposures[i]}`;
        thumbs.appendChild(c);
      });
      // 提供「进入绘制」入口
      const go = document.createElement('button');
      go.className = 'btn';
      go.style.marginTop = '12px';
      go.textContent = '用这张健侧 HDR 进入虹膜绘制 →';
      go.onclick = () => {
        setState({ currentCaptureId: lastCaptureId });
        navigate('paint');
      };
      statusEl.appendChild(document.createElement('br'));
      statusEl.appendChild(go);
    } catch (err) {
      reportError(err);
    }
  }

  function appendWarn(msg: string, cls: string): void {
    const div = document.createElement('div');
    div.innerHTML = `<span class="badge ${cls}">提示</span> ${msg}`;
    div.style.marginTop = '6px';
    warnEl.appendChild(div);
  }
  function reportError(err: unknown): void {
    if (err instanceof AllOverexposedError) {
      appendWarn(`全部过曝，无法重建：${err.message}`, 'bad');
      statusEl.textContent = '请重新拍摄，降低整体曝光。';
    } else {
      statusEl.textContent = `处理失败：${(err as Error).message}`;
    }
  }

  el.querySelectorAll<HTMLButtonElement>('[data-use]').forEach((b) => {
    b.onclick = () => {
      setState({ currentCaptureId: b.dataset.use! });
      navigate('paint');
    };
  });

  return el;
}

/** 读取图片文件为 LDR（EV 由调用方给定；真实应用可从 EXIF 曝光时间推导） */
function loadImageFile(file: File, ev: number): Promise<LdrImage> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      // 控制尺寸，避免超大照片拖慢配准
      const maxDim = 512;
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.max(16, Math.round(img.width * scale));
      const h = Math.max(16, Math.round(img.height * scale));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      URL.revokeObjectURL(url);
      resolve({ width: w, height: h, data: new Uint8ClampedArray(data), exposure: ev });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`无法读取图片 ${file.name}`));
    };
    img.src = url;
  });
}
