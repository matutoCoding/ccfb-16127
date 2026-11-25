/**
 * IndexedDB 持久层测试（fake-indexeddb 提供浏览器同源实现）。
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { db, idb, STORES, uid } from '../src/db/idb';
import type { Patient, PaintScheme } from '../src/core/types';
import { defaultPaintScheme } from '../src/render/eyeModel';

function fakePatient(id: string): Patient {
  return {
    id,
    name: '持久化测试',
    gender: 'male',
    age: 50,
    affectedSide: 'left',
    healthySide: 'right',
    socketCondition: 'enucleation',
    implantType: 'hydroxyapatite',
    prosthesisWidthMm: 22,
    prosthesisHeightMm: 20,
    prosthesisThicknessMm: 2.5,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('IndexedDB 持久层', () => {
  beforeEach(async () => {
    // 每个用例清空所有仓库
    for (const store of Object.values(STORES)) {
      const all = await idb.getAll<{ id: string }>(store);
      for (const row of all) await idb.remove(store, row.id);
    }
  });

  it('患者增删改查', async () => {
    const p = fakePatient(uid('pat'));
    await db.patients.save(p);
    expect(await db.patients.list()).toHaveLength(1);
    const got = await db.patients.get(p.id);
    expect(got?.name).toBe('持久化测试');
    await db.patients.remove(p.id);
    expect(await db.patients.list()).toHaveLength(0);
  });

  it('配色方案按 patientId 索引查询', async () => {
    const s1: PaintScheme = { ...defaultPaintScheme('p1', 1), id: uid('sch'), patientId: 'p1' };
    const s2: PaintScheme = { ...defaultPaintScheme('p2', 2), id: uid('sch'), patientId: 'p2' };
    await db.schemes.save(s1);
    await db.schemes.save(s2);
    const mine = await db.schemes.listFor('p1');
    expect(mine).toHaveLength(1);
    expect(mine[0].patientId).toBe('p1');
  });

  it('设置首次访问返回默认值并落库', async () => {
    const s = await db.settings();
    expect(s.deltaEThreshold).toBe(3);
    expect(s.id).toBe('singleton');
    s.technicianName = '李技师';
    await db.saveSettings(s);
    const again = await db.settings();
    expect(again.technicianName).toBe('李技师');
  });

  it('类型化数组（Float32 HDR 数据）可结构化克隆存取', async () => {
    const { HdrCaptureStub } = await import('./idb-stub');
    const capture = HdrCaptureStub();
    await db.captures.save(capture);
    const back = await db.captures.get(capture.id);
    expect(back).toBeDefined();
    expect(back!.hdr.data).toBeInstanceOf(Float32Array);
    expect(back!.hdr.data[0]).toBeCloseTo(0.25, 5);
    expect(back!.specularMask.data[3]).toBe(1);
  });
});
