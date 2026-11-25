import type { RunRecord } from './types';

const STORAGE_KEY = 'tidal-postcards-runs-v1';

export function loadRecords(): RunRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RunRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveRecord(record: RunRecord): RunRecord[] {
  const all = loadRecords();
  all.unshift(record);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all.slice(0, 50)));
  return all.slice(0, 50);
}

export function clearRecords(): void {
  localStorage.removeItem(STORAGE_KEY);
}
