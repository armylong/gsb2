import type { Board, LocationDef, Point, Rect } from './types';

const rect = (x: number, y: number, w = 1, h = 1): Rect => ({ x, y, w, h });

/**
 * 三张盘的水道图（每座岛一条固定下游）：
 *
 *  training  芦苇岛 → 石阶岛 → 老柳岛 → 东岸草坪
 *            沙嘴岛 → 中洲草坪
 *            芦苇岛/石阶岛 被堵时可退到 西岸草坪 / 中洲草坪
 *
 *  marsh     木桩岛 ↘
 *                    窄石岛 → 苇尖岛 → 东滩草坪
 *            蒲团岛 ↗
 *
 *  fork      青石岛 ↘
 *            老柳岛 → 石阶岛 → 沙嘴岛 → 东岸草坪
 *            蒲团岛 ↗
 *            老柳岛 被堵时退到 东岸草坪（与沙嘴岛的下游同一片草）
 *
 * 视觉约定：水道从源岛的岛体里出发（会被岛盖住），箭头停在目标岛的岛缘外，
 * 退路用虚线画在相邻两格之间，绝不穿过第三座岛。
 */

export const trainingBoard: Board = {
  cols: 12,
  rows: 9,
  locations: [
    { id: 'i1', name: '芦苇岛', kind: 'island', rect: rect(1, 1) },
    { id: 'i2', name: '石阶岛', kind: 'island', rect: rect(5, 1) },
    { id: 'i3', name: '老柳岛', kind: 'island', rect: rect(9, 1) },
    { id: 'i4', name: '沙嘴岛', kind: 'island', rect: rect(5, 7) },
    { id: 'l1', name: '东岸草坪', kind: 'lawn', rect: rect(9, 4) },
    { id: 'l2', name: '西岸草坪', kind: 'lawn', rect: rect(1, 4) },
    { id: 'l3', name: '中洲草坪', kind: 'lawn', rect: rect(5, 4) },
  ],
  animals: [
    { id: 'a1', number: 1, name: '小龟', species: 'turtle', color: '#2f7d62', ink: '#0d3b2e' },
    { id: 'a2', number: 2, name: '花鸭', species: 'duck', color: '#d79a2b', ink: '#5d3d00' },
    { id: 'a3', number: 3, name: '锦鲤', species: 'carp', color: '#d4573c', ink: '#6d1d0d' },
    { id: 'a4', number: 4, name: '雨蛙', species: 'frog', color: '#4c7ea8', ink: '#16344c' },
  ],
  outlets: {
    i1: 'i2',
    i2: 'i3',
    i3: 'l1',
    i4: 'l3',
    l1: null,
    l2: null,
    l3: null,
  },
  channels: [
    { from: 'i1', to: 'i2', points: [{ x: 1.6, y: 1.5 }, { x: 5.02, y: 1.5 }] },
    { from: 'i2', to: 'i3', points: [{ x: 5.6, y: 1.5 }, { x: 9.02, y: 1.5 }] },
    { from: 'i3', to: 'l1', points: [{ x: 9.5, y: 1.7 }, { x: 9.5, y: 4.02 }] },
    { from: 'i4', to: 'l3', points: [{ x: 5.5, y: 6.85 }, { x: 5.5, y: 4.48 }] },
  ],
  grassFrom: {
    i1: 'l2',
    i2: 'l3',
    i4: 'l2',
  },
};

/**
 * 纯回推盘：窄石岛有两条上游水道汇入（木桩岛、蒲团岛），反推「谁游进了
 * 窄石岛」时必须在两座上游岛之间二选一；东滩草坪只由苇尖岛的下游到达，
 * 两片草坪只作退路，不与任何水道终点重合，所以每个草坪位置只有一种来路。
 */
