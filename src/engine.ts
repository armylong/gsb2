import {
  HANDLE_DISTANCE,
  FRAME_LENGTH,
  FRAME_WIDTH,
  PORTER_RADIUS,
  PICKUP_RADIUS,
  STEP,
  type Level,
} from './types';
import {
  circleOBBOverlap,
  circleRectOverlap,
  dist,
  frameOBB,
  obbRectOverlap,
  angleMatches,
  obbInsideRect,
  circleInsideRect,
  type BlockInfo,
  type Vec,
} from './geom';

export interface GameState {
  mode: 'carry' | 'ground';
  /** The two rigid handles. Their distance is a level invariant. */
  h: [Vec, Vec];
  /** Porter positions. In carry mode these equal the handles named by grip. */
  people: [Vec, Vec];
  /** grip[porter] = handle currently held. */
  grip: [0 | 1, 0 | 1];
  groundedPad: string | null;
}

export interface StepResult {
  state: GameState;
  reached: boolean;
  block: BlockInfo | null;
  message: string;
}

export interface SimpleResult {
  ok: boolean;
  state: GameState;
  message: string;
}

export function cloneState(s: GameState): GameState {
  return {
    mode: s.mode,
    h: [
      { ...s.h[0]! },
      { ...s.h[1]! },
    ],
    people: [
      { ...s.people[0]! },
      { ...s.people[1]! },
    ],
    grip: [...s.grip] as [0 | 1, 0 | 1],
    groundedPad: s.groundedPad,
  };
}

export function makeInitialState(level: Level): GameState {
  const grip = level.start.grip ?? [0, 1];
  const h: [Vec, Vec] = [{ ...level.start.h0 }, { ...level.start.h1 }];
  const people: [Vec, Vec] = [{ ...h[grip[0]!]! }, { ...h[grip[1]!]! }];
  return { mode: 'carry', h, people, grip, groundedPad: null };
}

export function handleDistanceError(s: GameState): number {
  return Math.abs(dist(s.h[0]!, s.h[1]!) - HANDLE_DISTANCE);
}

function wallName(w: { name?: string }, fallback = '墙体'): string {
  return w.name ?? fallback;
}

function blockMessage(b: BlockInfo): string {
  const who = b.subject === 'frame' ? '画框' : b.subject === 'porter0' ? '蓝衣搬运工' : '橙衣搬运工';
  return `${who}碰到了${b.obstacle}`;
}

export function describeBlock(b: BlockInfo | null): string {
  return b ? blockMessage(b) : '';
}

function checkCarryHandles(h0: Vec, h1: Vec, level: Level, grip: [0 | 1, 0 | 1] = [0, 1]): BlockInfo | null {
  const obb = frameOBB(h0, h1, FRAME_LENGTH, FRAME_WIDTH);
  const handles = [h0, h1] as const;

  // Check people/handles first so the message names the porter who hit something.
  for (let handleIndex = 0 as 0 | 1; handleIndex < 2; handleIndex = (handleIndex + 1) as 0 | 1) {
    const p = handles[handleIndex]!;
    const porterIndex = grip.findIndex((held) => held === handleIndex) as 0 | 1;
    const subject = porterIndex === 0 ? 'porter0' : 'porter1';
    for (const w of level.walls) {
      if (circleRectOverlap(p, PORTER_RADIUS, w)) {
        return { subject, obstacle: wallName(w), at: { ...p } };
      }
    }
  }

  for (const w of level.walls) {
    if (obbRectOverlap(obb, w)) {
      return {
        subject: 'frame',
        obstacle: wallName(w),
        at: { x: obb.cx, y: obb.cy },
      };
    }
  }
  return null;
}

export function collisionInState(s: GameState, level: Level): BlockInfo | null {
  if (s.mode === 'carry') {
    // Every handle is occupied by exactly one porter in our state model.
    return checkCarryHandles(s.h[0]!, s.h[1]!, level, s.grip);
  }

  const obb = frameOBB(s.h[0]!, s.h[1]!, FRAME_LENGTH, FRAME_WIDTH);
  for (const w of level.walls) {
    if (obbRectOverlap(obb, w)) {
      return { subject: 'frame', obstacle: wallName(w), at: { x: obb.cx, y: obb.cy } };
    }
  }

  for (let i = 0 as 0 | 1; i < 2; i = (i + 1) as 0 | 1) {
    const p = s.people[i]!;
    const subject = i === 0 ? 'porter0' : 'porter1';
    for (const w of level.walls) {
      if (circleRectOverlap(p, PORTER_RADIUS, w)) {
        return { subject, obstacle: wallName(w), at: { ...p } };
      }
    }
    if (circleOBBOverlap(p, PORTER_RADIUS, obb)) {
      return { subject, obstacle: '落地的画框', at: { ...p } };
    }
  }

  if (dist(s.people[0]!, s.people[1]!) < PORTER_RADIUS * 2 - 0.5) {
    return { subject: 'porter0', obstacle: '另一名搬运工', at: { ...s.people[0]! } };
  }
  return null;
}

