import { locationById } from '../engine/engine';
import type { Board, LocationDef, State } from '../engine/types';
import { anchorPx, effectiveBounds, makeViewport, pt, type Viewport } from './viewport';
import type { Point } from '../engine/types';
import { easeInOut } from './util';

/** 一次游动 / 退草的补间。 */
export interface Tween {
  readonly animalId: string;
  readonly from: Point;
  readonly to: Point;
  readonly startedAt: number;
  readonly duration: number;
  readonly kind: 'swim' | 'grass';
  /** swim 沿这条折线走；grass 直线走。 */
  readonly path?: readonly Point[];
}

export interface MotionState {
  positions: Record<string, Point>;
  readonly tweens: Record<string, Tween>;
}

export function boardViewport(board: Board, w: number, h: number): Viewport {
  const b = effectiveBounds(board.locations);
  return makeViewport(w, h, b.cols, b.rows, 26);
}

export function statePositions(board: Board, state: State, v: Viewport): Record<string, Point> {
  const out: Record<string, Point> = {};
  for (const a of board.animals) {
    const loc = state[a.id];
    if (!loc) continue;
    out[a.id] = anchorPx(v, locationById(board, loc));
  }
  return out;
}

export function channelPath(board: Board, from: string, to: string): Point[] | null {
  const ch = board.channels.find((c) => c.from === from && c.to === to);
  return ch ? [...ch.points] : null;
}

function pointAlong(path: Point[], t: number): Point {
  let total = 0;
  const lens: number[] = [];
  for (let i = 1; i < path.length; i++) {
    const d = Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.y - path[i - 1]!.y);
    lens.push(d);
    total += d;
  }
  let d = t * total;
  for (let i = 0; i < lens.length; i++) {
    const seg = lens[i]!;
    if (d <= seg || i === lens.length - 1) {
      const k = seg === 0 ? 0 : d / seg;
      return {
        x: path[i]!.x + (path[i + 1]!.x - path[i]!.x) * k,
        y: path[i]!.y + (path[i + 1]!.y - path[i]!.y) * k,
      };
    }
    d -= seg;
  }
  return path[path.length - 1]!;
}

/** 计算当前帧每只动物的位置（像素）。 */
export function resolvePositions(
  board: Board,
  state: State,
  v: Viewport,
  motion: MotionState,
  now: number,
): Record<string, Point> {
  const base = statePositions(board, state, v);
  for (const [id, tween] of Object.entries(motion.tweens)) {
    const raw = (now - tween.startedAt) / tween.duration;
    if (raw >= 1) continue;
    const t = easeInOut(Math.max(0, raw));
    if (tween.kind === 'swim' && tween.path && tween.path.length >= 2) {
      const worldPath = tween.path.map((p) => pt(v, p));
      base[id] = pointAlong(worldPath, t);
    } else {
      base[id] = {
        x: tween.from.x + (tween.to.x - tween.from.x) * t,
        y: tween.from.y + (tween.to.y - tween.from.y) * t,
      };
    }
  }
  return base;
}

export function makeTween(
  board: Board,
  v: Viewport,
  animalId: string,
  fromLoc: string,
  toLoc: string,
  kind: 'swim' | 'grass',
  now: number,
): Tween {
  const from = anchorPx(v, locationById(board, fromLoc));
  const to = anchorPx(v, locationById(board, toLoc));
  const path = kind === 'swim' ? channelPath(board, fromLoc, toLoc) ?? undefined : undefined;
  const dist = path
    ? path.reduce(
        (n, p, i) => (i === 0 ? 0 : n + Math.hypot(p.x - path[i - 1]!.x, p.y - path[i - 1]!.y)),
        0,
      )
    : Math.hypot(to.x - from.x, to.y - from.y) / v.tile;
  return {
    animalId,
    from,
    to,
    startedAt: now,
    duration: Math.min(1100, 340 + dist * 110),
    kind,
    path,
  };
}

export function locationCenter(loc: LocationDef): Point {
  return { x: loc.rect.x + loc.rect.w / 2, y: loc.rect.y + loc.rect.h / 2 };
}

export type { Viewport };
