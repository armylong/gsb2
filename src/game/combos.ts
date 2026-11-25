import { PLATES } from './plates';
import type { PlateId } from './types';

/** 一个候选组合 = 6 选 3 的无序集合，id 按铃片定义顺序拼接。 */
export interface Combo {
  id: string;
  plates: [PlateId, PlateId, PlateId];
}

function comboId(ids: PlateId[]): string {
  // 以 PLATES 中的标准顺序排序，保证 id 稳定
  const order = new Map(PLATES.map((p, i) => [p.id, i]));
  return [...ids].sort((a, b) => order.get(a)! - order.get(b)!).join('+');
}

function buildCombos(): Combo[] {
  const out: Combo[] = [];
  const ids = PLATES.map((p) => p.id);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      for (let k = j + 1; k < ids.length; k++) {
        const plates: [PlateId, PlateId, PlateId] = [ids[i], ids[j], ids[k]];
        out.push({ id: comboId(plates), plates });
      }
    }
  }
  return out;
}

export const COMBOS: Combo[] = buildCombos();
export const COMBO_MAP: Map<string, Combo> = new Map(COMBOS.map((c) => [c.id, c]));

export function comboIdOf(ids: PlateId[]): string {
  return comboId(ids);
}

/** 全部有序摆放（6P3 = 120），证据匹配在摆放层面进行，再收敛为组合。 */
export function allArrangements(): PlateId[][] {
  const out: PlateId[][] = [];
  const ids = PLATES.map((p) => p.id);
  for (const a of ids) {
    for (const b of ids) {
      if (b === a) continue;
      for (const c of ids) {
        if (c === a || c === b) continue;
        out.push([a, b, c]);
      }
    }
  }
  return out;
}

export const ARRANGEMENTS = allArrangements();
