import type { Arrangement, Beat, StripDef } from './model';

export interface ExpandOk {
  ok: true;
  beats: Beat[];
}

export interface ExpandErr {
  ok: false;
  /** 停在哪一槽（0-based） */
  slotIndex: number;
  /** 停在展开后的第几拍（= 出错前已读出的拍数） */
  beatIndex: number;
  reason: string;
  /** 出错前已展开的部分 */
  beats: Beat[];
}

export type ExpandResult = ExpandOk | ExpandErr;

const SAFETY_CAP = 4096;

/**
 * 把卡槽摆法展开成拍序列。
 * - 纸带正序读出每一列；倒向插入则列序反转（路不变）。
 * - 返回标记：第一次读到时跳回 backTo 槽，把那一小段重读一遍；
 *   同一枚标记第二次读到时不再跳转，继续前进（只重复一次）。
 * - 标记指向自身或之后的槽位（顺序不成立）或越界时，停在当前孔位并给出原因。
 */
export function expandArrangement(
  arrangement: Arrangement,
  strips: Map<string, StripDef>,
  tracks: number,
): ExpandResult {
  const beats: Beat[] = [];
  const fired = new Set<number>();
  let i = 0;

  while (i < arrangement.length) {
    const entry = arrangement[i];

    if (entry.kind === 'strip') {
      const def = strips.get(entry.stripId);
      if (!def) {
        return {
          ok: false,
          slotIndex: i,
          beatIndex: beats.length,
          reason: `卡槽里有一条不认识的纸带（${entry.stripId}）`,
          beats,
        };
      }
      for (let c = 0; c < def.length; c++) {
        const col = entry.reversed ? def.length - 1 - c : c;
        const hits: boolean[] = [];
        for (let t = 0; t < tracks; t++) hits.push(def.cells[t][col] === 1);
        beats.push({ hits });
      }
      i++;
    } else {
      if (entry.backTo < 0 || entry.backTo >= arrangement.length) {
        return {
          ok: false,
          slotIndex: i,
          beatIndex: beats.length,
          reason: `第 ${i + 1} 槽的返回标记指向了不存在的槽位（第 ${entry.backTo + 1} 槽）`,
          beats,
        };
      }
      if (entry.backTo >= i) {
        return {
          ok: false,
          slotIndex: i,
          beatIndex: beats.length,
          reason: `第 ${i + 1} 槽的返回标记指向了它自身或之后的位置（第 ${entry.backTo + 1} 槽），标记顺序不成立，读卡器停在这里`,
          beats,
        };
      }
      if (fired.has(i)) {
        // 第二次读到这枚标记：不再重复，继续前进
        i++;
        continue;
      }
      fired.add(i);
      i = entry.backTo;
    }

    if (beats.length > SAFETY_CAP) {
      return {
        ok: false,
        slotIndex: i,
        beatIndex: beats.length,
        reason: '展开拍数超过安全上限，读卡器强制停止',
        beats,
      };
    }
  }

  return { ok: true, beats };
}
