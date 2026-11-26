/**
 * 纯逻辑物理引擎：AABB、固定步长、轴分离 + substep 防穿透。
 * 不导入任何 DOM API，可直接被 node:test 无头驱动。
 */
import {
  TICK, GRAVITY_ACC, MAX_FALL, MOVE_SPEED, SUBSTEPS, RELAX_ITERS,
  CRUSH_EPS, CONTAIN_EPS, FLIP_TIMEOUT_TICKS, FLIP_MIN_AGE_TICKS,
  SEAT_REQUIRED_TICKS, MAX_LOGS,
} from './types.ts';
import type {
  Body, GameState, InputState, Rect, RejectReason, RoomDef, Wall,
} from './types.ts';

const PLAYER_MASS = 1;
const BOX_MASS = 2;

export function createState(room: RoomDef): GameState {
  return {
    room,
    player: makeBody('player', 'player', room.player),
    box: makeBody('box', 'box', room.box),
    gravity: room.startGravity,
    flipPhase: 'idle',
    flipAgeTicks: 0,
    flipFromGravity: room.startGravity,
    status: 'playing',
    tick: 0,
    seatedTicks: 0,
    lastReject: null,
    logs: [],
  };
}

export function resetState(state: GameState): GameState {
  const fresh = createState(state.room);
  Object.assign(state, fresh);
  return state;
}

function makeBody(id: string, kind: Body['kind'], r: Rect): Body {
  return { ...r, id, kind, vx: 0, vy: 0, grounded: false, contacts: new Set<string>() };
}

const overlap = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/** 重叠深度；不重叠时对应轴为负 */
function pen(a: Rect, b: Rect): { px: number; py: number } {
  return {
    px: Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x),
    py: Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y),
  };
}

const cx = (r: Rect): number => r.x + r.w / 2;
const cy = (r: Rect): number => r.y + r.h / 2;

function pushLog(state: GameState, kind: GameState['logs'][number]['kind'], text: string): void {
  state.logs.push({ tick: state.tick, kind, text });
  if (state.logs.length > MAX_LOGS) state.logs.shift();
}

const REJECT_TEXT: Record<RejectReason, string> = {
  'not-grounded': '切换被拒：人物双脚不在支撑面上（必须贴地触发）',
  'same-direction': '切换被拒：重力已经朝这个方向',
  'flip-in-progress': '切换被拒：上一次翻转尚未结算，连按不重复结算',
  'game-over': '切换被拒：本局已结束，按 R 重开',
};

function rejectFlip(state: GameState, reason: RejectReason): void {
  state.lastReject = { reason, tick: state.tick };
  pushLog(state, 'flip-reject', REJECT_TEXT[reason]);
}

/** 处理一次 tick 内的翻转请求（边沿触发，每 tick 至多消费一个） */
function handleFlipInput(state: GameState, input: InputState): void {
  const want: 1 | -1 | null = input.flipUp ? -1 : input.flipDown ? 1 : null;
  if (want === null) return;

  if (state.status !== 'playing') return rejectFlip(state, 'game-over');
  if (state.flipPhase === 'flipping') return rejectFlip(state, 'flip-in-progress');
  if (want === state.gravity) return rejectFlip(state, 'same-direction');
  if (!state.player.grounded) return rejectFlip(state, 'not-grounded');

  state.flipFromGravity = state.gravity;
  state.gravity = want;
  state.flipPhase = 'flipping';
  state.flipAgeTicks = 0;
  // 翻转瞬间清零全部速度：人箱从静止开始沿新方向同步坠落，
  // 避免余速漂移让入槽不可控，也避免接触双体带着相对速度互挤
  state.player.vx = 0;
  state.player.vy = 0;
  state.box.vx = 0;
  state.box.vy = 0;
  pushLog(state, 'flip-start', `重力翻转：${state.flipFromGravity === 1 ? '下 → 上' : '上 → 下'}`);
}

function maybeSettleFlip(state: GameState): void {
  if (state.flipPhase !== 'flipping') return;
  state.flipAgeTicks += 1;

  const landed =
    state.flipAgeTicks >= FLIP_MIN_AGE_TICKS &&
    state.player.grounded;
  const timedOut = state.flipAgeTicks >= FLIP_TIMEOUT_TICKS;

  if (landed || timedOut) {
    state.flipPhase = 'idle';
    pushLog(
      state,
      'flip-settle',
      timedOut ? '翻转结算：超时强制结算' : '翻转结算：人物已在新方向落地',
    );
  }
}

