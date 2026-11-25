import { GameState } from './engine';

// 用「帧栈 + 指针」保存每一局：frames[0] 永远是该起手朝向下的初始局面。
// 持久化 frames + index 后，重开页面看到的印记、可撤销到的起点与关闭前完全一致。
// 多个关卡 / 起手朝向分别存放在不同槽位，并记录上次活动槽。
const STORE_KEY = 'rolling-stamp-puzzle:store:v1';

export type FrameKind = 'init' | 'move' | 'stamp';

export interface FrameData {
  state: GameState;
  kind: FrameKind;
  dir?: import('./engine').Dir;
}

export interface SaveData {
  version: 1;
  levelId: string;
  variantId: string | null;
  stampedBlocks: boolean;
  frames: FrameData[];
  index: number;
  savedAt: number;
}

interface StoreFile {
  version: 1;
  active: string;
  slots: Record<string, SaveData>;
}

export function slotId(levelId: string, variantId: string | null): string {
  return `${levelId}#${variantId ?? 'base'}`;
}

function isState(v: unknown): v is GameState {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.x === 'number' &&
    typeof s.y === 'number' &&
    typeof s.ori === 'string' &&
    typeof s.stamps === 'object' &&
    s.stamps !== null
  );
}

function isFrame(v: unknown): v is FrameData {
  if (!v || typeof v !== 'object') return false;
  const f = v as Record<string, unknown>;
  return isState(f.state) && (f.kind === 'init' || f.kind === 'move' || f.kind === 'stamp');
}

function readStore(): StoreFile | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoreFile>;
    if (parsed.version !== 1 || typeof parsed.active !== 'string') return null;
    if (!parsed.slots || typeof parsed.slots !== 'object') return null;
    return parsed as StoreFile;
  } catch {
    return null;
  }
}

function writeStore(store: StoreFile): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    /* 隐私模式 / 配额异常时静默：本局仍可正常游玩 */
  }
}

function validate(data: unknown): SaveData | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Partial<SaveData>;
  if (d.version !== 1 || typeof d.levelId !== 'string') return null;
  if (typeof d.index !== 'number') return null;
  if (!Array.isArray(d.frames) || !d.frames.every(isFrame)) return null;
  if (d.index < 0 || d.index >= d.frames.length) return null;
  return d as SaveData;
}

/** 读取上次活动的那一局（用于打开页面时恢复） */
export function loadActiveSave(): SaveData | null {
  const store = readStore();
  if (!store) return null;
  const candidate = validate(store.slots[store.active]);
  return candidate;
}

export function loadSlot(id: string): SaveData | null {
  const store = readStore();
  if (!store) return null;
  return validate(store.slots[id]);
}

export function saveSlot(data: Omit<SaveData, 'version' | 'savedAt'>): SaveData {
  const full: SaveData = { version: 1, savedAt: Date.now(), ...data };
  const store = readStore() ?? { version: 1 as const, active: '', slots: {} };
  const id = slotId(full.levelId, full.variantId);
  store.slots[id] = full;
  store.active = id;
  writeStore(store);
  return full;
}

export function formatSavedAt(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
