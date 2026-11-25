import {
  add,
  clamp,
  dist,
  normalize,
  scale,
  smoothstep,
  sub,
  vec,
  type Vec2,
} from '../vec';
import { finalizeReadout, stepBoat } from './physics';
import type { Boat, BoatReadout, Buoy, CurrentZone, Inputs, WindState } from './types';

export const WORLD_W = 1000;
export const WORLD_H = 900;
export const BOAT_RADIUS = 7;
export const FIXED_DT = 1 / 60;
const SUBSTEPS = 2;

export interface World {
  wind: WindState;
  currents: CurrentZone[];
  buoys: Buoy[];
  width: number;
  height: number;
  time: number;
}

export function createWorld(wind: WindState, buoys: Buoy[], currents: CurrentZone[]): World {
  return {
    wind,
    buoys,
    currents,
    width: WORLD_W,
    height: WORLD_H,
    time: 0,
  };
}

/** 采样某点的水流速度；多个水区取矢量和，边缘按 feather 平滑过渡。 */
export function sampleCurrent(world: World, p: Vec2): Vec2 {
  let total = vec(0, 0);
  for (const z of world.currents) {
    const fx =
      smoothstep(z.x0, z.x0 + z.feather, p.x) *
      (1 - smoothstep(z.x1 - z.feather, z.x1, p.x));
    const fy =
      smoothstep(z.y0, z.y0 + z.feather, p.y) *
      (1 - smoothstep(z.y1 - z.feather, z.y1, p.y));
    total = add(total, scale(z.velocity, fx * fy));
  }
  return total;
}

/**
 * 浮标碰撞：只做位置约束 + 速度法向消除。
 * 不改船头方向、不施加转向，所以不会出现"撞一下突然转向"。
 * 返回发生接触的浮标 id（无则 null）。
 */
export function resolveBuoyCollision(boat: Boat, buoys: Buoy[]): number | null {
  let hitId: number | null = null;
  for (const b of buoys) {
    const d = dist(boat.pos, b.pos);
    const minD = b.radius + BOAT_RADIUS;
    if (d >= minD || d < 1e-6) continue;
    const n = normalize(sub(boat.pos, b.pos)); // 浮标 -> 船
    // 1. 推出到接触面
    boat.pos = add(b.pos, scale(n, minD));
    // 2. 消除指向浮标的速度分量（保留切向，船会顺着浮标滑开）
    const vn = boat.vel.x * n.x + boat.vel.y * n.y;
    if (vn < 0) {
      boat.vel = sub(boat.vel, scale(n, vn * 1.05));
    }
    boat.contact = scale(n, minD - d);
    hitId = b.id;
  }
  return hitId;
}

/** 世界边界：软墙，贴边时衰减速度。 */
function clampToWorld(boat: Boat, w: World): void {
  const m = BOAT_RADIUS + 2;
  const x = clamp(boat.pos.x, m, w.width - m);
  const y = clamp(boat.pos.y, m, w.height - m);
  if (x !== boat.pos.x) {
    boat.vel.x *= -0.25;
    boat.pos.x = x;
  }
  if (y !== boat.pos.y) {
    boat.vel.y *= -0.25;
    boat.pos.y = y;
  }
}

export interface StepResult {
  readout: BoatReadout;
  collisionBuoyId: number | null;
}

/** 固定步长推进一帧（内部子步进），水流在位置积分时叠加。 */
export function stepWorld(world: World, boat: Boat, input: Inputs): StepResult {
  const dt = FIXED_DT / SUBSTEPS;
  let readout: BoatReadout | null = null;
  let collisionBuoyId: number | null = null;

  for (let i = 0; i < SUBSTEPS; i++) {
    readout = stepBoat(boat, input, world.wind, dt);
    const current = sampleCurrent(world, boat.pos);
    finalizeReadout(readout, boat, current);
    // 位置 = 对水速度 + 水流；穿过水区边缘时自然产生漂移
    boat.pos = add(boat.pos, scale(add(boat.vel, current), dt));
    collisionBuoyId = resolveBuoyCollision(boat, world.buoys) ?? collisionBuoyId;
    clampToWorld(boat, world);
  }

  world.time += FIXED_DT;
  return { readout: readout!, collisionBuoyId };
}