/** 沿单轴把体推出墙（按中心相对位置决定推回方向） */
function resolveWallsAxis(body: Body, walls: Wall[], axis: 'x' | 'y'): void {
  for (const wall of walls) {
    if (!overlap(body, wall)) continue;
    const { px, py } = pen(body, wall);
    if (axis === 'x' && px > 0 && px <= py) {
      body.x = cx(body) < cx(wall) ? wall.x - body.w : wall.x + wall.w;
      body.vx = 0;
    } else if (axis === 'y' && py > 0 && py <= px) {
      body.y = cy(body) < cy(wall) ? wall.y - body.h : wall.y + wall.h;
      body.vy = 0;
    }
  }
}

/** 任意轴的最小穿透修正（relaxation 阶段用） */
function resolveWallsAnyAxis(body: Body, walls: Wall[]): void {
  for (const wall of walls) {
    if (!overlap(body, wall)) continue;
    const { px, py } = pen(body, wall);
    if (px < py) {
      body.x = cx(body) < cx(wall) ? wall.x - body.w : wall.x + wall.w;
      body.vx = 0;
    } else {
      body.y = cy(body) < cy(wall) ? wall.y - body.h : wall.y + wall.h;
      body.vy = 0;
    }
    body.contacts.add(`wall:${wall.tag}`);
  }
}

/** 玩家推箱：先移箱，箱若被墙顶住再把玩家夹回 */
function pushBoxX(state: GameState): void {
  const { player, box, room } = state;
  if (!overlap(player, box)) return;
  const dir = cx(player) < cx(box) ? 1 : -1;
  box.x = dir === 1 ? player.x + player.w : player.x - box.w;
  box.vx = player.vx;
  resolveWallsAxis(box, room.walls, 'x');

  if (overlap(player, box)) {
    // 箱被墙顶住：把玩家夹在箱外侧，保证两者都有体积
    player.x = dir === 1 ? box.x - player.w : box.x + box.w;
    player.vx = 0;
  }
  player.contacts.add('box');
  box.contacts.add('player');
}

/** 玩家与箱的通用双向修正，按逆质量分配位移 */
function resolvePair(state: GameState): void {
  const { player, box } = state;
  if (!overlap(player, box)) return;
  const { px, py } = pen(player, box);
  const invP = 1 / PLAYER_MASS;
  const invB = 1 / BOX_MASS;
  const sum = invP + invB;

  if (px < py) {
    const dir = cx(player) < cx(box) ? -1 : 1; // 玩家被推的方向
    const shiftP = (px * invP) / sum;
    const shiftB = (px * invB) / sum;
    player.x += dir * shiftP;
    box.x -= dir * shiftB;
    if (Math.sign(player.vx - box.vx) === -dir) player.vx = box.vx;
  } else {
    const dir = cy(player) < cy(box) ? -1 : 1;
    const shiftP = (py * invP) / sum;
    const shiftB = (py * invB) / sum;
    player.y += dir * shiftP;
    box.y -= dir * shiftB;
    if (Math.sign(player.vy - box.vy) === -dir) player.vy = box.vy;
  }
  player.contacts.add('box');
  box.contacts.add('player');
}

function integrate(state: GameState, input: InputState, dt: number): void {
  const { player, box, gravity } = state;

  for (const b of [player, box]) {
    b.vy += gravity * GRAVITY_ACC * dt;
    b.vy = Math.max(-MAX_FALL, Math.min(MAX_FALL, b.vy));
  }

  // 水平操控（仅玩家直接受控，箱靠碰撞被推）
  const target = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  if (target !== 0) {
    const want = target * MOVE_SPEED;
    const accel = 2000 * dt;
    player.vx += Math.sign(want - player.vx) * Math.min(accel, Math.abs(want - player.vx));
  } else {
    const k = player.grounded ? 12 : 2.5;
    player.vx *= Math.exp(-k * dt);
    if (Math.abs(player.vx) < 1) player.vx = 0;
  }
  const bk = box.grounded ? 10 : 1.5;
  box.vx *= Math.exp(-bk * dt);
  if (Math.abs(box.vx) < 1) box.vx = 0;
}

function substep(state: GameState, input: InputState, dt: number): void {
  const { player, box, room } = state;
  player.contacts.clear();
  box.contacts.clear();

  integrate(state, input, dt);

  // ---- X 轴：箱先，玩家后（玩家可推箱）----
  box.x += box.vx * dt;
  resolveWallsAxis(box, room.walls, 'x');
  player.x += player.vx * dt;
  resolveWallsAxis(player, room.walls, 'x');
  pushBoxX(state);

  // ---- Y 轴：箱先（重力方向一侧优先落地，箱给人当垫子/顶板）----
  box.y += box.vy * dt;
  resolveWallsAxis(box, room.walls, 'y');
  player.y += player.vy * dt;
  resolveWallsAxis(player, room.walls, 'y');

  // ---- 全局 relaxation：吃掉多体接触残留的穿透 ----
  for (let i = 0; i < RELAX_ITERS; i += 1) {
    resolveWallsAnyAxis(box, room.walls);
    resolveWallsAnyAxis(player, room.walls);
    resolvePair(state);
    resolveWallsAnyAxis(box, room.walls);
    resolveWallsAnyAxis(player, room.walls);
  }

  updateGrounded(state);
}

