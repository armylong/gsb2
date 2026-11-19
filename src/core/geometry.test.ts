import { describe, expect, it } from 'vitest';
import type { Cell, ItemDef, Placement } from './types';
import {
  baseCellFromRendered,
  normalize,
  occupiedCells,
  renderedRelOf,
  rotateAroundGrab,
  rotateCellsCW,
  rotatedShape,
  rotationLevels,
  sameCell,
} from './geometry';

const L: Cell[] = [
  { col: 0, row: 0 },
  { col: 0, row: 1 },
  { col: 1, row: 1 },
];

const itemL: ItemDef = { id: 'T', name: 'L', hue: 100, shape: L };

describe('形状旋转几何', () => {
  it('顺时针 90° 映射符合 (col,row)->(h-1-row,col)', () => {
    expect(rotateCellsCW(L)).toEqual([
      { col: 0, row: 0 },
      { col: 1, row: 0 },
      { col: 0, row: 1 },
    ]);
  });

  it('四次旋转还原且占格集合完全一致(逐格核对, 非只比长度)', () => {
    let s = normalize(L);
    const snapshots: Cell[][] = [];
    for (let i = 0; i < 4; i++) {
      snapshots.push(s);
      s = rotateCellsCW(s);
    }
    expect(s).toEqual(L);
    // 四个朝向的占格数始终相同
    for (const snap of snapshots) expect(snap.length).toBe(3);
    // 180° 的具体坐标
    expect(rotatedShape(L, 2)).toEqual([
      { col: 0, row: 0 },
      { col: 1, row: 0 },
      { col: 1, row: 1 },
    ]);
  });

  it('L 形四个旋转层级形状互不相同且都归一化(贴左上角)', () => {
    const levels = rotationLevels(L);
    const json = levels.map((l) => JSON.stringify(l));
    expect(new Set(json).size).toBe(4);
    for (const l of levels) {
      expect(l).toEqual(normalize(l));
    }
  });

  it('渲染格与基础格双向映射稳定: 每个物理格在每个朝向下往返一致', () => {
    for (let r = 0; r < 4; r++) {
      for (const base of L) {
        const rendered = renderedRelOf(L, r as 0 | 1 | 2 | 3, base);
        const back = baseCellFromRendered(L, r as 0 | 1 | 2 | 3, rendered);
        expect(back).toEqual(base);
      }
    }
  });

  it('旋转时抓取的物理格全局网格位置保持不动(预览不跳到另一侧)', () => {
    const baseGrab = { col: 0, row: 1 };
    const placement = {
      itemId: 'T',
      bagId: 'a',
      anchor: { col: 2, row: 3 },
      rotation: 0 as const,
    };
    const before = renderedRelOf(L, 0, baseGrab);
    const grabGlobalBefore = {
      col: placement.anchor.col + before.col,
      row: placement.anchor.row + before.row,
    };
    for (const delta of [1, -1] as const) {
      const next = rotateAroundGrab(itemL, placement, baseGrab, delta);
      const afterRel = renderedRelOf(L, next.rotation, baseGrab);
      expect({
        col: next.anchor.col + afterRel.col,
        row: next.anchor.row + afterRel.row,
      }).toEqual(grabGlobalBefore);
    }
  });

  it('连续四次 rotateAroundGrab 后锚点与朝向完全还原', () => {
    const baseGrab = { col: 1, row: 1 };
    let placement: Placement = {
      itemId: 'T',
      bagId: 'a',
      anchor: { col: 4, row: 1 },
      rotation: 0,
    };
    const start = structuredClone(placement);
    for (let i = 0; i < 4; i++) {
      const next = rotateAroundGrab(itemL, placement, baseGrab, 1);
      placement = { ...placement, rotation: next.rotation, anchor: next.anchor };
    }
    expect(placement.rotation).toBe(0);
    expect(sameCell(placement.anchor, start.anchor)).toBe(true);
  });

  it('occupiedCells 给出实际占用的全局格', () => {
    const cells = occupiedCells(itemL, {
      itemId: 'T',
      bagId: 'a',
      anchor: { col: 5, row: 6 },
      rotation: 0,
    });
    expect(cells).toEqual([
      { col: 5, row: 6 },
      { col: 5, row: 7 },
      { col: 6, row: 7 },
    ]);
  });
});
