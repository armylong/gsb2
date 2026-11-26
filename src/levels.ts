import type { Level } from './types';

const outerWalls = [
  { x: 0, y: 0, w: 1000, h: 20, name: '北墙' },
  { x: 0, y: 620, w: 1000, h: 20, name: '南墙' },
  { x: 0, y: 0, w: 20, h: 640, name: '西墙' },
  { x: 980, y: 0, w: 20, h: 640, name: '东墙' },
];

export const LEVELS: Level[] = [
  {
    id: 'right-angle',
    name: '第一关 · 直角回廊',
    brief: '把长画框抬进右上方的竖向画框架。拖动一人会以另一人为支点转动；拖画框中段可整体平移。',
    walls: [
      ...outerWalls,
      { x: 20, y: 20, w: 655, h: 390, name: '回廊内墙' },
      { x: 845, y: 20, w: 135, h: 390, name: '右侧墙垛' },
    ],
    pads: [
      { id: 'pad-1', x: 55, y: 438, w: 250, h: 144, label: '起点驿站' },
      { id: 'pad-1-corner', x: 735, y: 348, w: 110, h: 236, label: '转角暂放台' },
    ],
    goal: { x: 720, y: 70, w: 80, h: 150, angle: Math.PI / 2, label: '竖向画框架' },
    start: { h0: { x: 80, y: 510 }, h1: { x: 260, y: 510 } },
    demo: [
      { t: 'ground', say: '先在绿色虚线驿站放下画框；不合规的放手会被直接拒绝。' },
      { t: 'pickup', say: '人和画框都站稳后，可以重新拿起。' },
      { t: 'translate', dx: 565, dy: 45, say: '整体平移到拐角外侧，给长画框留出回转半径。' },
      { t: 'pivot', who: 0, delta: Math.PI / 2, say: '以右端搬运工为支点，把左端向上转入竖廊。' },
      { t: 'translate', dx: -65, dy: -320, say: '保持竖直，平移进入画框架。' },
    ],
    trap: {
      t: 'pivot',
      who: 0,
      delta: Math.PI / 2,
      expectSubject: 'porter0',
      label: '从起点直接把左端向上甩半圈',
    },
  },
  {
    id: 'switchback',
    name: '第二关 · 折返窄廊',
    brief: '穿过两次拐弯进入左下横向画框架。折返隔墙的端头不能一把转过：先转小半圈送过一端，下沉错位后再继续转正。',
    walls: [
      ...outerWalls,
      { x: 20, y: 230, w: 620, h: 200, name: '折返隔墙' },
      { x: 20, y: 430, w: 150, h: 190, name: '南端墙垛' },
      { x: 400, y: 50, w: 24, h: 66, name: '细立柱' },
    ],
    pads: [{ id: 'pad-2', x: 50, y: 55, w: 300, h: 150, label: '换手驿站' }],
    goal: { x: 250, y: 480, w: 170, h: 70, angle: 0, label: '横向画框架' },
    start: { h0: { x: 110, y: 130 }, h1: { x: 290, y: 130 } },
    demo: [
      { t: 'ground', say: '在换手驿站落地，准备让两人沿画框两侧绕行。' },
      { t: 'walk', who: 0, to: { x: 110, y: 86 }, say: '蓝衣工从上方绕向左端外侧。' },
      { t: 'walk', who: 0, to: { x: 290, y: 86 }, say: '蓝衣工先走到右端上方等候。' },
      { t: 'walk', who: 1, to: { x: 290, y: 174 }, say: '橙衣工从下方绕向右端外侧。' },
      { t: 'walk', who: 1, to: { x: 110, y: 174 }, say: '橙衣工沿下侧走到左端。' },
      { t: 'walk', who: 1, to: { x: 110, y: 130 }, say: '橙衣工握住左把手。' },
      { t: 'walk', who: 0, to: { x: 290, y: 130 }, say: '蓝衣工握住右把手，完成换边。' },
      { t: 'pickup', say: '两人分别靠近不同把手后，交换把手并抬起。' },
      { t: 'translate', dx: 545, dy: 45, say: '平移到右侧拐角。' },
      { t: 'pivot', who: 1, delta: -Math.PI / 2, say: '以右端为支点，把左端向下转入竖廊。' },
      { t: 'translate', dx: -55, dy: 180, say: '斜向错位到折返隔墙端头前。' },
      { t: 'pivot', who: 0, delta: -0.75, say: '先转过小半程，让上端绕过隔墙端头。' },
      { t: 'translate', dx: 0, dy: 45, say: '整体下沉，把已过来的一端送入底廊。' },
      { t: 'pivot', who: 0, delta: -Math.PI / 2 + 0.75, say: '继续转完剩余角度，摆成横向。' },
      { t: 'translate', dx: -355, dy: -65, say: '向左平移，完整进入横向画框架。' },
    ],
    trap: {
      t: 'translate',
      dx: 360,
      dy: -30,
      expectSubject: 'porter1',
      label: '从起点斜向长拖，穿过走廊里的细立柱',
    },
  },
];
