import { describe, expect, it } from 'vitest';
import { pointInAABB, rayVsAABB, sphereSweepAABB, sphereToAABBClearance, type AABB } from '../src/math/aabb';
import { CameraCollisionSolver, DEFAULT_CAMERA_CONFIG } from '../src/math/camera';
import { moveCharacter } from '../src/math/character';
import { v3 } from '../src/math/vector';

function wallAtZ(z: number, thickness = 0.5, name = '墙'): AABB {
  return {
    min: { x: -10, y: 0, z: z - thickness / 2 },
    max: { x: 10, y: 4, z: z + thickness / 2 },
    name,
  };
}

describe('rayVsAABB', () => {
  it('直射墙面返回精确进入距离', () => {
    const wall = wallAtZ(-5);
    const hit = rayVsAABB(v3.create(0, 1, 0), v3.create(0, 0, -1), wall);
    expect(hit).not.toBeNull();
    expect(hit!.tEnter).toBeCloseTo(4.75, 6);
  });

  it('平行偏离时不命中', () => {
    const wall = wallAtZ(-5);
    const hit = rayVsAABB(v3.create(20, 1, 0), v3.create(0, 0, -1), wall);
    expect(hit).toBeNull();
  });

  it('起点在盒内时 tEnter 为负', () => {
    const wall = wallAtZ(0);
    const hit = rayVsAABB(v3.create(0, 1, 0), v3.create(0, 0, -1), wall);
    expect(hit).not.toBeNull();
    expect(hit!.tEnter).toBeLessThan(0);
  });
});

describe('sphereSweepAABB', () => {
  it('球扫掠在墙前保留半径余量', () => {
    // 墙中心 z=-5、厚 0.5 → 近侧 z=-5.25；r=0.3 → 球心停在 z=-4.95，行进 4.45
    const wall = wallAtZ(-5);
    const t = sphereSweepAABB(v3.create(0, 1, 0), v3.create(0, 0, -1), 0.3, wall);
    expect(t).toBeCloseTo(4.45, 6);
  });

  it('斜向掠墙角时由膨胀角点（而非中心射线）决定接触距离', () => {
    // 盒角 (-2,-2) 恰在原点 45° 射线上：中心射线在 t=2√2 才擦过角点，
    // 膨胀 r=0.3 后提前在 t=2√2-0.3 接触，接触点即该盒角
    const box: AABB = {
      min: { x: -4, y: 0, z: -4 },
      max: { x: -2, y: 4, z: -2 },
      name: '角块',
    };
    const dir = v3.normalize(v3.create(), v3.create(-1, 0, -1));
    const t = sphereSweepAABB(v3.create(0, 1, 0), dir, 0.3, box);
    expect(t).toBeGreaterThan(0);
    const center = v3.add(v3.create(), v3.create(0, 1, 0), v3.scale(v3.create(), dir, t));
    // 45° 射线进入盒的 max.x=-2 平面，球心在盒外，到该面垂直距离恰为半径
    expect(Math.abs(box.max.x - center.x)).toBeCloseTo(0.3, 5);
    // 对照：不带半径的中心射线 slab 命中在更远处（球体余量真实生效）
    const centerHit = rayVsAABB(v3.create(0, 1, 0), dir, box);
    expect(centerHit!.tEnter).toBeCloseTo(2 * Math.SQRT2, 5);
    expect(centerHit!.tEnter).toBeGreaterThan(t);
  });

  it('低顶：向上扫掠被顶板挡住', () => {
    const ceil: AABB = {
      min: { x: -5, y: 1.9, z: -5 },
      max: { x: 5, y: 2.3, z: 5 },
      name: '顶板',
    };
    const t = sphereSweepAABB(v3.create(0, 1.0, 0), v3.create(0, 1, 0), 0.3, ceil);
    expect(t).toBeCloseTo(0.6, 6); // 1.9-0.3-1.0
  });
});

describe('moveCharacter', () => {
  it('撞墙停在半径外并可沿墙滑动', () => {
    // 墙中心 z=-5、厚 0.5 → max.z=-4.75；角色以真实帧步长（0.1m）连续冲向墙，
    // 停在墙 +z 侧 max.z+radius = -4.3
    const wall = wallAtZ(-5);
    const pos = v3.create(0, 0, -3);
    for (let i = 0; i < 60; i++) {
      moveCharacter(pos, v3.create(0, 0, -0.1), 0.45, [wall]);
    }
    expect(pos.z).toBeCloseTo(-4.3, 6);
    // 沿墙 X 方向滑动不受阻，Z 保持推出位置
    for (let i = 0; i < 30; i++) {
      moveCharacter(pos, v3.create(0.1, 0, 0), 0.45, [wall]);
    }
    expect(pos.x).toBeCloseTo(3, 6);
    expect(pos.z).toBeCloseTo(-4.3, 6);
  });

  it('墙角处逐轴推出不穿透', () => {
    const box: AABB = { min: { x: 1, y: 0, z: -3 }, max: { x: 3, y: 3, z: -1 }, name: '块' };
    const pos = v3.create(0.5, 0, -0.5);
    moveCharacter(pos, v3.create(2, 0, -2), 0.45, [box]);
    const clearance = Math.hypot(
      Math.max(box.min.x - pos.x, 0, pos.x - box.max.x),
      Math.max(box.min.z - pos.z, 0, pos.z - box.max.z),
    );
    expect(clearance).toBeGreaterThanOrEqual(0.45 - 1e-6);
  });
});

