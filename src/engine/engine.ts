// 机关引擎：状态创建、转动预览与碰撞、端口对接判定、角色移动、动画更新。
// 不依赖 DOM / Canvas，可直接在 Node 下做单元测试。

import {
  DIR_VECTORS,
  OPPOSITE_DIR,
  add,
  cellCorners,
  clamp,
  eq,
  key,
  lerp,
  localToWorld,
  pivotOf,
  platformCorners,
  playerBox,
  polygonsIntersect,
  rotatePoint,
  rot90CW,
} from './geometry.js';
import type {
  CellKind,
  Dir,
  GameState,
  LevelDef,
  Platform,
  RotationPreview,
  RotDir,
  RuntimePort,
  Vec2,
} from './types.js';

/** 转动动画时长（秒） */
export const ROTATION_DURATION = 0.55;
/** 碰撞采样步数（每 5° 一检，半程 9 个采样点） */
const SAMPLES = 18;
/** 静态碰撞盒内缩量：停稳时的共边接触不算撞，转起来越界才算 */
const HULL_INSET = 0.02;
const MOVE_COOLDOWN = 0.12;

const CW_ORDER: Dir[] = ['N', 'E', 'S', 'W'];

export function cwDir(d: Dir): Dir {
  return CW_ORDER[(CW_ORDER.indexOf(d) + 1) % 4];
}

function buildGrid(level: LevelDef): Map<string, CellKind> {
  const grid = new Map<string, CellKind>();
  (Object.keys(level.cells) as CellKind[]).forEach((kind) => {
    for (const cell of level.cells[kind] ?? []) {
      grid.set(key(cell), kind);
    }
  });
  return grid;
}

function makePlatform(def: LevelDef['platforms'][number]): Platform {
  return {
    id: def.id,
    origin: structuredClone(def.origin),
    size: def.size,
    orientation: def.orientation,
    ports: structuredClone(def.ports),
    animAngle: 0,
    animTarget: 0,
    animDir: null,
  };
}

export function createGameState(level: LevelDef): GameState {
  const platforms = level.platforms.map(makePlatform);
  const aboard = platformAtCellRaw(platforms, level.spawn)?.id ?? null;
  const spawnCenter = cellCenter(level.spawn);
  const state: GameState = {
    level: structuredClone(level),
    levelId: level.id,
    cols: level.cols,
    rows: level.rows,
    grid: buildGrid(level),
    platforms,
    levers: structuredClone(level.levers),
    spawn: structuredClone(level.spawn),
    exit: structuredClone(level.exit),
    player: {
      cell: structuredClone(level.spawn),
      pos: structuredClone(spawnCenter),
      aboard,
      localOffset: aboard
        ? subtract(spawnCenter, pivotOf(platformById(platforms, aboard)!.origin, 3))
        : null,
      moveTimer: 0,
    },
    phase: 'idle',
    preview: null,
    banner: '',
    bannerTimer: 0,
    showEdges: true,
  };
  return state;
}

export function cellCenter(cell: Vec2): Vec2 {
  return { x: cell.x + 0.5, y: cell.y + 0.5 };
}

const subtract = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });

export function platformById(
  platforms: Platform[],
  id: 'A' | 'B',
): Platform | undefined {
  return platforms.find((p) => p.id === id);
}

/** 停稳时某格属于哪块步道（正方形原地旋转，占位格不随朝向变化） */
function platformAtCellRaw(
  platforms: Platform[],
  cell: Vec2,
): Platform | null {
  for (const p of platforms) {
    const { x, y } = p.origin;
    if (
      cell.x >= x &&
      cell.x < x + p.size &&
      cell.y >= y &&
      cell.y < y + p.size
    ) {
      return p;
    }
  }
  return null;
}

export function platformAtCell(state: GameState, cell: Vec2): Platform | null {
  return platformAtCellRaw(state.platforms, cell);
}

/** 步道停稳后的世界端口（动画中不可移动，故只需离散朝向下的结果） */
export function runtimePorts(p: Platform): RuntimePort[] {
  const pivot = pivotOf(p.origin, p.size);
  const steps = ((p.orientation % 4) + 4) % 4;
  return p.ports.map((port) => {
    let local: Vec2 = {
      x: port.offset.x + 0.5 - p.size / 2,
      y: port.offset.y + 0.5 - p.size / 2,
    };
    let dir = port.dir;
    for (let i = 0; i < steps; i++) {
      local = rot90CW(local);
      dir = cwDir(dir);
    }
    const world = add(pivot, local);
    return {
      platformId: p.id,
      cell: { x: Math.floor(world.x), y: Math.floor(world.y) },
      dir,
    };
  });
}

