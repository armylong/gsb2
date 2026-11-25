import type { Book, Cart, Dir, Pos, Scenario, Table } from './types.ts';

const p = (x: number, y: number): Pos => ({ x, y });

/** 沿一堵横向墙留一个缺口 */
function wallRow(y: number, width: number, gapX: number): Pos[] {
  const cells: Pos[] = [];
  for (let x = 0; x < width; x++) {
    if (x !== gapX) cells.push(p(x, y));
  }
  return cells;
}

/**
 * 摆位一：单口让路
 * 9×7 地图，y=3 一道墙只留缺口 (4,3)。
 * 红书在北半区 (0,1)，红台面在西北角 (0,0)；红车 A 从南半区 (1,4) 出发。
 * 蓝书在南半区 (8,5)，蓝台面在东南角 (8,6)；蓝车 B 从北半区 (4,1) 出发。
 * 两车的路线在开放格 (4,4) 垂直交汇：默认红车在 (3,4) 留一拍 W，蓝车先过；
 * 删掉这个 W，两车第 3 拍同时移动进 (4,4)，按规则双双被挡住，下一拍仍可继续。
 * （节拍由 test/engine.test.ts 逐拍校验）
 */
function yieldScenario(): Scenario {
  const width = 9;
  const height = 7;

  const tables: Table[] = [
    { id: 'red-shelf', pos: p(0, 0), acceptColor: 'red' },
    { id: 'blue-shelf', pos: p(8, 6), acceptColor: 'blue' },
    { id: 'red-desk', pos: p(0, 1), acceptColor: null },
    { id: 'blue-desk', pos: p(8, 5), acceptColor: null },
  ];

  const carts: Cart[] = [
    { id: 'A', label: '红车 A', color: 'red', pos: p(1, 4), dir: 1, carrying: null },
    { id: 'B', label: '蓝车 B', color: 'blue', pos: p(4, 1), dir: 2, carrying: null },
  ];

  const books: Book[] = [
    { id: 'book-red', color: 'red', tableId: 'red-desk', cartId: null },
    { id: 'book-blue', color: 'blue', tableId: 'blue-desk', cartId: null },
  ];

  // 红车 A：东行到缺口南侧，第 3 拍 W 让路，北上取红书，再放进西北角红台面
  const programA: Scenario['defaultPrograms'][string] = [
    'F', 'F', 'W', 'F',      // 1-4: (1,4)→(3,4) 等一拍 →(4,4)
    'L',                     // 5: 面朝北
    'F', 'F', 'F',           // 6-8: (4,4)→(4,1) 穿过缺口
    'L',                     // 9: 面朝西
    'F', 'F', 'F', 'F',      // 10-13: (4,1)→(0,1) red-desk
    'PICK',                  // 14: 拿红书
    'R',                     // 15: 面朝北
    'F',                     // 16: →(0,0)
    'DROP',                  // 17: 放进红台面
  ];

  // 蓝车 B：径直南下穿过缺口，东行取蓝书，放进东南角蓝台面
  const programB: Scenario['defaultPrograms'][string] = [
    'F', 'F', 'F', 'F',      // 1-4: (4,1)→(4,5)，第 3 拍经过 (4,4)
    'L',                     // 5: 面朝东
    'F', 'F', 'F', 'F',      // 6-9: (4,5)→(8,5) blue-desk
    'PICK',                  // 10: 拿蓝书
    'R',                     // 11: 面朝南
    'F',                     // 12: →(8,6)
    'DROP',                  // 13: 放进蓝台面
  ];

  return {
    id: 'yield',
    name: '摆位一 · 单口让路',
    description: '墙只留一个缺口，两车路线在 (4,4) 垂直交汇。红车默认第 3 拍在 (3,4) 等一下。',
    width,
    height,
    walls: wallRow(3, width, 4),
    tables,
    carts,
    books,
    defaultPrograms: { A: programA, B: programB },
    hint: '点「删掉红车的等待拍」：第 3 拍两车同时移动进 (4,4)，按规则双双阻挡；第 4 拍起仍能继续行动。',
  };
}

