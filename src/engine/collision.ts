import type { AABB, PlatformDef, Solid, WorldPreset } from './types';

export function overlap(a: AABB, b: AABB): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * 三角波往返位置（确定性、与浮点累加无关）。
 * phase = 0 → 起点；phase = halfPeriod → 另一端；phase = 2*halfPeriod → 回到起点。
 * 偏移在 [-range, +range] 之间线性变化，端点处速度为有限值并立即换向。
 */
export function triangleOffset(elapsed: number, range: number, halfPeriod: number): number {
  const period = halfPeriod * 2;
  const p = ((elapsed % period) + period) % period;
  if (p <= halfPeriod) {
    return -range + (2 * range * p) / halfPeriod;
  }
  return range - (2 * range * (p - halfPeriod)) / halfPeriod;
}

export function platformBox(def: PlatformDef, time: number): AABB {
  const off = triangleOffset(time, def.range, def.halfPeriod);
  return def.axis === 'horizontal'
    ? { x: def.baseX + off, y: def.baseY, w: def.w, h: def.h }
    : { x: def.baseX, y: def.baseY + off, w: def.w, h: def.h };
}

/** 平台瞬时速度：用相邻两个解析时刻的位置差计算，换向帧自然给出换向前后速度 */
export function platformVelocity(def: PlatformDef, time: number, dt: number): { vx: number; vy: number } {
  const a = platformBox(def, time);
  const b = platformBox(def, time + dt);
  return { vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt };
}

/** 生成某一时刻参与碰撞的全部实体（静态 + 移动平台） */
export function buildSolids(preset: WorldPreset, time: number, dt: number): Solid[] {
  const solids: Solid[] = preset.statics.map((s) => ({
    ...s,
    vx: 0,
    vy: 0,
    moving: false,
  }));
  for (const def of preset.platforms) {
    const box = platformBox(def, time);
    const v = platformVelocity(def, time, dt);
    solids.push({
      id: def.id,
      kind: 'platform',
      label: def.label,
      ...box,
      vx: v.vx,
      vy: v.vy,
      moving: true,
    });
  }
  return solids;
}
