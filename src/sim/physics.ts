import type { Character, Input, LedgeRef, Platform, Rect, World } from './types.js';

// ---- 调参常量 ----
export const GRAVITY = 2200;          // px/s^2
export const MOVE_SPEED = 240;        // 水平移动速度
export const JUMP_VEL = -720;         // 起跳速度(向上为负)
export const WALL_SLIDE_SPEED = 130;  // 贴墙滑落的最大下落速度
export const WALL_JUMP_VX = 340;      // 蹬墙跳水平冲量
export const GRAB_RANGE = 16;         // 可抓范围(手到边角的距离)
export const HAND_OFFSET = 4;         // 手部相对角色顶部的偏移
export const MANTLE_TIME = 0.35;      // 翻身动作时长(s)
export const CHAR_W = 24;
export const CHAR_H = 40;

export function createCharacter(spawn: { x: number; y: number }): Character {
  return {
    x: spawn.x, y: spawn.y, w: CHAR_W, h: CHAR_H,
    vx: 0, vy: 0, facing: 1,
    state: 'air', ledge: null,
    grabCooldown: 0, impulseT: 0, impulseVx: 0,
    mantleT: 0,
    mantleFrom: { x: 0, y: 0 }, mantleTo: { x: 0, y: 0 },
    mantleBlockedFlash: 0,
  };
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** 平台某侧顶角(可抓边缘)的世界坐标 */
export function ledgeCorner(p: Platform, side: 'left' | 'right'): { x: number; y: number } {
  return { x: side === 'left' ? p.x : p.x + p.w, y: p.y };
}

/** 悬挂时的吸附位置:身体贴在平台侧面, 手(顶部)与边缘齐平 */
function snapToLedge(c: Character, p: Platform, side: 'left' | 'right'): void {
  c.y = p.y;
  if (side === 'left') { c.x = p.x - c.w; c.facing = 1; }
  else { c.x = p.x + p.w; c.facing = -1; }
}

/** 翻身落点:站上平台顶面, 水平方向向内让 2px */
function mantleTarget(c: Character, p: Platform, side: 'left' | 'right'): { x: number; y: number } {
  const y = p.y - c.h;
  const x = side === 'left' ? p.x + 2 : p.x + p.w - c.w - 2;
  return { x, y };
}

/** 检测当前是否能抓住某个边缘; 能则返回 LedgeRef */
export function findGrabbableLedge(world: World, c: Character): LedgeRef | null {
  const handX = c.facing > 0 ? c.x + c.w : c.x;
  const handY = c.y + HAND_OFFSET;
  for (const p of world.platforms) {
    if (!p.grabbable) continue;
    for (const side of ['left', 'right'] as const) {
      const corner = ledgeCorner(p, side);
      if (Math.abs(handX - corner.x) <= GRAB_RANGE && Math.abs(handY - corner.y) <= GRAB_RANGE) {
        return { platId: p.id, side };
      }
    }
  }
  return null;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * 推进一帧仿真。固定 dt 调用(主循环与验证器都用 1/60)。
 *
 * 支撑解除的三条路径:
 *  1. 按键取消: ledge 状态下按 down -> 松手进入 air
 *  2. 下落走离: ground 上走出平台边缘 -> 失去支撑进入 air
 *  3. 翻身动作: ledge 状态下按 jump -> 若落点无碰撞进入 mantle, 完成后站上平台;
 *               若落点与碰撞体重叠(低顶) -> 不进入碰撞体, 保持 ledge 悬挂(可控状态)
 */
export function step(world: World, c: Character, input: Input, dt: number): void {
  c.grabCooldown = Math.max(0, c.grabCooldown - dt);
  c.mantleBlockedFlash = Math.max(0, c.mantleBlockedFlash - dt);

  // ---- 抓住边缘悬挂 ----
  if (c.state === 'ledge' && c.ledge) {
    const plat = world.platforms.find((p) => p.id === c.ledge!.platId)!;
    snapToLedge(c, plat, c.ledge.side);
    c.vx = 0; c.vy = 0;

    if (input.down) {
      // 按键取消支撑: 松手下落
      c.state = 'air';
      c.ledge = null;
      c.vy = 80;
      c.grabCooldown = 0.3;
      return;
    }
    if (input.jumpPressed) {
      const to = mantleTarget(c, plat, c.ledge.side);
      const box: Rect = { x: to.x, y: to.y, w: c.w, h: c.h };
      if (world.platforms.some((p) => overlaps(box, p))) {
        // 平台空间不够: 不翻进碰撞体, 留在悬挂态(可控), 给 HUD 一个提示
        c.mantleBlockedFlash = 0.6;
      } else {
        c.state = 'mantle';
        c.mantleT = 0;
        c.mantleFrom = { x: c.x, y: c.y };
        c.mantleTo = to;
      }
    }
    return;
  }

  // ---- 翻身过程(落点已在起跳前校验, 过程中免碰撞) ----
  if (c.state === 'mantle') {
    c.mantleT += dt / MANTLE_TIME;
    const t = Math.min(1, c.mantleT);
    // 两段式路径: 先垂直升起越过台面(60%), 再水平移入落点(40%),
    // 避免斜线插值刮穿平台边角
    const RISE = 0.6;
    if (t < RISE) {
      const e = t / RISE;
      c.x = c.mantleFrom.x;
      c.y = lerp(c.mantleFrom.y, c.mantleTo.y, e * e * (3 - 2 * e));
    } else {
      const e = (t - RISE) / (1 - RISE);
      c.x = lerp(c.mantleFrom.x, c.mantleTo.x, e * e * (3 - 2 * e));
      c.y = c.mantleTo.y;
    }
    c.vx = 0; c.vy = 0;
    if (t >= 1) {
      c.state = 'ground';
      c.ledge = null;
    }
    return;
  }

  // ---- ground / air / wallslide ----
  const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  if (dir !== 0) c.facing = dir as 1 | -1;

  if (c.impulseT > 0) {
    c.impulseT -= dt;
    c.vx = c.impulseVx;
  } else {
    c.vx = dir * MOVE_SPEED;
  }

  if (input.jumpPressed) {
    if (c.state === 'ground') {
      c.vy = JUMP_VEL;
      c.state = 'air';
    } else if (c.state === 'wallslide') {
      // 蹬墙跳: 向上 + 离墙水平冲量
      c.vy = JUMP_VEL * 0.95;
      c.impulseVx = -c.facing * WALL_JUMP_VX;
      c.impulseT = 0.18;
      c.facing = -c.facing as 1 | -1;
      c.state = 'air';
    }
  }

  c.vy += GRAVITY * dt;
  if (c.state === 'wallslide') c.vy = Math.min(c.vy, WALL_SLIDE_SPEED);

  // X 方向移动与碰撞
  c.x += c.vx * dt;
  let wallDir = 0; // 1: 墙在右侧; -1: 墙在左侧
  for (const p of world.platforms) {
    if (overlaps(c, p)) {
      if (c.vx > 0) { c.x = p.x - c.w; wallDir = 1; }
      else if (c.vx < 0) { c.x = p.x + p.w; wallDir = -1; }
    }
  }

  // Y 方向移动与碰撞
  c.y += c.vy * dt;
  let grounded = false;
  for (const p of world.platforms) {
    if (overlaps(c, p)) {
      if (c.vy > 0) { c.y = p.y - c.h; grounded = true; }
      else if (c.vy < 0) { c.y = p.y + p.h; }
      c.vy = 0;
    }
  }

  // 状态迁移(下落走离: 上一帧有支撑, 本帧脚下无平台 -> air)
  if (grounded) {
    c.state = 'ground';
  } else {
    const pressingWall = (wallDir === 1 && input.right) || (wallDir === -1 && input.left);
    c.state = wallDir !== 0 && pressingWall && c.vy >= 0 ? 'wallslide' : 'air';
    // 进入贴墙滑落的当帧也把 vy 钳到上限, 保证滑落期间速度不超标
    if (c.state === 'wallslide') c.vy = Math.min(c.vy, WALL_SLIDE_SPEED);
  }

  // 下落中检测可抓边缘
  if (!grounded && c.vy >= 0 && c.grabCooldown <= 0) {
    const ledge = findGrabbableLedge(world, c);
    if (ledge) {
      c.ledge = ledge;
      c.state = 'ledge';
      c.vx = 0; c.vy = 0;
      const plat = world.platforms.find((p) => p.id === ledge.platId)!;
      snapToLedge(c, plat, ledge.side);
    }
  }
}
