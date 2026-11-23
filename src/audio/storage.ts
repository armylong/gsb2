/**
 * IndexedDB 持久层：
 * - files  保存本地 WAV 的原始 Blob（mapping 中用 blobId 引用）
 * - kv     保存映射 JSON（含最后保存时间）
 * 内置音色不入库，重开后按 synthId 重新离线渲染。
 */

const DB_NAME = 'footstep-sampler';
const DB_VERSION = 1;
const STORE_FILES = 'files';
const STORE_KV = 'kv';
const MAPPING_KEY = 'mapping-v1';

export interface StoredFile {
  id: string;
  name: string;
  blob: Blob;
  size: number;
  storedAt: number;
}

export interface PersistedMappingEnvelope {
  savedAt: number;
  mapping: unknown;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_FILES)) db.createObjectStore(STORE_FILES, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_KV)) db.createObjectStore(STORE_KV);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const r = fn(t.objectStore(store));
        r.onsuccess = () => {
          t.oncomplete = () => {
            db.close();
            resolve(r.result);
          };
        };
        r.onerror = () => {
          db.close();
          reject(r.error);
        };
      }),
  );
}

export async function putFile(file: StoredFile): Promise<void> {
  await tx(STORE_FILES, 'readwrite', (s) => s.put(file));
}

export async function getFile(id: string): Promise<StoredFile | undefined> {
  return tx<StoredFile | undefined>(STORE_FILES, 'readonly', (s) => s.get(id));
}

export async function deleteFile(id: string): Promise<void> {
  await tx(STORE_FILES, 'readwrite', (s) => s.delete(id));
}

export async function saveMapping(mapping: unknown): Promise<number> {
  const savedAt = Date.now();
  await tx(STORE_KV, 'readwrite', (s) => s.put({ savedAt, mapping } satisfies PersistedMappingEnvelope, MAPPING_KEY));
  return savedAt;
}

export async function loadMapping(): Promise<PersistedMappingEnvelope | undefined> {
  return tx<PersistedMappingEnvelope | undefined>(STORE_KV, 'readonly', (s) => s.get(MAPPING_KEY));
}

export async function clearMapping(): Promise<void> {
  await tx(STORE_KV, 'readwrite', (s) => s.delete(MAPPING_KEY));
}
