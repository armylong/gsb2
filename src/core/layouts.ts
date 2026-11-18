/**
 * 三组程序生成的布局: 双通道 / 窄门 / 终点被围住。
 * 每个布局的矩形障碍总数(含两扇预设挡门)不超过 12。
 * 门是带 doorId 的特殊矩形: 打开时从障碍集合移除, 关闭时参与膨胀与建网格。
 */
import { Rect, Vec2 } from './geometry';

export interface DoorDef extends Rect {
  doorId: string;
  label: string;
}

export interface StaticObstacle extends Rect {
  /** 暂停时是否允许拖动 */
  movable: boolean;
}

export interface LayoutDef {
  id: string;
  name: string;
  description: string;
  width: number;
  height: number;
  start: Vec2;
  goal: Vec2;
  defaultRadius: number;
  staticObstacles: StaticObstacle[];
  doors: DoorDef[];
  /** 门的初始开合状态 */
  doorsOpen: Record<string, boolean>;
}

export const ROOM_W = 40;
export const ROOM_H = 30;
export const MIN_RADIUS = 0.2;
export const MAX_RADIUS = 0.8;

/** 布局 A: 横向隔墙开上下两个缺口, 每个缺口各有一扇挡门 —— 双通道 */
function dualChannelLayout(): LayoutDef {
  const wallX = 18;
  const wallW = 2;
  const wallTop: StaticObstacle = { x: wallX, y: 0, w: wallW, h: 6, movable: true };
  const wallMid: StaticObstacle = { x: wallX, y: 10, w: wallW, h: 10, movable: true };
  const wallBottom: StaticObstacle = { x: wallX, y: 24, w: wallW, h: 6, movable: true };
  // 上通道缺口 y∈[6,10](高 4), 下通道缺口 y∈[20,24](高 4)
  const doorTop: DoorDef = {
    doorId: 'A-top',
    label: '上门(上通道)',
    x: wallX,
    y: 6,
    w: wallW,
    h: 4,
  };
  const doorBottom: DoorDef = {
    doorId: 'A-bottom',
    label: '下门(下通道)',
    x: wallX,
    y: 20,
    w: wallW,
    h: 4,
  };
  const decor: StaticObstacle[] = [
    { x: 6, y: 20, w: 4, h: 3, movable: true },
    { x: 28, y: 4, w: 5, h: 3, movable: true },
    { x: 30, y: 22, w: 3, h: 4, movable: true },
  ];
  return {
    id: 'dual-channel',
    name: 'A · 双通道',
    description: '隔墙有上下两条通道, 各带一扇挡门。关掉正在走的通道, 角色应绕行另一条。',
    width: ROOM_W,
    height: ROOM_H,
    start: { x: 4, y: 15 },
    goal: { x: 36, y: 15 },
    defaultRadius: 0.4,
    staticObstacles: [wallTop, wallMid, wallBottom, ...decor],
    doors: [doorTop, doorBottom],
    doorsOpen: { 'A-top': true, 'A-bottom': true },
  };
}

/**
 * 布局 B: 竖墙只留一个窄缺口(净宽 1.0)。
 * 半径 0.2 的角色(直径 0.4)能过; 半径 0.8(直径 1.6)过不去 —— 体积决定通行。
 * 两扇挡门分别封死窄门两侧的走廊, 用于无路/恢复测试。
 */