/**
 * 摆位二：同拍抢书
 * 7×5 无障碍小图，中央台面 (3,2) 放一本红书。
 * 红车 A 起点 (1,2) 朝东，蓝车 B 起点 (3,0) 朝南（台面正上方两格）。
 * 第 3 拍两车同时移动进台面格 (3,2) → 同拍抢同一格，按规则双双阻挡（谁都没碰到书）。
 * 第 4 拍 B 等待、A 先进台面并站住；第 5 拍 B 南下并入台面（台面是可共享工位，允许并入静止车辆），
 * 两车同格、书仍在桌上；第 6 拍两车同拍 PICK 同一本书，按 A→B 明示顺序仲裁：A 成功、B 失败。
 * B 之后空手放书也失败，但移动类指令照常；A 独立把书送进红台面过关。
 */
function contentionScenario(): Scenario {
  const width = 7;
  const height = 5;

  const tables: Table[] = [
    { id: 'center-desk', pos: p(3, 2), acceptColor: null },
    { id: 'red-shelf', pos: p(6, 0), acceptColor: 'red' },
  ];

  const carts: Cart[] = [
    { id: 'A', label: '红车 A', color: 'red', pos: p(1, 2), dir: 1, carrying: null },
    { id: 'B', label: '蓝车 B', color: 'blue', pos: p(3, 0), dir: 2, carrying: null },
  ];

  const books: Book[] = [
    { id: 'book-red', color: 'red', tableId: 'center-desk', cartId: null },
  ];

  const programA: Scenario['defaultPrograms'][string] = [
    'F',                     // 1: →(2,2)，台面左侧
    'W',                     // 2: 等 B 走到 (3,1)
    'F',                     // 3: 与 B 同拍抢 (3,2)，双双阻挡，仍在 (2,2)
    'F',                     // 4: B 等待，A 进入台面 (3,2)
    'W',                     // 5: 原地等待，B 并入台面同格，书仍在桌上
    'PICK',                  // 6: 同拍争抢，A→B 仲裁，A 拿到红书
    'L', 'L',                // 7-8: 掉头朝西
    'F', 'F',                // 9-10: →(1,2)
    'R',                     // 11: 朝北
    'F', 'F',                // 12-13: →(1,0)
    'R',                     // 14: 朝东（朝北时右转才是东）
    'F', 'F', 'F', 'F', 'F', // 15-19: (1,0)→(6,0)
    'DROP',                  // 20: 放进红台面，过关
  ];

  const programB: Scenario['defaultPrograms'][string] = [
    'F',                     // 1: →(3,1)，台面正上方
    'W',                     // 2: 与 A 对齐节奏
    'F',                     // 3: 南下抢 (3,2)，与 A 双双阻挡，仍在 (3,1)
    'W',                     // 4: 让 A 先进台面
    'F',                     // 5: 并入台面 (3,2) 与 A 同格（台面共享，A 静止不挡）
    'PICK',                  // 6: 同拍伸手，A→B 仲裁，书归 A，B 失败
    'DROP',                  // 7: 车箱空，放书失败
    'R', 'R',                // 8-9: 掉头朝北
    'F',                     // 10: →(3,1)，失败后移动照常
    'R',                     // 11: 朝东
    'F', 'F', 'F',           // 12-14: →(6,1)
  ];

  return {
    id: 'contention',
    name: '摆位二 · 同拍抢书',
    description: '第 3 拍同抢台面格双双阻挡；第 6 拍两车在台面同格同时对同一本书伸手，A→B 仲裁。',
    width,
    height,
    walls: [],
    tables,
    carts,
    books,
    defaultPrograms: { A: programA, B: programB },
    hint: '第 3 拍看同格阻挡（两车都没动）；第 5 拍 B 并入台面同格；第 6 拍同时 PICK，A 按 A→B 顺序拿到书、B 失败；第 7 拍 B 空手放书也失败，第 10 拍起移动照常。',
  };
}

export function getScenarios(): Scenario[] {
  return [yieldScenario(), contentionScenario()];
}

export function dirDelta(dir: Dir): Pos {
  switch (dir) {
    case 0: return p(0, -1);
    case 1: return p(1, 0);
    case 2: return p(0, 1);
    case 3: return p(-1, 0);
  }
}

export function turn(dir: Dir, op: 'L' | 'R'): Dir {
  return (((dir + (op === 'R' ? 1 : -1)) % 4) + 4) % 4 as Dir;
}
