import { h, icon, badge, modal, toast, confirmDialog } from '../ui/dom';
import { repo } from '../data/db';
import { uid } from '../core/schemeFactory';
import type { Patient } from '../core/types';
import type { AppCtx } from '../main';

const IMPLANTS = ['多孔羟基磷灰石义眼台 20mm', '多孔羟基磷灰石义眼台 18mm', 'MEDPOR 义眼台 18mm', '玻璃义眼台 19mm', '钛钉连体义眼台 20mm', '未植入义眼台（自体重睑）'];

function emptyPatient(): Patient {
  const now = Date.now();
  return {
    id: uid('pat'), code: `YE-${new Date().getFullYear()}-${Math.floor(100 + Math.random() * 899)}`,
    name: '', prostheticSide: 'R', socketCondition: '', implantType: IMPLANTS[0],
    shellDiameterMm: 22, thicknessMm: 3, irisDiameterMm: 12, note: '', createdAt: now, updatedAt: now,
  };
}

function patientForm(p: Patient, onSave: () => void): HTMLElement {
  const body = h('div');
  const f = <K extends keyof Patient>(key: K, label: string, opts: { type?: string; step?: string; help?: string } = {}) => {
    const input = h('input', { class: 'input', type: opts.type ?? 'text', step: opts.step, value: String(p[key] ?? '') }) as HTMLInputElement;
    input.addEventListener('input', () => {
      (p as unknown as Record<string, unknown>)[key] = opts.type === 'number' ? Number(input.value) : input.value;
    });
    return h('div', { class: 'field' }, h('label', null, label), input, ...(opts.help ? [h('div', { class: 'help' }, opts.help)] : []));
  };

  const nameInput = f('name', '姓名 / 称呼');
  const codeInput = f('code', '档案编号');
  const diam = f('shellDiameterMm', '片子直径 (mm)', { type: 'number', step: '0.5' });
  const thick = f('thicknessMm', '片子厚度 (mm)', { type: 'number', step: '0.1' });
  const irisDiam = f('irisDiameterMm', '可见虹膜横径 (mm)', { type: 'number', step: '0.5', help: '成人通常 11–12mm，用于像素↔毫米与瞳孔换算' });

  const sideSelect = h('select', { class: 'input' },
    h('option', { value: 'R' }, '右眼术眼（健侧为左眼）'),
    h('option', { value: 'L' }, '左眼术眼（健侧为右眼）'),
  ) as HTMLSelectElement;
  sideSelect.value = p.prostheticSide;
  sideSelect.onchange = () => { p.prostheticSide = sideSelect.value as 'L' | 'R'; };

  const implantSelect = h('select', { class: 'input' }, ...IMPLANTS.map((x) => h('option', { value: x }, x))) as HTMLSelectElement;
  implantSelect.value = p.implantType;
  implantSelect.onchange = () => { p.implantType = implantSelect.value; };

  const socketArea = h('textarea', { class: 'input', placeholder: '结膜囊深浅、穹窿、睑裂、分泌物、水肿…' }) as HTMLTextAreaElement;
  socketArea.value = p.socketCondition;
  socketArea.oninput = () => { p.socketCondition = socketArea.value; };
  const noteArea = h('textarea', { class: 'input', placeholder: '过敏史、既往返工原因、患者偏好…' }) as HTMLTextAreaElement;
  noteArea.value = p.note;
  noteArea.oninput = () => { p.note = noteArea.value; };

  body.append(
    h('div', { class: 'field-row' }, nameInput, codeInput),
    h('div', { class: 'field-row' },
      h('div', { class: 'field' }, h('label', null, '左右眼（术眼别）'), sideSelect),
      h('div', { class: 'field' }, h('label', null, '义眼台类型'), implantSelect),
    ),
    h('div', { class: 'field-row three' }, diam, thick, irisDiam),
    h('div', { class: 'field' }, h('label', null, '眼窝情况'), socketArea),
    h('div', { class: 'field' }, h('label', null, '备注'), noteArea),
  );

  const m = modal({
    title: p.name ? '编辑患者档案' : '新建患者档案',
    body,
    footer: [
      h('button', { class: 'btn', onclick: () => m.close() }, '取消'),
      h('button', {
        class: 'btn primary', onclick: async () => {
          if (!p.name.trim()) { toast('请填写姓名', 'bad'); return; }
          p.updatedAt = Date.now();
          await repo.savePatient(p);
          toast('档案已保存', 'good');
          m.close();
          onSave();
        },
      }, '保存档案'),
    ],
  });
  return body;
}

