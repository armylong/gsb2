import { Body, Params, Rect, Segment } from './physics';

export interface Scenario {
  id: string;
  name: string;
  desc: string;
  params: Omit<Params, 'dt'>;
  obstacles: Rect[];   // 不含地面,地面由 ground 统一生成
  start: Body;
  plan: Segment[];     // 以 60Hz 为基准的输入计划(跨频率验证时按 hz/60 缩放)
  expect: {
    first: 'land' | 'ceiling';   // 期望的首次事件类型
    landOn?: Rect;               // 期望落点所在的矩形(落点需在其顶面附近)
  };
}

export const CANVAS_W = 960;
export const CANVAS_H = 540;
export const GROUND: Rect = { x: 0, y: 500, w: CANVAS_W, h: 40 };

const BASE_PARAMS: Omit<Params, 'dt'> = {
  gravity: 1500,
  jumpVel: 680,
  airAccel: 2000,
  maxAirSpeed: 260,
  groundFriction: 2400,
  airDrag: 200,
};

const mkStart = (x: number, y: number): Body => ({ x, y, w: 28, h: 32, vx: 0, vy: 0, grounded: true });

export const SCENARIOS: Scenario[] = [
  {
    id: 'platform-landing',
    name: '高台落地',
    desc: '起跳后按住右,落在高台顶面',
    params: { ...BASE_PARAMS },
    obstacles: [{ x: 220, y: 400, w: 180, h: 20 }],
    start: mkStart(60, 500 - 32),
    plan: [
      { ticks: 14, move: 1, jump: true },
      { ticks: 40, move: 1, jump: false },
    ],
    expect: { first: 'land', landOn: { x: 220, y: 400, w: 180, h: 20 } },
  },
  {
    id: 'ceiling-hit',
    name: '撞顶',
    desc: '头顶有障碍物,原地起跳撞到下沿后落回地面',
    params: { ...BASE_PARAMS },
    obstacles: [{ x: 180, y: 300, w: 220, h: 30 }],
    start: mkStart(280, 500 - 32),
    plan: [
      { ticks: 1, move: 0, jump: true },
      { ticks: 80, move: 0, jump: false },
    ],
    expect: { first: 'ceiling' },
  },
  {
    id: 'fall-from-height',
    name: '从高处下落',
    desc: '从高台边走下,自由落体到地面',
    params: { ...BASE_PARAMS },
    obstacles: [{ x: 80, y: 200, w: 150, h: 20 }],
    start: mkStart(120, 200 - 32),
    plan: [
      { ticks: 30, move: 1, jump: false },
      { ticks: 70, move: 0, jump: false },
    ],
    expect: { first: 'land', landOn: GROUND },
  },
];