/** 沿重力方向探 1px：碰墙或另一体即视为有支撑 */
function probeGrounded(body: Body, state: GameState): boolean {
  const g = state.gravity;
  const probe: Rect = { x: body.x, y: body.y + g, w: body.w, h: body.h };
  for (const wall of state.room.walls) {
    if (overlap(probe, wall)) {
      body.contacts.add(`wall:${wall.tag}`);
      return true;
    }
  }
  const other = body === state.player ? state.box : state.player;
  return overlap(probe, other);
}

function updateGrounded(state: GameState): void {
  state.box.grounded = probeGrounded(state.box, state);
  state.player.grounded = probeGrounded(state.player, state);
}

/** 结算后体检：残留穿透过深 => 挤压失败 */
function checkCrush(state: GameState): void {
  const pairs: Array<[Rect, Rect, string]> = [
    [state.player, state.box, '玩家与标本箱'],
    ...state.room.walls.map((w): [Rect, Rect, string] => [state.player, w, `玩家与墙(${w.tag})`]),
    ...state.room.walls.map((w): [Rect, Rect, string] => [state.box, w, `标本箱与墙(${w.tag})`]),
  ];
  let worst = 0;
  let where = '';
  for (const [a, b, label] of pairs) {
    if (!overlap(a, b)) continue;
    const { px, py } = pen(a, b);
    const d = Math.min(px, py);
    if (d > worst) {
      worst = d;
      where = label;
    }
  }
  if (worst > CRUSH_EPS) {
    state.status = 'failed';
    pushLog(state, 'fail', `挤压失败：${where} 残留重叠 ${worst.toFixed(2)}px，按 R 重开`);
  }
}

/** 硬不变量：任何体都必须留在四壁之内 */
function checkContainment(state: GameState): void {
  const t = state.room.wallThickness;
  for (const b of [state.player, state.box]) {
    const out =
      b.x < t - CONTAIN_EPS || b.y < t - CONTAIN_EPS ||
      b.x + b.w > state.room.width - t + CONTAIN_EPS ||
      b.y + b.h > state.room.height - t + CONTAIN_EPS;
    if (out) {
      state.status = 'failed';
      pushLog(state, 'fail', `严重错误：${b.id} 被推出房间边界，按 R 重开`);
      return;
    }
  }
}

/** 标本箱完整落在对应槽内（人掉上去、只擦过都不满足） */
export function boxSeated(state: GameState): boolean {
  const { box } = state;
  return state.room.slots.some((s) =>
    box.x >= s.x && box.y >= s.y &&
    box.x + box.w <= s.x + s.w && box.y + box.h <= s.y + s.h &&
    box.grounded,
  );
}

function checkWin(state: GameState): void {
  if (boxSeated(state)) {
    state.seatedTicks += 1;
    if (state.seatedTicks === SEAT_REQUIRED_TICKS) {
      state.status = 'won';
      pushLog(state, 'win', '完成：标本箱完整入槽并停稳');
    }
  } else {
    state.seatedTicks = 0;
  }
}

const EMPTY_INPUT: InputState = { left: false, right: false, flipUp: false, flipDown: false };

/** 推进一个固定步长（60Hz）。暂停时主循环不调用本函数。 */
export function tick(state: GameState, input: InputState = EMPTY_INPUT): GameState {
  if (state.status === 'playing') {
    state.tick += 1;
    handleFlipInput(state, input);

    const dt = TICK / SUBSTEPS;
    for (let i = 0; i < SUBSTEPS; i += 1) substep(state, input, dt);

    maybeSettleFlip(state);
    checkCrush(state);
    checkContainment(state);
    if (state.status === 'playing') checkWin(state);
  }
  return state;
}

/** 测试/调试用：当前最大残留穿透深度 */
export function maxPenetration(state: GameState): number {
  const all: Array<[Rect, Rect]> = [
    [state.player, state.box],
    ...state.room.walls.map((w): [Rect, Rect] => [state.player, w]),
    ...state.room.walls.map((w): [Rect, Rect] => [state.box, w]),
  ];
  let worst = 0;
  for (const [a, b] of all) {
    if (!overlap(a, b)) continue;
    const { px, py } = pen(a, b);
    worst = Math.max(worst, Math.min(px, py));
  }
  return worst;
}
