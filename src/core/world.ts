import { KEY_DOWN, KEY_LEFT, KEY_RIGHT, KEY_UP, TICK_MS, Vec2, Wall, WorldDef } from './protocol';

/** 权威推挤区：权威端每 tick 对区内角色施加额外位移，客户端不模拟（不可预测的权威效果） */
export interface PushZone {
  x: number;
  y: number;
  w: number;
  h: number;
  vx: number; // 像素/秒
  vy: number;
}

/** 程序生成的小地图：外墙 + 内部若干墙体（含可“转角碰墙”的 L 形组合） */
export function createWorld(): WorldDef {
  const width = 820;
  const height = 580;
  const wallT = 16;
  const walls: Wall[] = [
    // 外墙
    { x: 0, y: 0, w: width, h: wallT },
    { x: 0, y: height - wallT, w: width, h: wallT },
    { x: 0, y: 0, w: wallT, h: height },
    { x: width - wallT, y: 0, w: wallT, h: height },
    // 内部障碍
    { x: 220, y: 120, w: 180, h: 26 }, // 横墙（下方可沿转角滑过去）
    { x: 220, y: 120, w: 26, h: 150 }, // 与横墙组成 L 形转角
    { x: 520, y: 220, w: 26, h: 200 }, // 竖墙
    { x: 520, y: 220, w: 150, h: 26 }, // T 形横段
    { x: 330, y: 400, w: 150, h: 26 }, // 底部横墙
  ];
  return {
    width,
    height,
    radius: 14,
    speed: 230, // 像素/秒
    walls,
    spawn: { x: 90, y: height - 90 },
    pushZone: { x: 330, y: 480, w: 150, h: 72, vx: 95, vy: 0 },
  };
}

/**
 * 单个固定步长的移动 + 碰撞解算。
 * 客户端预测端与权威端调用的是同一个函数、同一份速度/半径/墙体数据，
 * 因此同样的输入序列必然产生同样的位置（浮点运算顺序也一致）。
 * 轴分离：先解算 x 再解算 y，贴墙时自然产生沿墙滑动。
 */
export function moveStep(world: WorldDef, pos: Vec2, keys: number, dtMs: number = TICK_MS): Vec2 {
  let dx = 0;
  let dy = 0;
  if (keys & KEY_UP) dy -= 1;
  if (keys & KEY_DOWN) dy += 1;
  if (keys & KEY_LEFT) dx -= 1;
  if (keys & KEY_RIGHT) dx += 1;
  if (dx !== 0 && dy !== 0) {
    const inv = 1 / Math.SQRT2;
    dx *= inv;
    dy *= inv;
  }
  const dt = dtMs / 1000;
  const next: Vec2 = { x: pos.x, y: pos.y };

  // ---- X 轴 ----
  next.x += dx * world.speed * dt;
  for (const wall of world.walls) {
    resolveAxis(world, next, wall, true);
  }
  clampToBounds(world, next);

  // ---- Y 轴 ----
  next.y += dy * world.speed * dt;
  for (const wall of world.walls) {
    resolveAxis(world, next, wall, false);
  }
  clampToBounds(world, next);
  return next;
}

/** 圆 vs 轴对齐矩形：按最近点求出穿透深度，把圆沿当前运动轴推出墙体 */
function resolveAxis(world: WorldDef, p: Vec2, wall: Wall, horizontal: boolean): void {
  const nearestX = clamp(p.x, wall.x, wall.x + wall.w);
  const nearestY = clamp(p.y, wall.y, wall.y + wall.h);
  const ox = p.x - nearestX;
  const oy = p.y - nearestY;
  const distSq = ox * ox + oy * oy;
  if (distSq >= world.radius * world.radius) return; // 未相交

  const dist = Math.sqrt(distSq);
  if (dist > 1e-9) {
    // 圆心在矩形外：沿最近点方向推出
    const push = world.radius - dist;
    p.x += (ox / dist) * push;
    p.y += (oy / dist) * push;
  } else if (horizontal) {
    // 圆心在矩形内（高速穿透等极端情况）：按运动方向水平推出
    const fromLeft = p.x - wall.x;
    const fromRight = wall.x + wall.w - p.x;
    p.x = fromLeft < fromRight ? wall.x - world.radius : wall.x + wall.w + world.radius;
  } else {
    const fromTop = p.y - wall.y;
    const fromBottom = wall.y + wall.h - p.y;
    p.y = fromTop < fromBottom ? wall.y - world.radius : wall.y + wall.h + world.radius;
  }
}

function clampToBounds(world: WorldDef, p: Vec2): void {
  p.x = clamp(p.x, world.radius, world.width - world.radius);
  p.y = clamp(p.y, world.radius, world.height - world.radius);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 权威端独有的推挤区效果（客户端不调用）：角色圆心在区内时获得额外速度。
 * 碰撞仍走同一套 resolveAxis，保证“被推到墙里”时的处理两端规则一致。
 */
export function applyPushZone(world: WorldDef, pos: Vec2, dtMs: number = TICK_MS): Vec2 {
  const z = world.pushZone;
  const inside = pos.x >= z.x && pos.x <= z.x + z.w && pos.y >= z.y && pos.y <= z.y + z.h;
  if (!inside) return pos;
  const dt = dtMs / 1000;
  const next: Vec2 = { x: pos.x + z.vx * dt, y: pos.y + z.vy * dt };
  for (const wall of world.walls) {
    resolveAxis(world, next, wall, z.vx !== 0);
    resolveAxis(world, next, wall, z.vy !== 0);
  }
  clampToBounds(world, next);
  return next;
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
