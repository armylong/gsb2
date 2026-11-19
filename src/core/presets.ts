/**
 * presets.ts — 房间与三组样例场景（全部程序化生成，无外部资源）
 *
 * 逻辑坐标系：房间内区 900 × 600，原点在左上角，y 向下。
 * 墙体厚度仅用于绘制，碰撞以内区边界为准。
 */

import { Circle, Poly, Vec2, circleIntersectsConvex, convexIntersect, rect, regularPolygon } from './geometry';

export const ROOM_W = 900;
export const ROOM_H = 600;
export const WALL = 14;
export const MAX_POLYS = 8;

export interface Checkpoint {
  name: string;
  p: Vec2;
  /** 预期可见比例类别，仅用于 UI 展示 */
  expect: '全亮' | '全暗' | '半影' | '重叠';
}

export interface Preset {
  id: string;
  label: string;
  desc: string;
  light: Circle;
  range: number;
  brightness: number;
  polys: Poly[];
  checkpoints: Checkpoint[];
  /** 自动移动的扫动范围（光源中心 x） */
  auto: { x0: number; x1: number; y: number };
}

let nextId = 1;
const poly = (verts: Vec2[]): Poly => ({ id: nextId++, verts });

export function makePresets(): Preset[] {
  nextId = 1;
  return [
    {
      id: 'single',
      label: '单挡板',
      desc: '一块矩形挡板，拖大光源半径可观察本影收缩、半影变宽。',
      light: { c: { x: 220, y: 150 }, r: 26 },
      range: 520,
      brightness: 1,
      polys: [poly(rect(400, 210, 70, 180))],
      checkpoints: [
        { name: 'C1 全亮区', p: { x: 560, y: 130 }, expect: '全亮' },
        { name: 'C2 本影区', p: { x: 600, y: 300 }, expect: '全暗' },
        { name: 'C3 半影边缘', p: { x: 540, y: 225 }, expect: '半影' },
      ],
      auto: { x0: 150, x1: 320, y: 150 },
    },
    {
      id: 'double',
      label: '双挡板重叠',
      desc: '两块挡板的投影在右侧重叠，重叠区只按角度并集遮挡一次，不会重复叠黑。',
      light: { c: { x: 180, y: 300 }, r: 30 },
      range: 560,
      brightness: 1,
      polys: [
        poly(rect(380, 120, 60, 170)),
        poly(rect(470, 260, 60, 200)),
      ],
      checkpoints: [
        { name: 'D1 重叠本影', p: { x: 480, y: 70 }, expect: '重叠' },
        { name: 'D2 单挡半影', p: { x: 528, y: 496 }, expect: '半影' },
        { name: 'D3 无遮挡', p: { x: 480, y: 480 }, expect: '全亮' },
      ],
      auto: { x0: 130, x1: 300, y: 300 },
    },
    {
      id: 'wall',
      label: '靠墙',
      desc: '挡板贴住下墙与右墙，检查与墙角对齐时不出现飞线或整屏黑块。',
      light: { c: { x: 300, y: 160 }, r: 24 },
      range: 540,
      brightness: 1,
      polys: [
        // 贴下墙
        poly(rect(180, ROOM_H - 150, 150, 150)),
        // 贴右墙
        poly(rect(ROOM_W - 120, 300, 120, 110)),
        // 一块五边形丰富场景
        poly(regularPolygon({ x: 520, y: 200 }, 60, 5, -Math.PI / 2)),
      ],
      checkpoints: [
        { name: 'W1 半影过渡', p: { x: 552, y: 136 }, expect: '半影' },
        { name: 'W2 开阔全亮', p: { x: 480, y: 60 }, expect: '全亮' },
        { name: 'W3 板后本影', p: { x: 480, y: 190 }, expect: '全暗' },
      ],
      auto: { x0: 220, x1: 380, y: 160 },
    },
  ];
}

/** 光源圆盘是否与任一档板相交，或圆心越出房间内区 */
export function lightPlacementInvalid(light: Circle, polys: Poly[]): string | null {
  const m = WALL;
  if (
    light.c.x - light.r < m ||
    light.c.x + light.r > ROOM_W - m ||
    light.c.y - light.r < m ||
    light.c.y + light.r > ROOM_H - m
  ) {
    return '光源超出房间边界';
  }
  for (const p of polys) {
    if (circleIntersectsConvex(light, p)) return '光源与挡板相交或进入挡板内部';
  }
  return null;
}

/** 挡板移动到 newVerts 后是否合法：不出墙、不与其他挡板重叠、不与光源相交 */
export function polyPlacementInvalid(
  newVerts: Vec2[],
  self: Poly,
  polys: Poly[],
  light: Circle,
): string | null {
  for (const q of newVerts) {
    if (q.x < WALL || q.x > ROOM_W - WALL || q.y < WALL || q.y > ROOM_H - WALL) {
      return '挡板超出房间边界';
    }
  }
  const candidate: Poly = { id: self.id, verts: newVerts };
  if (circleIntersectsConvex(light, candidate)) return '挡板与光源相交，已保留上次有效位置';
  for (const other of polys) {
    if (other.id === self.id) continue;
    if (convexIntersect(candidate, other)) return '挡板与另一挡板重叠，已保留上次有效位置';
  }
  return null;
}