function portAt(p: Platform, cell: Vec2): RuntimePort | undefined {
  return runtimePorts(p).find((rp) => eq(rp.cell, cell));
}

function staticKindAt(state: GameState, cell: Vec2): CellKind | null {
  if (cell.x < 0 || cell.y < 0 || cell.x >= state.cols || cell.y >= state.rows) {
    return 'wall';
  }
  return state.grid.get(key(cell)) ?? 'floor';
}

/**
 * 能否从 from 格走到 to 格。
 * 静态↔静态：只看地面可走性；
 * 涉及步道：必须端口位置与朝外朝向同时对上（静地面视作有反向“开口”）。
 */
export function canStep(state: GameState, from: Vec2, to: Vec2): boolean {
  if (state.phase !== 'idle') return false;
  if (to.x < 0 || to.y < 0 || to.x >= state.cols || to.y >= state.rows) {
    return false;
  }
  // 只处理正交相邻格；两块步道隔坑对口时允许同方向距离 2 的跨越（见下）
  const manhattan = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
  if (manhattan !== 1 && manhattan !== 2) return false;
  if (manhattan === 2 && (to.x === from.x || to.y === from.y) === false) {
    return false; // 必须同一直线，不允许对角
  }
  const fromPlatform = platformAtCell(state, from);
  const toPlatform = platformAtCell(state, to);

  // 隔坑对口：两块步道的端口同一直线、中间恰好一格空洞，
  // 且两侧端口的位置与朝外朝向都合上时，允许一步跨过去。
  if (manhattan === 2) {
    if (!fromPlatform || !toPlatform) return false;
    if (fromPlatform.id === toPlatform.id) return false;
    const dir = facingOf(from, to);
    const middle = add(from, DIR_VECTORS[dir]);
    if (staticKindAt(state, middle) !== 'pit') return false;
    const a = portAt(fromPlatform, from);
    const b = portAt(toPlatform, to);
    if (!a || !b) return false;
    return a.dir === dir && b.dir === OPPOSITE_DIR[dir];
  }

  if (toPlatform) {
    // 同一块步道内部走动
    if (fromPlatform && fromPlatform.id === toPlatform.id) return true;

    if (fromPlatform) {
      // 步道 A -> 步道 B：两块板的端口位置、朝向都要合上
      const a = portAt(fromPlatform, from);
      const b = portAt(toPlatform, to);
      if (!a || !b) return false;
      const dir = facingOf(from, to);
      return a.dir === dir && b.dir === OPPOSITE_DIR[dir];
    }
    // 静态地面 -> 步道：踏上板不挑端口（板的边格本身是可站立地面），
    // 但离开板时必须命中一个朝外端口。
    return true;
  }

  // 目标是静态格
  const kind = staticKindAt(state, to);
  if (kind !== 'floor') return false; // 墙 / 栏杆 / 空洞 / 越界 都不可走

  if (fromPlatform) {
    // 步道 -> 静态：步道端口必须朝目标
    const a = portAt(fromPlatform, from);
    if (!a) return false;
    return a.dir === facingOf(from, to);
  }
  return true;
}

function facingOf(from: Vec2, to: Vec2): Dir {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx > 0) return 'E';
  if (dx < 0) return 'W';
  if (dy > 0) return 'S';
  return 'N';
}

export interface WalkableEdge {
  from: Vec2;
  to: Vec2;
  dir: Dir;
}

/** 当前可走边：与可见地面严格吻合，逐格用 canStep 推出（含隔坑对口边） */
export function computeWalkableEdges(state: GameState): WalkableEdge[] {
  const edges: WalkableEdge[] = [];
  const dirs: Dir[] = ['N', 'E', 'S', 'W'];
  for (let y = 0; y < state.rows; y++) {
    for (let x = 0; x < state.cols; x++) {
      const from = { x, y };
      const occupiable =
        platformAtCell(state, from) || staticKindAt(state, from) === 'floor';
      if (!occupiable) continue;
      for (const dir of dirs) {
        const v = DIR_VECTORS[dir];
        for (const dist of [1, 2] as const) {
          const to = { x: from.x + v.x * dist, y: from.y + v.y * dist };
          if (canStep(state, from, to)) {
            edges.push({ from, to, dir });
          }
        }
      }
    }
  }
  return edges;
}

function insetCellBox(cell: Vec2): Vec2[] {
  return cellCorners(cell).map((c) => ({
    x: c.x + (c.x === cell.x ? HULL_INSET : -HULL_INSET),
    y: c.y + (c.y === cell.y ? HULL_INSET : -HULL_INSET),
  }));
}

