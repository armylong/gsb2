// 两个内置观察场景:前哨被切断 / 同时进入争夺区
import { Game } from './engine.ts';

export interface Scenario {
  id: string;
  name: string;
  description: string;
  game: Game;
  /** 每回合开赛前自动执行的单位移动:[单位id, x, y][] */
  script: Array<Array<[string, number, number]>>;
}

/** 场景一:A靠前哨辐射争夺区;B 的 b2 绕后切断补给走廊,前哨断供后控制值反转 */
export function scenarioCutoff(): Scenario {
  const g = new Game(14, 10);
  // 阻断区(山地,不可通行)
  for (const [x, y] of [[3, 2], [6, 2], [9, 2], [3, 8], [10, 8], [7, 0]] as const) {
    g.addCell({ x, y, kind: 'blocked', owner: null, zone: null });
  }
  g.addCell({ x: 1, y: 5, kind: 'camp', owner: 'A', zone: null });
  g.addCell({ x: 7, y: 5, kind: 'outpost', owner: 'A', zone: null });
  g.addCell({ x: 13, y: 5, kind: 'camp', owner: 'B', zone: null });
  // 争夺区 Z1
  for (let x = 8; x <= 10; x++) {
    for (let y = 4; y <= 6; y++) g.addCell({ x, y, kind: 'contested', owner: null, zone: 'Z1' });
  }
  // A 的补给走廊(预先标记)
  for (let x = 2; x <= 6; x++) g.mark('A', x, 5);

  g.addUnit({ id: 'a1', faction: 'A', x: 6, y: 4 });
  g.addUnit({ id: 'b1', faction: 'B', x: 12, y: 5 });
  g.addUnit({ id: 'b2', faction: 'B', x: 4, y: 0 });

  return {
    id: 'cutoff',
    name: '场景一:前哨被切断',
    description:
      'A 的补给走廊(2,5)-(6,5)连通营地与前哨,前哨权重 3 主导 Z1。' +
      'B 的 b2 用 5 个回合绕到 (4,5) 站上走廊,切断补给;前哨权重降为 1 后控制值反转,' +
      '观察 B 连续两回合领先后的占领时间点。',
    game: g,
    script: [
      [['b1', 11, 5], ['b2', 4, 1]],
      [['b2', 4, 2]],
      [['b2', 4, 3]],
      [['b2', 4, 4]],
      [['b2', 4, 5]], // ← 切断点:站上 A 的补给走廊
      [],
      [],
    ],
  };
}

/** 场景二:两方同一回合进入争夺区,控制值持平触发平局保留 */
export function scenarioSimultaneous(): Scenario {
  const g = new Game(14, 10);
  for (const [x, y] of [[5, 1], [8, 1], [5, 8], [8, 8]] as const) {
    g.addCell({ x, y, kind: 'blocked', owner: null, zone: null });
  }
  g.addCell({ x: 1, y: 5, kind: 'camp', owner: 'A', zone: null });
  g.addCell({ x: 13, y: 5, kind: 'camp', owner: 'B', zone: null });
  for (let x = 6; x <= 8; x++) {
    for (let y = 4; y <= 6; y++) g.addCell({ x, y, kind: 'contested', owner: null, zone: 'Z2' });
  }
  g.addUnit({ id: 'a1', faction: 'A', x: 4, y: 5 });
  g.addUnit({ id: 'b1', faction: 'B', x: 10, y: 5 });

  return {
    id: 'simultaneous',
    name: '场景二:同时进入争夺区',
    description:
      '第 1 回合 a1 与 b1 对称地同时逼近 Z2,双方贡献完全相等,控制值为 0,' +
      '触发平局保留(无人占领,进度清零)。第 2 回合 a1 再进一步取得领先,' +
      '观察从平局到 A 连续两回合领先的占领时间点。',
    game: g,
    script: [
      [['a1', 5, 5], ['b1', 9, 5]], // 同时进入,贡献对称 → 平局
      [['a1', 6, 5]],               // A 深入一步,B 按兵不动
      [],
    ],
  };
}

export const SCENARIOS = [scenarioCutoff, scenarioSimultaneous];
