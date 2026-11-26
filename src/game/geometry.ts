import type { Dir, Placement, SlotDef } from './types.js';

export const DIR_DELTA: Record<Dir, { dx: number; dy: number }> = {
  N: { dx: 0, dy: -1 },
  E: { dx: 1, dy: 0 },
  S: { dx: 0, dy: 1 },
  W: { dx: -1, dy: 0 },
};

export const DIR_LABEL: Record<Dir, string> = {
  N: '北 ↑',
  E: '东 →',
  S: '南 ↓',
  W: '西 ←',
};

export const DIR_SHORT: Record<Dir, string> = {
  N: '↑',
  E: '→',
  S: '↓',
  W: '←',
};

export const CLOCKWISE: Record<Dir, Dir> = {
  N: 'E',
  E: 'S',
  S: 'W',
  W: 'N',
};

export function rotateClockwise(dir: Dir): Dir {
  return CLOCKWISE[dir];
}

export function keyXY(x: number, y: number): string {
  return `${x},${y}`;
}

export function neighborCoord(x: number, y: number, dir: Dir): { x: number; y: number } {
  const d = DIR_DELTA[dir];
  return { x: x + d.dx, y: y + d.dy };
}

export function outputsFor(
  kind: 'thin' | 'wide' | 'launcher' | 'gate',
  facing: Dir | null | undefined,
  explicit?: Dir[],
): Dir[] {
  if (explicit) return explicit;
  if (!facing) return [];
  if (kind === 'wide') return [facing, rotateClockwise(facing)];
  return [facing];
}

export function placementMap(placement: Placement[]): Map<string, Placement> {
  return new Map(placement.map((p) => [p.slotId, p]));
}

export function slotCoordMap(slots: SlotDef[]): Map<string, SlotDef> {
  return new Map(slots.map((s) => [keyXY(s.x, s.y), s]));
}

export function slotById(slots: SlotDef[]): Map<string, SlotDef> {
  return new Map(slots.map((s) => [s.id, s]));
}

export function directionBetween(from: SlotDef, to: SlotDef): Dir | null {
  for (const dir of ['N', 'E', 'S', 'W'] as Dir[]) {
    const c = neighborCoord(from.x, from.y, dir);
    if (c.x === to.x && c.y === to.y) return dir;
  }
  return null;
}
