/** 患者档案页：眼窝情况、义眼台、片子尺寸厚度、左右眼、配色快照入口 */
import { db, uid } from '../../db/idb';
import { getState, setState, navigate } from '../state';
import type { EyeSide, Patient, SocketCondition, ImplantType } from '../../core/types';

const SOCKET_LABELS: Record<SocketCondition, string> = {
  enucleation: '眼球摘除',
  evisceration: '眼内容剜除',
  atrophy: '眼球萎缩',
  congenital: '先天缺失/小眼球',
};
const IMPLANT_LABELS: Record<ImplantType, string> = {
  hydroxyapatite: '羟基磷灰石义眼台',
  medpor: 'Medpor 义眼台',
  silicone: '硅胶义眼台',
  none: '无义眼台',
  other: '其他',
};

export async function renderPatientsPage(): Promise<HTMLElement> {
  const el = document.createElement('div');
  const patients = await db.patients.list();
  setState({ patients });
  const s = getState();

  el.innerHTML = `
    <h2 class="page-title">患者档案</h2>
    <p class="page-desc">记录眼窝情况、义眼台类型、义眼片尺寸厚度与患侧/健侧；每次配色调整都会在档案下留存快照。</p>
    <div class="btn-row" style="margin-bottom:16px">
      <button class="btn" id="new-patient">＋ 新建患者</button>
    </div>
    <div class="card">
      <table>
        <thead><tr><th>姓名</th><th>患侧/健侧</th><th>眼窝情况</th><th>义眼台</th><th>片子尺寸(mm)</th><th>厚度(mm)</th><th>操作</th></tr></thead>
        <tbody>
          ${patients
            .map(
              (p) => `
            <tr class="clickable" data-id="${p.id}">
              <td>${p.name} <span class="muted">${p.gender === 'unknown' ? '' : p.gender === 'male' ? '男' : '女'} ${p.age}岁</span></td>
              <td><span class="badge info">患 ${p.affectedSide === 'left' ? '左' : '右'}</span> / 健 ${p.healthySide === 'left' ? '左' : '右'}</td>
              <td>${SOCKET_LABELS[p.socketCondition]}</td>
              <td>${IMPLANT_LABELS[p.implantType]}</td>
              <td class="mono">${p.prosthesisWidthMm} × ${p.prosthesisHeightMm}</td>
              <td class="mono">${p.prosthesisThicknessMm}</td>
              <td><button class="btn secondary" data-open="${p.id}">打开</button> <button class="btn danger" data-del="${p.id}">删除</button></td>
            </tr>`,
            )
            .join('') || '<tr><td colspan="7" class="muted">还没有患者档案，点击「新建患者」开始。</td></tr>'}
        </tbody>
      </table>
    </div>`;

  el.querySelector<HTMLButtonElement>('#new-patient')!.onclick = () => openEditor(el, null);
  el.querySelectorAll<HTMLElement>('tr.clickable').forEach((tr) => {
    tr.querySelector('[data-open]')!.addEventListener('click', (e) => {
      e.stopPropagation();
      openPatient(tr.dataset.id!);
    });
    tr.querySelector('[data-del]')!.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm('确认删除该患者档案及其全部数据？')) {
        await db.patients.remove(tr.dataset.id!);
        refresh();
      }
    });
    tr.addEventListener('click', () => openPatient(tr.dataset.id!));
  });
  void s;
  return el;
}

function openPatient(id: string): void {
  setState({ currentPatientId: id, currentCaptureId: null, currentSchemeId: null, currentReportId: null });
  navigate('capture');
}

async function refresh(): Promise<void> {
  const root = document.querySelector('main')!;
  root.innerHTML = '';
  root.appendChild(await renderPatientsPage());
}

function openEditor(host: HTMLElement, existing: Patient | null): void {
  const wrap = document.createElement('div');
  wrap.className = 'card';
  const side = (v: EyeSide) => v;
  wrap.innerHTML = `
    <h3>${existing ? '编辑患者' : '新建患者'}</h3>
    <div class="grid grid-3">
      <label class="field">姓名<input id="f-name" value="${existing?.name ?? ''}"></label>
      <label class="field">性别<select id="f-gender">
        <option value="unknown" ${existing?.gender === 'unknown' ? 'selected' : ''}>未填</option>
        <option value="male" ${existing?.gender === 'male' ? 'selected' : ''}>男</option>
        <option value="female" ${existing?.gender === 'female' ? 'selected' : ''}>女</option></select></label>
      <label class="field">年龄<input id="f-age" type="number" min="0" max="120" value="${existing?.age ?? 40}"></label>
      <label class="field">患侧（佩戴义眼）<select id="f-affected">
        <option value="left" ${existing?.affectedSide === 'left' ? 'selected' : ''}>左眼</option>
        <option value="right" ${existing?.affectedSide !== 'left' ? 'selected' : ''}>右眼</option></select></label>
      <label class="field">眼窝情况<select id="f-socket">
        ${Object.entries(SOCKET_LABELS).map(([k, v]) => `<option value="${k}" ${existing?.socketCondition === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="field">义眼台类型<select id="f-implant">
        ${Object.entries(IMPLANT_LABELS).map(([k, v]) => `<option value="${k}" ${existing?.implantType === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="field">片宽 (mm)<input id="f-w" type="number" step="0.1" value="${existing?.prosthesisWidthMm ?? 22}"></label>
      <label class="field">片高 (mm)<input id="f-h" type="number" step="0.1" value="${existing?.prosthesisHeightMm ?? 20}"></label>
      <label class="field">厚度 (mm)<input id="f-t" type="number" step="0.1" value="${existing?.prosthesisThicknessMm ?? 2.5}"></label>
      <label class="field" style="grid-column:1/-1">备注<textarea id="f-note" rows="2">${existing?.note ?? ''}</textarea></label>
    </div>
    <div class="btn-row" style="margin-top:14px">
      <button class="btn" id="f-save">保存</button>
      <button class="btn secondary" id="f-cancel">取消</button>
    </div>`;
  host.prepend(wrap);
  wrap.querySelector<HTMLButtonElement>('#f-cancel')!.onclick = () => wrap.remove();
  wrap.querySelector<HTMLButtonElement>('#f-save')!.onclick = async () => {
    const affected = wrap.querySelector<HTMLSelectElement>('#f-affected')!.value as EyeSide;
    const patient: Patient = {
      id: existing?.id ?? uid('pat'),
      name: wrap.querySelector<HTMLInputElement>('#f-name')!.value.trim() || '未命名患者',
      gender: wrap.querySelector<HTMLSelectElement>('#f-gender')!.value as Patient['gender'],
      age: Number(wrap.querySelector<HTMLInputElement>('#f-age')!.value),
      note: wrap.querySelector<HTMLTextAreaElement>('#f-note')!.value,
      affectedSide: side(affected),
      healthySide: affected === 'left' ? 'right' : 'left',
      socketCondition: wrap.querySelector<HTMLSelectElement>('#f-socket')!.value as SocketCondition,
      implantType: wrap.querySelector<HTMLSelectElement>('#f-implant')!.value as ImplantType,
      prosthesisWidthMm: Number(wrap.querySelector<HTMLInputElement>('#f-w')!.value),
      prosthesisHeightMm: Number(wrap.querySelector<HTMLInputElement>('#f-h')!.value),
      prosthesisThicknessMm: Number(wrap.querySelector<HTMLInputElement>('#f-t')!.value),
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    await db.patients.save(patient);
    refresh();
  };
}
