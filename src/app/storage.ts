import type { DialogueConfig, StorageLike } from '../engine/types';

export const CONFIG_DRAFT_KEY = 'grey-harbor-dialogue-debugger/config-draft/v1';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 浏览器存储可能被禁用；所有调用点都必须容忍 null。 */
export function getBrowserStorage(): StorageLike | null {
  try {
    if (typeof window === 'undefined') return null;
    const storage = window.localStorage;
    const probe = '__grey-harbor-probe__';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

function looksLikeConfig(value: unknown): value is DialogueConfig {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === 1 &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.entryNodeId === 'string' &&
    isRecord(value.variables) &&
    Array.isArray(value.nodes)
  );
}

export function loadDraftConfig(storage: StorageLike | null): DialogueConfig | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(CONFIG_DRAFT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return looksLikeConfig(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function persistDraftConfig(storage: StorageLike | null, config: DialogueConfig): boolean {
  if (!storage) return false;
  try {
    storage.setItem(CONFIG_DRAFT_KEY, JSON.stringify(config));
    return true;
  } catch {
    return false;
  }
}

export function clearDraftConfig(storage: StorageLike | null): void {
  if (!storage) return;
  try {
    storage.removeItem(CONFIG_DRAFT_KEY);
  } catch {
    // 忽略存储不可用。
  }
}