function narrowDoorLayout(): LayoutDef {
  const wallX = 20;
  const gapY = 14.5;
  const gapH = 1.0;
  const wallTop: StaticObstacle = { x: wallX, y: 0, w: 2, h: gapY, movable: true };
  const wallBottom: StaticObstacle = { x: wallX, y: gapY + gapH, w: 2, h: ROOM_H - gapY - gapH, movable: true };

  const doorLeft: DoorDef = {
    doorId: 'B-left',
    label: '左挡门(窄门前)',
    x: 14,
    y: gapY - 1.2,
    w: 1.2,
    h: gapH + 2.4,
  };
  const doorRight: DoorDef = {
    doorId: 'B-right',
    label: '右挡门(窄门后)',
    x: 26.8,
    y: gapY - 1.2,
    w: 1.2,
    h: gapH + 2.4,
  };
  const decor: StaticObstacle[] = [
    { x: 6, y: 5, w: 4, h: 3, movable: true },
    { x: 30, y: 22, w: 4, h: 3, movable: true },
  ];
  return {
    id: 'narrow-door',
    name: 'B · 窄门',
    description: '唯一缺口净宽 1.0: 小角色(半径 0.2)可过, 大角色(半径 0.8)中心线能过但身体过不去。',
    width: ROOM_W,
    height: ROOM_H,
    start: { x: 4, y: 15 },
    goal: { x: 36, y: 15 },
    defaultRadius: 0.2,
    staticObstacles: [wallTop, wallBottom, ...decor],
    doors: [doorLeft, doorRight],
    doorsOpen: { 'B-left': true, 'B-right': true },
  };
}

/** 布局 C: 终点被围墙围住, 仅南北两个缺口, 各有一扇挡门。两扇都关时终点不可达 */
function enclosedGoalLayout(): LayoutDef {
  const box = { x0: 24, y0: 8, x1: 36, y1: 22 };
  const t = 1.5;
  // 北墙留缺口 x∈[28,32], 南墙留缺口 x∈[28,32]
  const northLeft: StaticObstacle = { x: box.x0, y: box.y0, w: 28 - box.x0, h: t, movable: true };
  const northRight: StaticObstacle = { x: 32, y: box.y0, w: box.x1 - 32, h: t, movable: true };
  const southLeft: StaticObstacle = { x: box.x0, y: box.y1 - t, w: 28 - box.x0, h: t, movable: true };
  const southRight: StaticObstacle = { x: 32, y: box.y1 - t, w: box.x1 - 32, h: t, movable: true };
  const westWall: StaticObstacle = { x: box.x0, y: box.y0, w: t, h: box.y1 - box.y0, movable: true };
  const eastWall: StaticObstacle = { x: box.x1 - t, y: box.y0, w: t, h: box.y1 - box.y0, movable: true };

  const doorNorth: DoorDef = {
    doorId: 'C-north',
    label: '北门',
    x: 28,
    y: box.y0,
    w: 4,
    h: t,
  };
  const doorSouth: DoorDef = {
    doorId: 'C-south',
    label: '南门',
    x: 28,
    y: box.y1 - t,
    w: 4,
    h: t,
  };
  const decor: StaticObstacle[] = [
    { x: 6, y: 6, w: 4, h: 3, movable: true },
    { x: 8, y: 22, w: 3, h: 3, movable: true },
    { x: 16, y: 14, w: 2.5, h: 2.5, movable: true },
  ];
  return {
    id: 'enclosed-goal',
    name: 'C · 终点被围住',
    description: '终点在围墙内, 只有南北两个缺口可进。同时关上两扇门, 终点变为不可达; 重开一扇即恢复。',
    width: ROOM_W,
    height: ROOM_H,
    start: { x: 4, y: 15 },
    goal: { x: 30, y: 15 },
    defaultRadius: 0.4,
    staticObstacles: [northLeft, northRight, southLeft, southRight, westWall, eastWall, ...decor],
    doors: [doorNorth, doorSouth],
    doorsOpen: { 'C-north': true, 'C-south': true },
  };
}

export const LAYOUTS: LayoutDef[] = [dualChannelLayout(), narrowDoorLayout(), enclosedGoalLayout()];

export function getLayout(id: string): LayoutDef {
  const found = LAYOUTS.find((l) => l.id === id);
  if (!found) throw new Error(`未知布局: ${id}`);
  return found;
}

/** 深拷贝布局, 恢复布局时使用 */
export function cloneLayout(layout: LayoutDef): LayoutDef {
  return JSON.parse(JSON.stringify(layout)) as LayoutDef;
}