function blockerLabel(kind: string, cell: Vec2): string {
  switch (kind) {
    case 'wall':
      return `墙角 (${cell.x},${cell.y})`;
    case 'rail':
      return `固定栏杆 (${cell.x},${cell.y})`;
    case 'platform':
      return '另一块步道';
    default:
      return `角色 (${cell.x},${cell.y})`;
  }
}

/**
 * 转动预检：沿 90° 行程逐角度做 SAT 碰撞。
 * 检出墙 / 栏杆 / 另一块步道 / 未乘板的角色即拒绝；
 * 同时返回扫过的格，用于显示“受影响范围”。
 */
export function previewRotation(
  state: GameState,
  platformId: 'A' | 'B',
  dir: RotDir,
): RotationPreview {
  const platform = platformById(state.platforms, platformId)!;
  const target = (dir === 'cw' ? 1 : -1) * (Math.PI / 2);
  const sweptCells = collectSweptCells(platform, target);
  const other = state.platforms.find((p) => p.id !== platformId) ?? null;
  const playerOnThis = state.player.aboard === platformId;

  for (let k = 1; k <= SAMPLES; k++) {
    const angle = (target * k) / SAMPLES;
    const poly = platformCorners(platform.origin, platform.size, angle);

    for (const cell of sweptCells) {
      const kind = staticKindAt(state, cell);
      if (kind === 'wall' || kind === 'rail') {
        if (polygonsIntersect(poly, insetCellBox(cell))) {
          return {
            platformId,
            dir,
            ok: false,
            blocker: {
              kind,
              cell,
              atAngle: Math.abs(angle),
              label: blockerLabel(kind, cell),
            },
            sweptCells,
          };
        }
      }
    }

    if (other) {
      const o = other.origin;
      const otherBox: Vec2[] = [
        { x: o.x, y: o.y },
        { x: o.x + other.size, y: o.y },
        { x: o.x + other.size, y: o.y + other.size },
        { x: o.x, y: o.y + other.size },
      ];
      if (polygonsIntersect(poly, otherBox)) {
        return {
          platformId,
          dir,
          ok: false,
          blocker: {
            kind: 'platform',
            cell: structuredClone(other.origin),
            atAngle: Math.abs(angle),
            label: blockerLabel('platform', other.origin),
          },
          sweptCells,
        };
      }
    }

    if (!playerOnThis) {
      const box = playerBox(state.player.pos);
      if (polygonsIntersect(poly, box)) {
        return {
          platformId,
          dir,
          ok: false,
          blocker: {
            kind: 'player',
            cell: structuredClone(state.player.cell),
            atAngle: Math.abs(angle),
            label: blockerLabel('player', state.player.cell),
          },
          sweptCells,
        };
      }
    }
  }

  return { platformId, dir, ok: true, blocker: null, sweptCells };
}

/** 转动过程中平台覆盖到的所有格（含停稳占位与菱形扫掠区） */
function collectSweptCells(platform: Platform, target: number): Vec2[] {
  const found = new Map<string, Vec2>();
  const push = (p: Vec2) => {
    const cell = { x: Math.floor(p.x), y: Math.floor(p.y) };
    found.set(key(cell), cell);
  };
  // 每条边按 1/4 格步长密集取点，避免只采角点/中点漏掉边扫过的格
  const EDGE_STEPS = platform.size * 4;
  for (let k = 0; k <= SAMPLES; k++) {
    const angle = (target * k) / SAMPLES;
    const corners = platformCorners(platform.origin, platform.size, angle);
    for (let i = 0; i < corners.length; i++) {
      const a = corners[i];
      const b = corners[(i + 1) % corners.length];
      for (let t = 0; t <= EDGE_STEPS; t++) {
        const f = t / EDGE_STEPS;
        push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
      }
    }
    push(pivotOf(platform.origin, platform.size));
  }
  return [...found.values()];
}

/** 尝试启动转动；被挡时不改任何位置/通路，只回传预览与原因 */
export function startRotation(
  state: GameState,
  platformId: 'A' | 'B',
  dir: RotDir,
): boolean {
  if (state.phase !== 'idle') return false;
  const preview = previewRotation(state, platformId, dir);
  state.preview = preview;
  if (!preview.ok) {
    const b = preview.blocker!;
    const atDeg = Math.round((b.atAngle * 180) / Math.PI);
    state.banner = `转动被${b.label}截停（约 ${atDeg}°处），步道与通路保持原位`;
    state.bannerTimer = 2.4;
    return false;
  }
  const platform = platformById(state.platforms, platformId)!;
  platform.animDir = dir;
  platform.animTarget = (dir === 'cw' ? 1 : -1) * (Math.PI / 2);
  platform.animAngle = 0;
  if (state.player.aboard === platformId) {
    // 记录角色相对枢轴的本地坐标，转动时随板一起走
    state.player.localOffset = subtract(
      state.player.pos,
      pivotOf(platform.origin, platform.size),
    );
  }
  state.phase = 'rotating';
  state.banner = '';
  state.bannerTimer = 0;
  return true;
}

