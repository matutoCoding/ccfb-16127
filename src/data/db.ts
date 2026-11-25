// IndexedDB 持久层：患者档案、拍摄序列、当前配色、快照、交付单、设置、图片 Blob。
import type {
  AppSettings, CaptureRecord, DeliveryRecord, Patient, Snapshot,
} from '../core/types';

const DB_NAME = 'eye-color-studio';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const stores: [string, string?][] = [
        ['patients', 'id'],
        ['captures', 'id'],
        ['schemes', 'id'],
        ['snapshots', 'id'],
        ['deliveries', 'id'],
        ['blobs', 'id'],
        ['kv', 'id'],
      ];
      for (const [name, keyPath] of stores) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, keyPath ? { keyPath } : undefined);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = run(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export const idb = {
  async put<T extends { id: string }>(store: string, value: T): Promise<T> {
    await tx(store, 'readwrite', (s) => s.put(value));
    return value;
  },
  get<T>(store: string, id: string): Promise<T | undefined> {
    return tx<T | undefined>(store, 'readonly', (s) => s.get(id) as IDBRequest<T | undefined>);
  },
  async all<T>(store: string): Promise<T[]> {
    return tx<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
  },
  async del(store: string, id: string): Promise<void> {
    await tx(store, 'readwrite', (s) => s.delete(id));
  },
  async clear(store: string): Promise<void> {
    await tx(store, 'readwrite', (s) => s.clear());
  },
  async putBlob(id: string, blob: Blob): Promise<void> {
    await tx('blobs', 'readwrite', (s) => s.put({ id, blob }));
  },
  async getBlobUrl(id: string): Promise<string | null> {
    const rec = await tx<{ id: string; blob: Blob } | undefined>('blobs', 'readonly', (s) =>
      s.get(id) as IDBRequest<{ id: string; blob: Blob } | undefined>);
    return rec ? URL.createObjectURL(rec.blob) : null;
  },
};

// ---------- 语义化仓储 ----------
export const repo = {
  listPatients: () => idb.all<Patient>('patients').then((ps) => ps.sort((a, b) => b.updatedAt - a.updatedAt)),
  getPatient: (id: string) => idb.get<Patient>('patients', id),
  savePatient: (p: Patient) => idb.put('patients', p),
  deletePatient: (id: string) => idb.del('patients', id),

  async latestCapture(patientId: string): Promise<CaptureRecord | undefined> {
    const all = await idb.all<CaptureRecord>('captures');
    return all.filter((c) => c.patientId === patientId).sort((a, b) => b.createdAt - a.createdAt)[0];
  },
  saveCapture: (c: CaptureRecord) => idb.put('captures', c),
  getCapture: (id: string) => idb.get<CaptureRecord>('captures', id),

  async currentScheme(patientId: string) {
    const all = await idb.all<import('../core/types').IrisScheme>('schemes');
    return all
      .filter((s) => s.patientId === patientId)
      .sort((a, b) => b.version - a.version)[0];
  },
  saveScheme: (s: import('../core/types').IrisScheme) => idb.put('schemes', s),

  listSnapshots: (patientId: string) =>
    idb.all<Snapshot>('snapshots').then((xs) => xs.filter((x) => x.patientId === patientId).sort((a, b) => b.createdAt - a.createdAt)),
  saveSnapshot: (s: Snapshot) => idb.put('snapshots', s),

  listDeliveries: (patientId?: string) =>
    idb.all<DeliveryRecord>('deliveries').then((xs) =>
      xs.filter((x) => !patientId || x.patientId === patientId).sort((a, b) => b.createdAt - a.createdAt)),
  saveDelivery: (d: DeliveryRecord) => idb.put('deliveries', d),
  getDelivery: (id: string) => idb.get<DeliveryRecord>('deliveries', id),

  async getSettings(): Promise<AppSettings> {
    const s = await idb.get<AppSettings>('kv', 'app');
    return (
      s ?? {
        id: 'app',
        deltaEThreshold: 3,
        hdrErrorThreshold: 5,
        renderBackend: 'auto',
        studioName: '瞳色工坊定制义眼工作室',
        operator: '配色技师',
      }
    );
  },
  saveSettings: (s: AppSettings) => idb.put('kv', s),

  async wipeAll() {
    for (const st of ['patients', 'captures', 'schemes', 'snapshots', 'deliveries', 'blobs']) await idb.clear(st);
  },
};