export async function renderPatients(root: HTMLElement, ctx: AppCtx) {
  const patients = await repo.listPatients();
  const { idb } = await import('../data/db');
  const snapshots = await idb.all<import('../core/types').Snapshot>('snapshots');
  const deliveries = await idb.all<import('../core/types').DeliveryRecord>('deliveries');

  const head = h('div', { class: 'flex wrap mb8' },
    h('div', null, h('h2', { style: 'font-size:20px' }, `共 ${patients.length} 份档案`),
      h('div', { class: 'small muted' }, '每次调整均留存配色快照，交付单签字后归档，下一副可直接从快照起步')),
    h('button', {
      class: 'btn primary lg right', onclick: () => patientForm(emptyPatient(), () => ctx.refresh()),
    }, icon('plus'), '新建患者'),
  );
  root.appendChild(head);

  if (!patients.length) {
    root.appendChild(h('div', { class: 'card empty-state' }, icon('patients', 'big-ico'), h('div', null, '还没有患者档案，点击右上角新建')));
    return;
  }

  const grid = h('div', { class: 'patient-grid mt16' });
  for (const p of patients) {
    const pSnaps = snapshots.filter((s) => s.patientId === p.id);
    const pDeliveries = deliveries.filter((d) => d.patientId === p.id);
    const latestMetric = pSnaps[0]?.metrics?.find((m) => m.sceneId === 'clinic');
    const cap = await repo.latestCapture(p.id);

    const deBadge = latestMetric
      ? badge(`ΔE00 ${latestMetric.meanDeltaE.toFixed(2)}`, latestMetric.pass ? 'green' : 'red', true)
      : cap?.quality?.allOverexposed ? badge('整组过曝', 'red', true)
      : badge('尚未拟合', 'gray');

    const card = h('div', { class: 'card patient-card' });
    card.appendChild(h('div', { class: 'pc-top' },
      h('div', { class: `avatar ${p.prostheticSide}`, style: 'width:44px;height:44px;font-size:17px' }, p.name.slice(0, 1)),
      h('div', { style: 'min-width:0' },
        h('div', { class: 'pc-name' }, p.name),
        h('div', { class: 'pc-code' }, `${p.code} · ${p.prostheticSide === 'L' ? '左眼术眼' : '右眼术眼'} · 健侧${p.prostheticSide === 'L' ? '右' : '左'}眼`),
      ),
      h('div', { class: 'right' }, deBadge),
    ));
    card.appendChild(h('div', { class: 'pc-tags' },
      badge(`直径 ${p.shellDiameterMm}mm`, 'teal'),
      badge(`厚度 ${p.thicknessMm}mm`, 'blue'),
      cap?.datasetKind === 'shaky' ? badge('手抖序列', 'amber') : null,
      pDeliveries.length ? badge(`已交付 ×${pDeliveries.length}`, 'green') : null,
    ));
    card.appendChild(h('div', { class: 'pc-meta' },
      h('span', null, '义眼台：', h('b', null, p.implantType.length > 12 ? p.implantType.slice(0, 12) + '…' : p.implantType)),
      h('span', null, '快照：', h('b', null, `${pSnaps.length} 份`)),
      h('span', { style: 'grid-column:1/-1' }, '眼窝：', h('b', { style: 'font-weight:500' }, p.socketCondition || '—')),
    ));
    const actions = h('div', { class: 'flex wrap', style: 'gap:6px' },
      h('button', { class: 'btn sm primary', onclick: (e: Event) => { e.stopPropagation(); ctx.setPatient(p.id); ctx.navigate(`#/capture/${p.id}`); } }, '拍摄'),
      h('button', { class: 'btn sm', onclick: (e: Event) => { e.stopPropagation(); ctx.setPatient(p.id); ctx.navigate(`#/iris/${p.id}`); } }, '绘制'),
      h('button', { class: 'btn sm', onclick: (e: Event) => { e.stopPropagation(); ctx.setPatient(p.id); ctx.navigate(`#/compare/${p.id}`); } }, '比对'),
      h('button', { class: 'btn sm', onclick: (e: Event) => { e.stopPropagation(); ctx.setPatient(p.id); ctx.navigate(`#/delivery/${p.id}`); } }, '交付'),
      h('span', { class: 'right flex', style: 'gap:4px' },
        h('button', { class: 'btn ghost sm', title: '编辑', onclick: (e: Event) => { e.stopPropagation(); patientForm({ ...p }, () => ctx.refresh()); } }, '编辑'),
        h('button', {
          class: 'btn ghost sm', title: '删除', onclick: async (e: Event) => {
            e.stopPropagation();
            if (await confirmDialog(`确认删除 ${p.name} 的档案及其拍摄/方案/快照？此操作不可恢复。`)) {
              await repo.deletePatient(p.id);
              toast('档案已删除', 'good');
              ctx.refresh();
            }
          },
        }, '删除'),
      ),
    );
    card.appendChild(h('div', { class: 'pc-foot' }, h('span', null, new Date(p.updatedAt).toLocaleDateString('zh-CN')), actions));
    card.addEventListener('click', () => { ctx.setPatient(p.id); ctx.navigate(`#/capture/${p.id}`); });
    grid.appendChild(card);
  }
  root.appendChild(grid);
}
