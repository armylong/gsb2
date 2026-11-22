/**
 * 演示场景。世界坐标 y 向下，设计尺寸 1280×760（渲染时等比缩放）。
 */
import { v } from './math.js';
import { ObstacleDef } from './rope.js';

export interface Scenario {
  id: string;
  name: string;
  summary: string;
  world: { w: number; h: number };
  anchor: { x: number; y: number };
  ropeLength: number;
  start: { pos: { x: number; y: number }; vel: { x: number; y: number } };
  radius: number;
  obstacles: ObstacleDef[];
  hint?: string;
}

const stone = '#33465a';
const slab = '#3b5068';
const ground = '#22303d';

export const SCENARIOS: Scenario[] = [
  {
    id: 'double-wrap',
    name: '样例 A · 连续绕过两个拐角再返回',
    summary:
      '锚点在上方，角色从右下起摆。绳先绕过立柱右上角，再绕过横梁左下角；两段长度都按真实折线累计。摆回时两个拐点依次解开，再反向摆回会重新绕上。',
    world: { w: 1280, h: 760 },
    anchor: { x: 480, y: 100 },
    ropeLength: 560,
    start: { pos: { x: 820, y: 520 }, vel: { x: 300, y: 0 } },
    radius: 16,
    obstacles: [
      {
        id: 'pillar',
        label: '立柱',
        points: [v(560, 200), v(616, 200), v(616, 390), v(560, 390)],
        vertexLabels: ['左上', '右上', '右下', '左下'],
        tint: stone,
      },
      {
        id: 'beam',
        label: '横梁',
        points: [v(640, 310), v(900, 310), v(900, 364), v(640, 364)],
        vertexLabels: ['左上', '右上', '右下', '左下'],
        tint: slab,
      },
      {
        id: 'floor',
        label: '地面',
        points: [v(-400, 700), v(1680, 700), v(1680, 900), v(-400, 900)],
        vertexLabels: ['左端', '右端', '右下', '左下'],
        tint: ground,
      },
    ],
    hint: '绳先绕过立柱右上角，再绕过横梁左下角；摆回左侧时两个拐点依次解开，再摆回来会重新绕上。点“逐步”可逐帧看每段长度；抬锚点可改变摆幅。',
  },
  {
    id: 'near-corner',
    name: '样例 B · 几乎贴角但不该绕',
    summary:
      '角色贴着立柱左上角外侧摆过，绳与角最近只有约 4px；直线始终可见，因此全程不产生拐点，绳长也保持为锚点到角色的直线距离。',
    world: { w: 1280, h: 760 },
    anchor: { x: 400, y: 120 },
    ropeLength: 420,
    start: { pos: { x: 780, y: 297 }, vel: { x: 0, y: 0 } },
    radius: 15,
    obstacles: [
      {
        id: 'pillar',
        label: '近角立柱',
        points: [v(572, 148), v(622, 148), v(622, 198), v(572, 198)],
        vertexLabels: ['左上', '右上', '右下', '左下'],
        tint: stone,
      },
      {
        id: 'floor',
        label: '地面',
        points: [v(-400, 700), v(1680, 700), v(1680, 900), v(-400, 900)],
        vertexLabels: ['左端', '右端', '右下', '左下'],
        tint: ground,
      },
    ],
    hint: '绳与立柱右上角最近只有约 2px，但始终没有碰到，所以全程“拐点 0”、实际折线 = 直线距离。',
  },
  {
    id: 'free',
    name: '自由场景 · 收放绳长与受限',
    summary:
      '单锚点 + 圆形角色 + 多边形障碍。初始绳有明显松弛，角色会先自由掉落再绷紧；按住“收绳”可看到可用绳长不足时的原因与状态保留。',
    world: { w: 1280, h: 760 },
    anchor: { x: 360, y: 120 },
    ropeLength: 620,
    start: { pos: { x: 700, y: 520 }, vel: { x: 0, y: 0 } },
    radius: 18,
    obstacles: [
      {
        id: 'block',
        label: '石块',
        points: [v(470, 300), v(560, 320), v(540, 430), v(460, 410)],
        vertexLabels: ['角1', '角2', '角3', '角4'],
        tint: stone,
      },
      {
        id: 'shelf',
        label: '平台',
        points: [v(680, 470), v(860, 470), v(860, 510), v(680, 510)],
        vertexLabels: ['左端', '右端', '角3', '角4'],
        tint: slab,
      },
      {
        id: 'floor',
        label: '地面',
        points: [v(-400, 700), v(1680, 700), v(1680, 900), v(-400, 900)],
        vertexLabels: ['左端', '右端', '右下', '左下'],
        tint: ground,
      },
    ],
    hint: '按住“收绳”不放，观察右下角原因栏；松开后状态仍是上一步的有效状态。',
  },
];

export function getScenario(id: string): Scenario {
  return SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0];
}
