/**
 * 拾取：把屏幕点击换算到世界坐标后，判断点中了什么。
 * 所有判断都在世界坐标中进行，因此缩放/平移不会改变拾取语义。
 */
import type { Lamp, Vec2, WallSegment } from './types.js';
import { dist, pointSegmentDistance } from './geometry.js';

export type PickTarget =
  | { kind: 'wall-endpoint'; wallId: string; end: 'a' | 'b' }
  | { kind: 'wall-body'; wallId: string }
  | { kind: 'lamp-endpoint'; end: 'a' | 'b' }
  | { kind: 'lamp-body' }
  | { kind: 'sample'; sampleId: string }
  | { kind: 'floor' };

/** 屏幕像素距离换算成世界距离的阈值（米） */
const PICK_PX = 9;

export function pick(
  worldPos: Vec2,
  screenRadiusMeters: number,
  walls: WallSegment[],
  lamp: Lamp,
  sampleIds: { id: string; pos: Vec2 }[],
): PickTarget {
  const threshold = Math.max(0.12, screenRadiusMeters * PICK_PX);

  // 1. 墙端点 / 灯端点（最高优先级，便于拖动）
  for (const w of walls) {
    if (!w.enabled) continue;
    if (dist(worldPos, w.a) <= threshold) return { kind: 'wall-endpoint', wallId: w.id, end: 'a' };
    if (dist(worldPos, w.b) <= threshold) return { kind: 'wall-endpoint', wallId: w.id, end: 'b' };
  }
  if (dist(worldPos, lamp.a) <= threshold) return { kind: 'lamp-endpoint', end: 'a' };
  if (dist(worldPos, lamp.b) <= threshold) return { kind: 'lamp-endpoint', end: 'b' };

  // 2. 取样点
  for (const s of sampleIds) {
    if (dist(worldPos, s.pos) <= threshold) return { kind: 'sample', sampleId: s.id };
  }

  // 3. 墙身 / 灯身
  let bestWall: { id: string; d: number } | null = null;
  for (const w of walls) {
    if (!w.enabled) continue;
    const d = pointSegmentDistance(worldPos, w.a, w.b).dist;
    if (d <= threshold && (!bestWall || d < bestWall.d)) bestWall = { id: w.id, d };
  }
  if (bestWall) return { kind: 'wall-body', wallId: bestWall.id };

  const lampD = pointSegmentDistance(worldPos, lamp.a, lamp.b).dist;
  if (lampD <= threshold) return { kind: 'lamp-body' };

  return { kind: 'floor' };
}

/** 悬停光标提示用的宽松拾取 */
export function hoverKind(target: PickTarget): string {
  switch (target.kind) {
    case 'wall-endpoint':
    case 'lamp-endpoint':
      return 'crosshair';
    case 'wall-body':
    case 'lamp-body':
    case 'sample':
      return 'move';
    default:
      return 'default';
  }
}
