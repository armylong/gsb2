import { isSaveFile } from './engine';
import type { GameState, SaveFile, StorageLike, Viewer } from './types';

export const SAVES_KEY = 'specimen-draft-lab:saves:v1';
export const SAVE_VERSION = 1 as const;

export function defaultSaveLabel(game: GameState): string {
  const phase = game.phase === 'selecting' ? '开选前' : '开牌后';
  return `${game.scenarioName} · 第 ${game.roundIndex + 1} 轮 · ${phase}`;
}

let fallbackSequence = 0;

function makeId(now: Date): string {
  const cryptoRef = globalThis.crypto as Crypto | undefined;
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') {
    return cryptoRef.randomUUID();
  }
  fallbackSequence += 1;
  return `save-${now.getTime()}-${fallbackSequence}`;
}

export function createSave(
  game: GameState,
  viewTeam: Viewer,
  label: string | null,
  now: Date = new Date(),
): SaveFile {
  return {
    version: SAVE_VERSION,
    id: makeId(now),
    label: label?.trim() || defaultSaveLabel(game),
    savedAt: now.toISOString(),
    viewTeam,
    game,
  };
}

export function parseSaves(raw: string | null): SaveFile[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { saves?: unknown }).saves)
      ? (parsed as { saves: unknown[] }).saves
      : [];
  return list.filter((entry): entry is SaveFile => isSaveFile(entry));
}

export function serializeSaves(saves: SaveFile[]): string {
  return JSON.stringify({ version: SAVE_VERSION, saves });
}

export function loadSaves(storage: StorageLike | null): SaveFile[] {
  if (!storage) return [];
  try {
    return parseSaves(storage.getItem(SAVES_KEY));
  } catch {
    return [];
  }
}

export function persistSaves(storage: StorageLike | null, saves: SaveFile[]): SaveFile[] {
  if (!storage) {
    throw new Error('当前环境不支持本地存储');
  }
  storage.setItem(SAVES_KEY, serializeSaves(saves));
  return saves;
}

export function addSave(
  storage: StorageLike | null,
  save: SaveFile,
  existing?: SaveFile[],
): SaveFile[] {
  const current = existing ?? loadSaves(storage);
  const next = [save, ...current.filter((entry) => entry.id !== save.id)];
  return persistSaves(storage, next);
}

export function removeSave(
  storage: StorageLike | null,
  id: string,
  existing?: SaveFile[],
): SaveFile[] {
  const current = existing ?? loadSaves(storage);
  return persistSaves(
    storage,
    current.filter((entry) => entry.id !== id),
  );
}
