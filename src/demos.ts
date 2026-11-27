/**
 * Built-in demo windows. Each one is sized in millimetres and chosen to make a
 * specific property checkable: exact division, a notch that splits one id into
 * two disconnected pieces, and a pane with no territory plus a point sitting
 * almost on the outer edge.
 */

import { makeNotchFrame, makeRectFrame } from './geometry';
import type { FrameSpec, PointSpec } from './types';

export interface Demo {
  id: 'equal' | 'notch' | 'empty';
  name: string;
  tagline: string;
  frame: FrameSpec;
  points: PointSpec[];
  /** Optional weight the demo nudges when you press "加大分量演示". */
  featuredId: number;
}

export const DEMOS: Demo[] = [
  {
    id: 'equal',
    name: '等分',
    tagline: '6 个等权点把 240 × 160 mm 的矩形切成 6 块 6400 mm² 的等面积玻璃。',
    frame: makeRectFrame(240, 160),
    points: [
      { id: 1, x: 40, y: 40, weight: 0 },
      { id: 2, x: 120, y: 40, weight: 0 },
      { id: 3, x: 200, y: 40, weight: 0 },
      { id: 4, x: 40, y: 120, weight: 0 },
      { id: 5, x: 120, y: 120, weight: 0 },
      { id: 6, x: 200, y: 120, weight: 0 },
    ],
    featuredId: 5,
  },
  {
    id: 'notch',
    name: '凹口分片',
    tagline:
      'U 形外框：下方缺口宽 60、深 150 mm。#1 的地盘从桥顶跨过缺口、同时伸进左右两条腿，被缺口截成两片（约 11700 / 8900 mm²），两片同编号同颜色，轮廓不跨越缺口。',
    frame: makeNotchFrame(240, 220, { side: 'bottom', start: 90, end: 150, depth: 150 }),
    points: [
      { id: 1, x: 80, y: 170, weight: 18000 },
      { id: 2, x: 40, y: 30, weight: 14000 },
      { id: 3, x: 200, y: 150, weight: 2000 },
    ],
    featuredId: 3,
  },
  {
    id: 'empty',
    name: '有空编号',
    tagline:
      '#3 被左右两块高分量玻璃夹得一点地盘都没有；#7 几乎落在外框右边缘，用来检查接缝附近归属显示的稳定性。',
    frame: makeRectFrame(220, 160),
    points: [
      { id: 1, x: 55, y: 80, weight: 2500 },
      { id: 2, x: 110, y: 80, weight: 2500 },
      { id: 3, x: 80, y: 80, weight: 0 },
      { id: 4, x: 165, y: 60, weight: 0 },
      { id: 5, x: 165, y: 120, weight: 0 },
      { id: 6, x: 30, y: 25, weight: 0 },
      { id: 7, x: 219.2, y: 78, weight: 0 },
    ],
    featuredId: 3,
  },
];

export function demoById(id: Demo['id']): Demo {
  return DEMOS.find((d) => d.id === id) ?? DEMOS[0]!;
}

export function cloneDemo(demo: Demo): { frame: FrameSpec; points: PointSpec[] } {
  return {
    frame: {
      ...demo.frame,
      ring: demo.frame.ring.map((p) => ({ ...p })),
      ...(demo.frame.notch ? { notch: { ...demo.frame.notch } } : {}),
    },
    points: demo.points.map((p) => ({ ...p })),
  };
}
