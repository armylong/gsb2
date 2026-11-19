import type { Cell, ItemDef } from './types';

const c = (col: number, row: number): Cell => ({ col, row });

/**
 * 十来件有稳定编号的物品: 长条 / 矩形 / L 形。
 * 形状均为归一化占格; hue 用于程序生成配色。
 */
export const ITEMS: ItemDef[] = [
  { id: 'I01', name: '短条·4格', hue: 8, shape: [c(0, 0), c(1, 0), c(2, 0), c(3, 0)] },
  { id: 'I02', name: '长条·5格', hue: 28, shape: [c(0, 0), c(1, 0), c(2, 0), c(3, 0), c(4, 0)] },
  { id: 'I03', name: '竖条·3格', hue: 48, shape: [c(0, 0), c(0, 1), c(0, 2)] },
  {
    id: 'I04',
    name: '矩形·2x3',
    hue: 95,
    shape: [c(0, 0), c(1, 0), c(0, 1), c(1, 1), c(0, 2), c(1, 2)],
  },
  {
    id: 'I05',
    name: '矩形·3x2',
    hue: 145,
    shape: [c(0, 0), c(1, 0), c(2, 0), c(0, 1), c(1, 1), c(2, 1)],
  },
  {
    id: 'I06',
    name: '方块·2x2',
    hue: 185,
    shape: [c(0, 0), c(1, 0), c(0, 1), c(1, 1)],
  },
  {
    id: 'I07',
    name: 'L形·小3格',
    hue: 215,
    shape: [c(0, 0), c(0, 1), c(1, 1)],
  },
  {
    id: 'I08',
    name: 'L形·3x3缺角',
    hue: 255,
    shape: [c(0, 0), c(0, 1), c(0, 2), c(1, 2), c(2, 2)],
  },
  {
    id: 'I09',
    name: 'L形·瘦高4格',
    hue: 285,
    shape: [c(0, 0), c(0, 1), c(0, 2), c(1, 2)],
  },
  {
    id: 'I10',
    name: 'L形·横卧4格',
    hue: 320,
    shape: [c(0, 0), c(1, 0), c(2, 0), c(2, 1)],
  },
  {
    id: 'I11',
    name: 'L形·3x3互补角',
    hue: 350,
    shape: [c(1, 0), c(2, 0), c(0, 1), c(1, 1), c(2, 1), c(0, 2), c(1, 2), c(2, 2)],
  },
  {
    id: 'I12',
    name: '矩形·1x3',
    hue: 170,
    shape: [c(0, 0), c(1, 0), c(2, 0)],
  },
];

export const ITEM_MAP: Map<string, ItemDef> = new Map(ITEMS.map((i) => [i.id, i]));