export function tryMove(state: GameState, dir: Dir): void {
  if (state.phase !== 'idle') return;
  if (state.player.moveTimer > 0) return;
  const from = state.player.cell;
  const step = DIR_VECTORS[dir];
  const adjacent = add(from, step);

  // 优先尝试相邻格；相邻格是空洞时，再尝试隔坑对口跨越（距离 2）
  if (canStep(state, from, adjacent)) {
    commitMove(state, adjacent);
    return;
  }
  const across = add(adjacent, step);
  if (canStep(state, from, across)) {
    commitMove(state, across);
  }
}

function commitMove(state: GameState, to: Vec2): void {
  state.player.cell = to;
  const targetPlatform = platformAtCell(state, to);
  state.player.aboard = targetPlatform?.id ?? null;
  state.player.localOffset = targetPlatform
    ? subtract(cellCenter(to), pivotOf(targetPlatform.origin, targetPlatform.size))
    : null;
  state.player.moveTimer = MOVE_COOLDOWN;
}

export function update(state: GameState, dt: number): void {
  if (state.bannerTimer > 0) {
    state.bannerTimer = Math.max(0, state.bannerTimer - dt);
    if (state.bannerTimer === 0 && state.phase !== 'won') state.banner = '';
  }
  state.player.moveTimer = Math.max(0, state.player.moveTimer - dt);

  const rotating = state.platforms.find((p) => p.animDir !== null);
  if (rotating && state.phase === 'rotating') {
    const sign = rotating.animDir === 'cw' ? 1 : -1;
    const step = (dt / ROTATION_DURATION) * (Math.PI / 2);
    rotating.animAngle = clamp(
      rotating.animAngle + sign * step,
      -Math.PI / 2,
      Math.PI / 2,
    );

    if (state.player.aboard === rotating.id && state.player.localOffset) {
      const pivot = pivotOf(rotating.origin, rotating.size);
      const world = localToWorld(
        state.player.localOffset,
        pivot,
        rotating.animAngle,
      );
      state.player.pos = world;
      state.player.cell = { x: Math.floor(world.x), y: Math.floor(world.y) };
    }

    if (Math.abs(rotating.animAngle) >= Math.PI / 2 - 1e-6) {
      finishRotation(state, rotating);
    }
    return;
  }

  // 停稳时角色渲染坐标平滑跟随所在格中心
  const center = cellCenter(state.player.cell);
  state.player.pos = {
    x: lerp(state.player.pos.x, center.x, Math.min(1, dt * 14)),
    y: lerp(state.player.pos.y, center.y, Math.min(1, dt * 14)),
  };

  if (
    state.phase === 'idle' &&
    eq(state.player.cell, state.exit)
  ) {
    state.phase = 'won';
    state.banner = '抵达出口，房间打通！按 R 重来';
    state.bannerTimer = 9999;
  }
}

function finishRotation(state: GameState, platform: Platform): void {
  const dir = platform.animDir!;
  platform.orientation = (platform.orientation + (dir === 'cw' ? 1 : 3)) % 4;
  platform.animAngle = 0;
  platform.animTarget = 0;
  platform.animDir = null;

  if (state.player.aboard === platform.id && state.player.localOffset) {
    // 本地偏移也完成 90° 旋转，得到停稳后的新格
    const rotated =
      dir === 'cw'
        ? rot90CW(state.player.localOffset)
        : rotatePoint(state.player.localOffset, -Math.PI / 2);
    state.player.localOffset = rotated;
    const pivot = pivotOf(platform.origin, platform.size);
    const world = add(pivot, rotated);
    state.player.cell = { x: Math.floor(world.x), y: Math.floor(world.y) };
    state.player.pos = cellCenter(state.player.cell);
  }
  state.phase = 'idle';
  state.preview = null;
}

export function reset(state: GameState): GameState {
  return createGameState(state.level);
}

export function setPreview(
  state: GameState,
  platformId: 'A' | 'B' | null,
  dir: RotDir = 'cw',
): void {
  if (state.phase !== 'idle') return;
  state.preview = platformId ? previewRotation(state, platformId, dir) : null;
}