function finishBlocked(prev: GameState, block: BlockInfo): StepResult {
  return {
    state: prev,
    reached: false,
    block,
    message: `${blockMessage(block)}，已在碰撞前停住`,
  };
}

function finishReached(state: GameState, message = ''): StepResult {
  return { state, reached: true, block: null, message };
}

/**
 * Rotate the handle held by porter `who` around the other occupied handle.
 * The pivot porter never moves. Sweeps in <= STEP pixel arc increments so a
 * far pointer/demo delta cannot teleport the frame through a wall.
 */
export function sweepPivot(s: GameState, who: 0 | 1, delta: number, level: Level): StepResult {
  if (s.mode !== 'carry') {
    return { state: s, reached: false, block: null, message: '画框已落地，请先拿起' };
  }
  if (Math.abs(delta) < 1e-8) return finishReached(s);

  const heldHandle = s.grip[who]!;
  const pivotHandle = (1 - heldHandle) as 0 | 1;
  const pivot = s.h[pivotHandle]!;
  const dragged = s.h[heldHandle]!;
  const startAngle = Math.atan2(dragged.y - pivot.y, dragged.x - pivot.x);
  const arcLength = Math.abs(delta) * HANDLE_DISTANCE;
  const steps = Math.max(1, Math.ceil(arcLength / STEP));

  let current = cloneState(s);
  for (let i = 1; i <= steps; i++) {
    const a = startAngle + (delta * i) / steps;
    const candidate = cloneState(current);
    candidate.h[heldHandle] = {
      x: pivot.x + Math.cos(a) * HANDLE_DISTANCE,
      y: pivot.y + Math.sin(a) * HANDLE_DISTANCE,
    };
    candidate.h[pivotHandle] = { ...pivot };
    candidate.people[0] = { ...candidate.h[candidate.grip[0]!]! };
    candidate.people[1] = { ...candidate.h[candidate.grip[1]!]! };

    const block = checkCarryHandles(candidate.h[0]!, candidate.h[1]!, level, candidate.grip);
    if (block) return finishBlocked(current, block);
    current = candidate;
  }
  return finishReached(current);
}

/** Translate both handles by the same vector, preserving orientation. */
export function sweepTranslate(s: GameState, dx: number, dy: number, level: Level): StepResult {
  if (s.mode !== 'carry') {
    return { state: s, reached: false, block: null, message: '画框已落地，不能整体拖动' };
  }
  const length = Math.hypot(dx, dy);
  if (length < 1e-8) return finishReached(s);
  const steps = Math.max(1, Math.ceil(length / STEP));

  let current = cloneState(s);
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    const candidate = cloneState(current);
    // Build from the original state so repeated candidates do not accumulate.
    candidate.h[0] = { x: s.h[0]!.x + dx * k, y: s.h[0]!.y + dy * k };
    candidate.h[1] = { x: s.h[1]!.x + dx * k, y: s.h[1]!.y + dy * k };
    candidate.people[0] = { ...candidate.h[candidate.grip[0]!]! };
    candidate.people[1] = { ...candidate.h[candidate.grip[1]!]! };

    const block = checkCarryHandles(candidate.h[0]!, candidate.h[1]!, level, candidate.grip);
    if (block) return finishBlocked(current, block);
    current = candidate;
  }
  return finishReached(current);
}

/** Move one detached porter while the frame rests on the floor. */
export function sweepWalkPerson(s: GameState, who: 0 | 1, to: Vec, level: Level): StepResult {
  if (s.mode !== 'ground') {
    return { state: s, reached: false, block: null, message: '搬运工正抬着画框' };
  }
  const from = s.people[who]!;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-8) return finishReached(s);
  const steps = Math.max(1, Math.ceil(length / STEP));

  let current = cloneState(s);
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    const candidate = cloneState(current);
    candidate.people[who] = { x: from.x + dx * k, y: from.y + dy * k };
    const block = collisionInState(candidate, level);
    if (block) return finishBlocked(current, block);
    current = candidate;
  }
  return finishReached(current);
}