describe('CameraCollisionSolver', () => {
  const makeSolver = (overrides: Partial<typeof DEFAULT_CAMERA_CONFIG> = {}) =>
    new CameraCollisionSolver({ ...DEFAULT_CAMERA_CONFIG, aspect: 1.0, ...overrides });

  it('墙前缩近：实际距离收敛到安全距离且球面不穿墙', () => {
    const wall = wallAtZ(-5);
    const solver = makeSolver();
    const pivot = v3.create(0, 1.55, -2);
    // 横墙扫掠上限 2.93；但低俯仰下地面更早接管（球心 y=0.32 触地）
    for (let i = 0; i < 240; i++) solver.update(pivot, 0, 0.35, 5.0, 1 / 60, [wall]);
    const r = solver.update(pivot, 0, 0.35, 5.0, 1 / 60, [wall]);
    expect(r.constrained).toBe(false);
    expect(r.actualDistance).toBeCloseTo(r.safeDistance, 2);
    expect(r.minClearance).toBeGreaterThanOrEqual(-1e-4);
    expect(r.safeDistance).toBeLessThan(3.0);
  });

  it('离墙恢复：多帧后平滑回到期望距离，过程单调且不穿墙', () => {
    const wall = wallAtZ(-5);
    const solver = makeSolver();
    const near = v3.create(0, 1.55, -2);
    for (let i = 0; i < 240; i++) solver.update(near, 0, 0.3, 5.0, 1 / 60, [wall]);
    const far = v3.create(0, 1.55, 6);
    let prevActual = 0;
    for (let i = 0; i < 400; i++) {
      const r = solver.update(far, 0, 0.3, 5.0, 1 / 60, [wall]);
      expect(r.actualDistance).toBeGreaterThanOrEqual(prevActual - 1e-9);
      expect(r.minClearance).toBeGreaterThanOrEqual(-1e-4);
      prevActual = r.actualDistance;
    }
    const end = solver.update(far, 0, 0.3, 5.0, 1 / 60, [wall]);
    expect(end.actualDistance).toBeGreaterThan(4.95);
  });

  it('小半径时近裁剪面角点接管约束，二分回退后角点不进盒', () => {
    // 抬头看一块顶板：r 很小、near 较大时，近裁面上角的垂直触达超过球体，
    // 九点检查先于球体扫略触发（对照：调大 r 后该约束消失）
    const slab: AABB = {
      min: { x: -8, y: 1.35, z: -8 },
      max: { x: 8, y: 1.75, z: 8 },
      name: '顶板',
    };
    const solver = makeSolver({ collisionRadius: 0.05, near: 0.3 });
    const pivot = v3.create(0, 1.0, 0);
    const r = solver.update(pivot, 0, -0.25, 5.0, 1 / 60, [slab]);
    expect(r.frustumClamped).toBe(true);
    expect(r.constrained).toBe(false);
    expect(pointInAABB(r.actualPos, slab)).toBe(false);
    expect(r.safeDistance).toBeGreaterThan(0.8);
  });

  it('窄槽中最优距离小于公布最小距离时报告受限且位姿不穿模', () => {
    // 槽沿相机射线方向（-Z），墙在 ±0.32：球（r=0.32）只能贴着槽心走，
    // 任何 d>0 都顶墙，最优距离 0 → 受限
    const boxes: AABB[] = [
      { min: { x: -3, y: 0, z: -6 }, max: { x: -0.32, y: 4, z: 4 }, name: '左垛' },
      { min: { x: 0.32, y: 0, z: -6 }, max: { x: 3, y: 4, z: 4 }, name: '右垛' },
    ];
    const solver = makeSolver();
    const pivot = v3.create(0, 1.55, 0);
    const r = solver.update(pivot, 0, 0, 5.0, 1 / 60, boxes);
    expect(r.constrained).toBe(true);
    expect(r.safeDistance).toBeLessThan(0.8);
    expect(r.minClearance).toBeGreaterThanOrEqual(-1e-4);
    expect(pointInAABB(r.actualPos, boxes[0])).toBe(false);
    expect(pointInAABB(r.actualPos, boxes[1])).toBe(false);
  });

  it('边界抖动：目标在死区内小幅来回时实际距离不抽动', () => {
    const wall = wallAtZ(-5);
    const solver = makeSolver();
    const pivot = v3.create(0, 1.55, -2);
    for (let i = 0; i < 180; i++) solver.update(pivot, 0, 0.3, 5.0, 1 / 60, [wall]);
    const base = solver.update(pivot, 0, 0.3, 5.0, 1 / 60, [wall]);
    let maxJump = 0;
    let prev = base.actualDistance;
    for (let i = 0; i < 200; i++) {
      const wiggle = (i % 2 === 0 ? 1 : -1) * 0.015;
      const movedPivot = v3.create(0, 1.55, -2 + wiggle);
      const r = solver.update(movedPivot, 0, 0.3, 5.0, 1 / 60, [wall]);
      maxJump = Math.max(maxJump, Math.abs(r.actualDistance - prev));
      prev = r.actualDistance;
    }
    expect(maxJump).toBeLessThan(0.05);
  });

  it('球体贴墙时净距读数约为 0', () => {
    // 墙 max.z=-4.75，球在 +z 外侧；相切球心 z=-4.75+0.3=-4.45
    const wall = wallAtZ(-5);
    expect(sphereToAABBClearance(v3.create(0, 1, -4.45), 0.3, wall)).toBeCloseTo(0, 6);
    expect(sphereToAABBClearance(v3.create(0, 1, -4.55), 0.3, wall)).toBeCloseTo(-0.1, 6);
    expect(sphereToAABBClearance(v3.create(0, 1, -4.35), 0.3, wall)).toBeCloseTo(0.1, 6);
  });
});