export const marshBoard: Board = {
  cols: 12,
  rows: 9,
  locations: [
    { id: 'i1', name: '木桩岛', kind: 'island', rect: rect(1, 1) },
    { id: 'i2', name: '窄石岛', kind: 'island', rect: rect(5, 1) },
    { id: 'i3', name: '苇尖岛', kind: 'island', rect: rect(9, 1) },
    { id: 'i4', name: '蒲团岛', kind: 'island', rect: rect(5, 6) },
    { id: 'l1', name: '东滩草坪', kind: 'lawn', rect: rect(9, 4) },
    { id: 'l2', name: '西洼草坪', kind: 'lawn', rect: rect(1, 4) },
    { id: 'l3', name: '中洲草坪', kind: 'lawn', rect: rect(1, 6) },
  ],
  animals: [
    { id: 'a1', number: 1, name: '小龟', species: 'turtle', color: '#2f7d62', ink: '#0d3b2e' },
    { id: 'a2', number: 2, name: '花鸭', species: 'duck', color: '#d79a2b', ink: '#5d3d00' },
    { id: 'a3', number: 3, name: '锦鲤', species: 'carp', color: '#d4573c', ink: '#6d1d0d' },
    { id: 'a4', number: 4, name: '雨蛙', species: 'frog', color: '#4c7ea8', ink: '#16344c' },
  ],
  outlets: {
    i1: 'i2',
    i2: 'i3',
    i3: 'l1',
    i4: 'i2',
    l1: null,
    l2: null,
    l3: null,
  },
  channels: [
    { from: 'i1', to: 'i2', points: [{ x: 1.6, y: 1.5 }, { x: 5.02, y: 1.5 }] },
    { from: 'i2', to: 'i3', points: [{ x: 5.6, y: 1.5 }, { x: 9.02, y: 1.5 }] },
    { from: 'i3', to: 'l1', points: [{ x: 9.5, y: 1.7 }, { x: 9.5, y: 4.02 }] },
    { from: 'i4', to: 'i2', points: [{ x: 5.5, y: 5.9 }, { x: 5.5, y: 2.02 }] },
  ],
  grassFrom: {
    i1: 'l2',
    i4: 'l3',
  },
};

/**
 * 分叉盘：石阶岛有三个上游（青石岛、老柳岛、蒲团岛）。东岸草坪既是沙嘴岛
 * 的水道终点，又是老柳岛被堵时的退路 —— 终态草坪因此天然有两种解释。
 */
export const forkBoard: Board = {
  cols: 12,
  rows: 9,
  locations: [
    { id: 'i1', name: '青石岛', kind: 'island', rect: rect(1, 1) },
    { id: 'i2', name: '石阶岛', kind: 'island', rect: rect(5, 1) },
    { id: 'i3', name: '老柳岛', kind: 'island', rect: rect(9, 1) },
    { id: 'i4', name: '沙嘴岛', kind: 'island', rect: rect(5, 4) },
    { id: 'i5', name: '蒲团岛', kind: 'island', rect: rect(1, 4) },
    { id: 'l1', name: '西岸草坪', kind: 'lawn', rect: rect(1, 7) },
    { id: 'l2', name: '东岸草坪', kind: 'lawn', rect: rect(9, 4) },
    { id: 'l3', name: '南岸草坪', kind: 'lawn', rect: rect(5, 7) },
  ],
  animals: [
    { id: 'a1', number: 1, name: '小龟', species: 'turtle', color: '#2f7d62', ink: '#0d3b2e' },
    { id: 'a2', number: 2, name: '花鸭', species: 'duck', color: '#d79a2b', ink: '#5d3d00' },
    { id: 'a3', number: 3, name: '锦鲤', species: 'carp', color: '#d4573c', ink: '#6d1d0d' },
    { id: 'a4', number: 4, name: '雨蛙', species: 'frog', color: '#4c7ea8', ink: '#16344c' },
  ],
  outlets: {
    i1: 'i2',
    i2: 'i4',
    i3: 'i2',
    i4: 'l2',
    i5: 'i2',
    l1: null,
    l2: null,
    l3: null,
  },
  channels: [
    { from: 'i1', to: 'i2', points: [{ x: 1.6, y: 1.5 }, { x: 5.02, y: 1.5 }] },
    { from: 'i3', to: 'i2', points: [{ x: 8.4, y: 1.5 }, { x: 5.98, y: 1.5 }] },
    { from: 'i5', to: 'i2', points: [{ x: 1.86, y: 4.28 }, { x: 4.95, y: 2.06 }] },
    { from: 'i2', to: 'i4', points: [{ x: 5.5, y: 1.7 }, { x: 5.5, y: 4.02 }] },
    { from: 'i4', to: 'l2', points: [{ x: 5.6, y: 4.5 }, { x: 9.02, y: 4.5 }] },
  ],
  grassFrom: {
    i3: 'l2',
    i4: 'l3',
    i5: 'l1',
  },
};

export const boards = { training: trainingBoard, fork: forkBoard, marsh: marshBoard };

export const locationAnchor = (loc: LocationDef): Point =>
  loc.anchor ?? { x: loc.rect.x + loc.rect.w / 2, y: loc.rect.y + loc.rect.h / 2 };
