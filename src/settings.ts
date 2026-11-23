import type { BakeSettings } from './types.js';

/** 稳定序列化：对象键按字典序排序，保证同设置字节一致 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** FNV-1a 32 位哈希，足够用于「旧贴图是否过期」的本地标记 */
export function fnvBytes(bytes: ArrayLike<number>): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function settingsHash(settings: BakeSettings): string {
  const bytes = new TextEncoder().encode(stableStringify(settings));
  return fnvBytes(bytes);
}
