import { LevelDef, ParadeDef, Layout } from './model.js';

const FACING_WATER = -Math.PI / 2;

/** 画布 1100x640:水面 y∈[40,380],岸 y∈[400,620]。 */
export const level: LevelDef = {
  holes: [
    // 前排(离岸最近,易被立柱/导览牌挡,但没人挡你)
    { id: 'h00', pos: { x: 170, y: 445 }, row: 0 },
    { id: 'h01', pos: { x: 335, y: 445 }, row: 0 },
    { id: 'h02', pos: { x: 500, y: 445 }, row: 0 },
    { id: 'h03', pos: { x: 665, y: 445 }, row: 0 },
    { id: 'h04', pos: { x: 830, y: 445 }, row: 0 },
    // 中排
    { id: 'h10', pos: { x: 170, y: 515 }, row: 1 },
    { id: 'h11', pos: { x: 335, y: 515 }, row: 1 },
    { id: 'h12', pos: { x: 500, y: 515 }, row: 1 },
    { id: 'h13', pos: { x: 665, y: 515 }, row: 1 },
    { id: 'h14', pos: { x: 830, y: 515 }, row: 1 },
    // 后排(地基垫高,视线起点高)
    { id: 'h20', pos: { x: 170, y: 585 }, row: 2 },
    { id: 'h21', pos: { x: 335, y: 585 }, row: 2 },
    { id: 'h22', pos: { x: 500, y: 585 }, row: 2 },
    { id: 'h23', pos: { x: 665, y: 585 }, row: 2 },
    { id: 'h24', pos: { x: 830, y: 585 }, row: 2 },
  ],
  pillars: [
    { id: 'p1', pos: { x: 300, y: 402 }, r: 15, height: 2.6 },
    { id: 'p2', pos: { x: 560, y: 398 }, r: 15, height: 3.0 },
    { id: 'p3', pos: { x: 780, y: 404 }, r: 15, height: 2.3 },
  ],
  sign: {
    anchors: [{ x: 420, y: 392 }, { x: 640, y: 388 }, { x: 880, y: 396 }],
    r: 22,
    height: 2.1,
  },
  viewers: [
    { id: 'ama', name: '阿嬷', eyeHeight: 1.25, fovHalf: 1.0, contract: { kind: 'full', boatId: 'big', minRatio: 0.55 } },
    { id: 'xiaohai', name: '小海', eyeHeight: 1.05, fovHalf: 1.1, contract: { kind: 'moments', boatId: 'small', moments: ['A-small-near', 'B-small-return'] } },
    { id: 'laota', name: '老塔', eyeHeight: 1.6, fovHalf: 0.9, contract: { kind: 'full', boatId: 'mid', minRatio: 0.5 } },
    { id: 'ashe', name: '阿摄', eyeHeight: 1.45, fovHalf: 1.3, contract: { kind: 'moments', boatId: 'big', moments: ['A-big-pass', 'B-cross'] } },
    { id: 'apo', name: '阿婆', eyeHeight: 1.15, fovHalf: 1.0, contract: { kind: 'full', boatId: 'small', minRatio: 0.45 } },
    { id: 'adao', name: '阿导', eyeHeight: 1.5, fovHalf: 1.15, contract: { kind: 'moments', boatId: 'mid', moments: ['A-pano', 'B-cross'] } },
  ],
  initialLayout: {
    chairs: [
      { id: 'c1', holeId: 'h02', facing: FACING_WATER, viewerId: 'apo' },
      { id: 'c2', holeId: 'h11', facing: FACING_WATER, viewerId: 'ama' },
      { id: 'c3', holeId: 'h13', facing: FACING_WATER, viewerId: 'laota' },
      { id: 'c4', holeId: 'h20', facing: FACING_WATER, viewerId: 'adao' },
      { id: 'c5', holeId: 'h22', facing: FACING_WATER, viewerId: 'ashe' },
      { id: 'c6', holeId: 'h04', facing: FACING_WATER, viewerId: 'xiaohai' },
    ],
  },
  movesPerIntermission: 3,
};

