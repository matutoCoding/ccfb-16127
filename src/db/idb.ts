/**
 * IndexedDB 持久层。
 * 患者照片（HDR/LDR 二进制）与配色方案全部本地存储，不上传任何外部服务。
 * 用对象仓库分表，结构化克隆直接存取 Float32Array/Uint8ClampedArray 等类型化数组。
 */
import type {
  AppSettings,
  ComparisonReport,
  DeliveryRecord,
  HdrCapture,
  PaintSnapshot,
  Patient,
  PaintScheme,
} from '../core/types';

const DB_NAME = 'ocular-prosthesis-db';
const DB_VERSION = 1;

export const STORES = {
  patients: 'patients',
  captures: 'captures',
  schemes: 'schemes',
  snapshots: 'snapshots',
  reports: 'reports',
  deliveries: 'deliveries',
  settings: 'settings',
} as const;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.patients)) db.createObjectStore(STORES.patients, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORES.captures)) {
        const s = db.createObjectStore(STORES.captures, { keyPath: 'id' });
        s.createIndex('patientId', 'patientId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.schemes)) {
        const s = db.createObjectStore(STORES.schemes, { keyPath: 'id' });
        s.createIndex('patientId', 'patientId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.snapshots)) {
        const s = db.createObjectStore(STORES.snapshots, { keyPath: 'id' });
        s.createIndex('patientId', 'patientId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.reports)) {
        const s = db.createObjectStore(STORES.reports, { keyPath: 'id' });
        s.createIndex('patientId', 'patientId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.deliveries)) {
        const s = db.createObjectStore(STORES.deliveries, { keyPath: 'id' });
        s.createIndex('patientId', 'patientId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.settings)) db.createObjectStore(STORES.settings, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export const idb = {
  async put<T>(store: string, value: T): Promise<IDBValidKey> {
    return tx(store, 'readwrite', (s) => s.put(value as unknown as object));
  },
  async get<T>(store: string, key: string): Promise<T | undefined> {
    return tx<T | undefined>(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
  },
  async getAll<T>(store: string): Promise<T[]> {
    return tx<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
  },
  async getAllByIndex<T>(store: string, index: string, value: string): Promise<T[]> {
    return openDb().then(
      (db) =>
        new Promise<T[]>((resolve, reject) => {
          const t = db.transaction(store, 'readonly');
          const req = t.objectStore(store).index(index).getAll(value);
          req.onsuccess = () => resolve(req.result as T[]);
          req.onerror = () => reject(req.error);
        }),
    );
  },
  async remove(store: string, key: string): Promise<void> {
    await tx(store, 'readwrite', (s) => s.delete(key));
  },
};

// —— 领域专用便捷封装（含默认设置）——
export const db = {
  patients: {
    list: () => idb.getAll<Patient>(STORES.patients),
    get: (id: string) => idb.get<Patient>(STORES.patients, id),
    save: (p: Patient) => idb.put(STORES.patients, p),
    remove: (id: string) => idb.remove(STORES.patients, id),
  },
  captures: {
    listFor: (patientId: string) => idb.getAllByIndex<HdrCapture>(STORES.captures, 'patientId', patientId),
    get: (id: string) => idb.get<HdrCapture>(STORES.captures, id),
    save: (c: HdrCapture) => idb.put(STORES.captures, c),
    remove: (id: string) => idb.remove(STORES.captures, id),
  },
  schemes: {
    listFor: (patientId: string) => idb.getAllByIndex<PaintScheme>(STORES.schemes, 'patientId', patientId),
    get: (id: string) => idb.get<PaintScheme>(STORES.schemes, id),
    save: (s: PaintScheme) => idb.put(STORES.schemes, s),
    remove: (id: string) => idb.remove(STORES.schemes, id),
  },
  snapshots: {
    listFor: (patientId: string) => idb.getAllByIndex<PaintSnapshot>(STORES.snapshots, 'patientId', patientId),
    save: (s: PaintSnapshot) => idb.put(STORES.snapshots, s),
  },
  reports: {
    listFor: (patientId: string) => idb.getAllByIndex<ComparisonReport>(STORES.reports, 'patientId', patientId),
    get: (id: string) => idb.get<ComparisonReport>(STORES.reports, id),
    save: (r: ComparisonReport) => idb.put(STORES.reports, r),
  },
  deliveries: {
    listFor: (patientId: string) => idb.getAllByIndex<DeliveryRecord>(STORES.deliveries, 'patientId', patientId),
    save: (d: DeliveryRecord) => idb.put(STORES.deliveries, d),
  },
  async settings(): Promise<AppSettings> {
    const s = await idb.get<AppSettings>(STORES.settings, 'singleton');
    if (s) return s;
    const def: AppSettings = {
      id: 'singleton',
      technicianName: '',
      studioName: '',
      deltaEThreshold: 3,
      responseLambda: 8,
      renderSize: 256,
      preferWebGpu: true,
    };
    await idb.put(STORES.settings, def);
    return def;
  },
  saveSettings: (s: AppSettings) => idb.put(STORES.settings, s),
};

export function uid(prefix = 'id'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
