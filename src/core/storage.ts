import type { ItemDef, LayoutFile, WorldState } from './types';
import { validateLayout } from './inventory';

const STORAGE_KEY = 'grid-inventory-lab:layout:v1';

export interface LoadResult {
  ok: boolean;
  file: LayoutFile | null;
  errors: string[];
}

/** 校验并解析布局文件内容; 任何问题都返回错误而不是抛异常 */
export function parseLayoutText(text: string): LoadResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, file: null, errors: [`JSON 解析失败: ${(e as Error).message}`] };
  }
  return validateFile(raw);
}

function validateFile(raw: unknown): LoadResult {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, file: null, errors: ['布局文件不是对象'] };
  }
  const f = raw as Partial<LayoutFile>;
  if (f.version !== 1) errors.push(`不支持的版本号: ${String(f.version)}`);
  if (!Array.isArray(f.items)) errors.push('缺少 items 数组');
  if (typeof f.world !== 'object' || f.world === null) errors.push('缺少 world 对象');
  if (errors.length > 0) return { ok: false, file: null, errors };

  const items = f.items as ItemDef[];
  const world = f.world as WorldState;
  if (!Array.isArray(world.bags) || !Array.isArray(world.placements)) {
    return { ok: false, file: null, errors: ['world.bags / world.placements 必须是数组'] };
  }
  for (const issue of validateLayout(items, world)) errors.push(issue.message);
  if (errors.length > 0) return { ok: false, file: null, errors };
  return { ok: true, file: f as LayoutFile, errors: [] };
}

export function saveToLocalStorage(file: LayoutFile): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(file));
}

export function loadFromLocalStorage(): LoadResult | null {
  const text = localStorage.getItem(STORAGE_KEY);
  if (text === null) return null;
  return parseLayoutText(text);
}

export function clearLocalStorage(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function buildLayoutFile(items: ItemDef[], world: WorldState): LayoutFile {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    items: structuredClone(items),
    world: structuredClone(world),
  };
}
