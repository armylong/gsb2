// 群岛潮汐传送 —— 世界数据：四个岛、门规则、两个内置题面
//
// 门规则约定：
//   每扇门分别给出 tide(潮) / ebb(汐) 下的规则，null = 该卡面下门不接受通行
//   oneWay + 对侧 sealed：只能从正面顺向通过，背面封死，不能原路返回
//   flip=true：通过这扇门时潮汐卡翻面
//
// 关键结构（自检会逐条断言，见 src/selfcheck.ts）：
//   - 进入章岛(I3)的唯一入口是东潮门 A2 的【汐】规则，且该规则翻卡
//   - 晨港(I1)没有潮钟，想在晨港拿到汐面，必须经钟鸣屿(I2)的翻卡门回来
//   - 于是最短路线也恰好翻卡两次，潮钟的免费换面无法替代任何一次
//   - 花澜礁(I4)所有门封死，是只进不出的单向死胡同

import type { Gate, Island, Puzzle, Side, Dir } from './types.js';

function gate(
  islandId: string,
  id: string,
  name: string,
  dir: Dir,
  x: number,
  y: number,
  opts: {
    sealed?: boolean;
    oneWay?: boolean;
    tide?: Gate['tide'];
    ebb?: Gate['ebb'];
  } = {}
): Gate {
  return {
    id,
    islandId,
    name,
    dir,
    x,
    y,
    sealed: opts.sealed ?? false,
    oneWay: opts.oneWay ?? false,
    tide: opts.tide ?? null,
    ebb: opts.ebb ?? null,
  };
}

function r(
  toIsland: string,
  toGate: string,
  flip: boolean
): { toIsland: string; toGate: string; flip: boolean } {
  return { toIsland, toGate, flip };
}

export const ISLANDS: Island[] = [
  {
    id: 'I1',
    name: '晨港',
    subtitle: '起点岛',
    hasClock: false,
    hasMedal: false,
    cx: 250,
    cy: 250,
    radius: 125,
    gates: [
      // 单向门：两态都送到花澜礁 D1（封死背面），只许出去、不能原路返回
      gate('I1', 'A1', '北礁门', 'N', 250, 145, {
        oneWay: true,
        tide: r('I4', 'D1', false),
        ebb: r('I4', 'D1', false),
      }),
      // 同一入口两态去不同地方：潮→钟鸣屿（翻卡）；汐→章岛（翻卡，进章岛唯一入口）
      gate('I1', 'A2', '东潮门', 'E', 355, 250, {
        tide: r('I2', 'B1', true),
        ebb: r('I3', 'C1', true),
      }),
      // 汐面下封港：只有潮面能出门
      gate('I1', 'A3', '西汐门', 'W', 145, 250, {
        tide: r('I2', 'B1', false),
        ebb: null,
      }),
    ],
  },
  {
    id: 'I2',
    name: '钟鸣屿',
    subtitle: '潮钟岛 · 可重选卡面',
    hasClock: true,
    hasMedal: false,
    cx: 880,
    cy: 240,
    radius: 125,
    gates: [
      // 回晨港一律翻卡：潮钟只能在本岛换面，替不掉这次翻卡
      gate('I2', 'B1', '西钟门', 'W', 775, 240, {
        tide: r('I1', 'A3', true),
        ebb: r('I1', 'A3', true),
      }),
      gate('I2', 'B2', '南钟门', 'S', 880, 345, {
        tide: r('I1', 'A2', true),
        ebb: r('I1', 'A2', true),
      }),
    ],
  },
  {
    id: 'I3',
    name: '章岛',
    subtitle: '纪念章所在',
    hasClock: false,
    hasMedal: true,
    cx: 870,
    cy: 590,
    radius: 115,
    gates: [
      // 由 A2 汐面翻卡送达；本身也可出门回钟鸣屿（不翻卡）
      gate('I3', 'C1', '北章门', 'N', 870, 495, {
        tide: r('I2', 'B2', false),
        ebb: r('I2', 'B2', false),
      }),
      // 回晨港的归程门（不翻卡），保证章岛不是死胡同
      gate('I3', 'C2', '西归门', 'W', 775, 590, {
        tide: r('I1', 'A3', false),
        ebb: r('I1', 'A3', false),
      }),
    ],
  },
  {
    id: 'I4',
    name: '花澜礁',
    subtitle: '单向死胡同',
    hasClock: false,
    hasMedal: false,
    cx: 250,
    cy: 590,
    radius: 105,
    gates: [
      // A1 顺向通过后的背面落点：封死，不能原路返回
      gate('I4', 'D1', '北礁门·背面', 'N', 250, 505, { sealed: true }),
      gate('I4', 'D2', '东栏', 'E', 335, 590, { sealed: true }),
      gate('I4', 'D3', '南栏', 'S', 250, 675, { sealed: true }),
    ],
  },
];

export const PUZZLES: Puzzle[] = [
  {
    id: 'P1',
    title: '题面一 · 两次翻卡取纪念章',
    brief:
      '从晨港持【潮】出发，到章岛取下纪念章。进章岛的唯一入口本身要翻一次卡，而在晨港凑出汐面还得先去钟鸣屿翻一次卡——任何路线至少翻卡两次，潮钟只能换面，代替不了它们。',
    startIsland: 'I1',
    startSide: 'tide',
    goalIsland: 'I3',
    goalIsMedal: true,
  },
  {
    id: 'P2',
    title: '题面二 · 单向死胡同',
    brief:
      '试着从晨港的北礁门顺向出去。花澜礁看似与晨港相连，但那扇门只许出去——落点是封死的门背面，到达后亲自确认还回不回得来。',
    startIsland: 'I1',
    startSide: 'tide',
    goalIsland: 'I4',
    goalIsMedal: false,
  },
];

export const SIDE_NAME: Record<Side, string> = {
  tide: '潮',
  ebb: '汐',
};

export const DIR_NAME: Record<Dir, string> = {
  N: '北',
  E: '东',
  S: '南',
  W: '西',
};

/** 进门后朝向 = 门朝向的反方向（从门口朝岛内看） */
export function oppositeDir(d: Dir): Dir {
  return d === 'N' ? 'S' : d === 'S' ? 'N' : d === 'E' ? 'W' : 'E';
}

export function findIsland(id: string): Island {
  const island = ISLANDS.find((it) => it.id === id);
  if (!island) throw new Error(`未知岛屿: ${id}`);
  return island;
}

export function findGate(islandId: string, gateId: string): Gate {
  const island = findIsland(islandId);
  const g = island.gates.find((it) => it.id === gateId);
  if (!g) throw new Error(`未知门: ${islandId}/${gateId}`);
  return g;
}