export function findStablePad(s: GameState, level: Level): string | null {
  const obb = frameOBB(s.h[0]!, s.h[1]!, FRAME_LENGTH, FRAME_WIDTH);
  for (const pad of level.pads) {
    const frameOk = obbInsideRect(obb, pad, 4);
    const peopleOk = s.people.every((p) => circleInsideRect(p, PORTER_RADIUS, pad, 2));
    if (frameOk && peopleOk) return pad.id;
  }
  return null;
}

export function groundFrame(s: GameState, level: Level): SimpleResult {
  if (s.mode === 'ground') {
    return { ok: false, state: s, message: '画框已经落地了' };
  }
  const padId = findStablePad(s, level);
  if (!padId) {
    return {
      ok: false,
      state: s,
      message: '这里不允许放手：画框和两人都要完整站进虚线落地区',
    };
  }
  const next = cloneState(s);
  next.mode = 'ground';
  next.groundedPad = padId;
  return { ok: true, state: next, message: `已在${level.pads.find((p) => p.id === padId)?.label ?? '落地区'}放稳` };
}

function wallPathClearForPerson(who: 0 | 1, from: Vec, to: Vec, level: Level): BlockInfo | null {
  const length = dist(from, to);
  const steps = Math.max(1, Math.ceil(length / STEP));
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    const p = { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
    for (const w of level.walls) {
      if (circleRectOverlap(p, PORTER_RADIUS, w)) {
        return { subject: who === 0 ? 'porter0' : 'porter1', obstacle: wallName(w), at: p };
      }
    }
  }
  return null;
}

function assignHandles(s: GameState): [0 | 1, 0 | 1] | null {
  const [p0, p1] = s.people;
  if (!p0 || !p1) return null;
  const d00 = dist(p0, s.h[0]!);
  const d01 = dist(p0, s.h[1]!);
  const d10 = dist(p1, s.h[0]!);
  const d11 = dist(p1, s.h[1]!);

  const candidates: Array<{ grip: [0 | 1, 0 | 1]; cost: number }> = [];
  if (d00 <= PICKUP_RADIUS && d11 <= PICKUP_RADIUS) {
    candidates.push({ grip: [0, 1], cost: d00 + d11 });
  }
  if (d01 <= PICKUP_RADIUS && d10 <= PICKUP_RADIUS) {
    candidates.push({ grip: [1, 0], cost: d01 + d10 });
  }
  candidates.sort((a, b) => a.cost - b.cost);
  return candidates[0]?.grip ?? null;
}

export function pickupFrame(s: GameState, level: Level): SimpleResult {
  if (s.mode !== 'ground') {
    return { ok: false, state: s, message: '画框已经抬着了' };
  }

  const padId = findStablePad(s, level);
  if (!padId) {
    return {
      ok: false,
      state: s,
      message: '还不能换手：两人和画框都要在同一个落地区内站稳',
    };
  }

  const grip = assignHandles(s);
  if (!grip) {
    return {
      ok: false,
      state: s,
      message: '两人要分别走到两个把手旁，才能拿起或交换把手',
    };
  }

  const next = cloneState(s);
  next.grip = [...grip] as [0 | 1, 0 | 1];

  // A short reach-in is allowed, but never through a wall.
  for (let i = 0 as 0 | 1; i < 2; i = (i + 1) as 0 | 1) {
    const target = next.h[next.grip[i]!]!;
    const block = wallPathClearForPerson(i, next.people[i]!, target, level);
    if (block) {
      return { ok: false, state: s, message: `${blockMessage(block)}，不能伸手穿过墙拿把手` };
    }
    next.people[i] = { ...target };
  }

  const block = checkCarryHandles(next.h[0]!, next.h[1]!, level, next.grip);
  if (block) return { ok: false, state: s, message: blockMessage(block) };

  next.mode = 'carry';
  next.groundedPad = null;
  const swapped = next.grip[0] === 1;
  return {
    ok: true,
    state: next,
    message: swapped ? '已交换到另一边把手并抬起' : '已重新抬起画框',
  };
}

export function isComplete(s: GameState, level: Level): boolean {
  const obb = frameOBB(s.h[0]!, s.h[1]!, FRAME_LENGTH, FRAME_WIDTH);
  // Two pixels of tolerance keeps the "fully inside" rule visible but not finicky.
  if (!obbInsideRect(obb, level.goal, 2)) return false;
  return angleMatches(obb.angle, level.goal.angle, 0.13);
}