const boats = [
  { id: 'big', name: '鳌山号(大船)', height: 3.4, speed: 45, color: '#e8b23a' },
  { id: 'mid', name: '鱼灯号(中船)', height: 2.3, speed: 60, color: '#d96a4a' },
  { id: 'small', name: '菱角号(小船)', height: 1.4, speed: 78, color: '#7fb8d9' },
];

const far = [{ x: -60, y: 110 }, { x: 1160, y: 110 }];
const midR = [{ x: -60, y: 225 }, { x: 1160, y: 225 }];
const near = [{ x: -60, y: 338 }, { x: 1160, y: 338 }];

/** 巡游一「港湾灯影」:三轮,航路由远及近,第三轮场中挪导览牌。 */
export const paradeA: ParadeDef = {
  id: 'A',
  name: '港湾灯影',
  boats,
  rounds: [
    {
      name: '第一轮·远道亮灯',
      routes: { big: far, mid: far, small: far },
      signAnchor: 0,
      duration: 30,
      keyMoments: [{ id: 'A-pano', t: 14, label: '三船同框' }],
    },
    {
      name: '第二轮·贴岸穿行',
      routes: { big: near, mid: near, small: near },
      signAnchor: 1,
      duration: 26,
      keyMoments: [{ id: 'A-small-near', t: 9, label: '小船贴岸' }],
    },
    {
      name: '第三轮·绕牌归航',
      routes: { big: midR, mid: midR, small: near },
      signAnchor: 2,
      signMove: { t: 12, anchor: 0 }, // 场中变化:导览牌被搬到另一锚点
      duration: 28,
      keyMoments: [{ id: 'A-big-pass', t: 14, label: '大船过牌' }],
    },
  ],
};

const diag = [{ x: 1160, y: 70 }, { x: 520, y: 250 }, { x: -60, y: 320 }];
const nearRev = [{ x: 1160, y: 345 }, { x: -60, y: 345 }];
const farRev = [{ x: -60, y: 95 }, { x: 1160, y: 95 }];

/** 巡游二「潮汐夜巡」:斜线入场 + 反向回港,航路与导览牌位置全不同。 */
export const paradeB: ParadeDef = {
  id: 'B',
  name: '潮汐夜巡',
  boats,
  rounds: [
    {
      name: '第一轮·斜潮入场',
      routes: { big: diag, mid: diag, small: diag },
      signAnchor: 2,
      duration: 30,
      keyMoments: [{ id: 'B-cross', t: 10, label: '斜穿江心' }],
    },
    {
      name: '第二轮·回港分流',
      routes: { big: farRev, mid: nearRev, small: nearRev },
      signAnchor: 1,
      signMove: { t: 10, anchor: 2 },
      duration: 28,
      keyMoments: [{ id: 'B-small-return', t: 12, label: '小船回港' }],
    },
  ],
};

export const parades: ParadeDef[] = [paradeA, paradeB];

/**
 * 可重复通关布置(由 scripts/solve.ts 搜索验证,test 里也有回归断言)。
 * solutionA 通关巡游一,solutionB 通关巡游二。
 */
export const solutionA: Layout = {
  chairs: [
    { id: 'c1', holeId: 'h21', facing: -1.5708, viewerId: 'ama' },
    { id: 'c2', holeId: 'h10', facing: 0, viewerId: 'xiaohai' },
    { id: 'c3', holeId: 'h24', facing: -2.3562, viewerId: 'laota' },
    { id: 'c4', holeId: 'h14', facing: -1.5708, viewerId: 'ashe' },
    { id: 'c5', holeId: 'h23', facing: -2.3562, viewerId: 'apo' },
    { id: 'c6', holeId: 'h00', facing: 0, viewerId: 'adao' },
  ],
};

export const solutionB: Layout = {
  chairs: [
    { id: 'c1', holeId: 'h20', facing: -0.7854, viewerId: 'ama' },
    { id: 'c2', holeId: 'h24', facing: -3.1416, viewerId: 'xiaohai' },
    { id: 'c3', holeId: 'h23', facing: -2.3562, viewerId: 'laota' },
    { id: 'c4', holeId: 'h04', facing: -1.5708, viewerId: 'ashe' },
    { id: 'c5', holeId: 'h10', facing: -0.7854, viewerId: 'apo' },
    { id: 'c6', holeId: 'h12', facing: -0.7854, viewerId: 'adao' },
  ],
};
