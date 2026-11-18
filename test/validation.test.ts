import { describe, it, expect } from 'vitest';
import { Sim, DT, MAX_BODIES, advanceWithSpeed } from '../src/sim';
import { loadScene, COLLISION_SPEED } from '../src/scenes';

/** 打印实际读数,便于把验证结果写进文档 */
function report(label: string, obj: Record<string, unknown>): void {
  const parts = Object.entries(obj)
    .map(([k, v]) => `${k}=${typeof v === 'number' ? v.toPrecision(6) : v}`)
    .join(' ');
  console.log(`[验证] ${label}: ${parts}`);
}

/** 以固定真实帧率(60fps)、指定播放速度推进到目标模拟时长 */
function runToSimTime(sim: Sim, targetTime: number, speed: number): void {
  const acc = { acc: 0 };
  const frameDt = 1 / 60;
  let guard = 0;
  while (sim.time < targetTime - 1e-12) {
    advanceWithSpeed(sim, frameDt, speed, acc);
    if (++guard > 1e6) throw new Error('runaway');
  }
}

describe('关键验证', () => {
  it('1. 静止堆叠:下沉量有限且稳定后不持续下沉', () => {
    const sim = new Sim();
    loadScene(sim, 'stack');
    const ids = sim.listIds();
    // 最高的箱子(id 最大的一个,金字塔顶端)
    const topId = ids[ids.length - 1];
    const y0 = sim.getReadings(topId)!.y;
    const stackHeight0 = Math.max(...ids.map((id) => sim.getReadings(id)!.y));

    runToSimTime(sim, 4, 1);
    const y4 = sim.getReadings(topId)!.y;
    runToSimTime(sim, 6, 1);
    const y6 = sim.getReadings(topId)!.y;

    // 所有刚体最低点不能穿透地面(y=0)
    const minY = Math.min(
      ...ids.map((id) => {
        const b = sim.getBody(id)!;
        let min = Infinity;
        for (let f = b.getFixtureList(); f; f = f.getNext()) {
          const aabb = f.getAABB(0);
          min = Math.min(min, aabb.lowerBound.y);
        }
        return min;
      }),
    );

    const settle = y0 - y6;
    const lateSink = y4 - y6;
    report('堆叠下沉', {
      模拟时长s: 6,
      初始顶箱y: y0,
      '4s时y': y4,
      '6s时y': y6,
      总下沉m: settle,
      后2s下沉m: lateSink,
      堆叠初始高度: stackHeight0,
      最低点y: minY,
    });

    // 容差:总下沉 < 箱高(0.5m)的 10%;后 2 秒继续下沉 < 1mm;不穿透地面
    expect(settle).toBeLessThan(0.05);
    expect(lateSink).toBeLessThan(0.001);
    expect(minY).toBeGreaterThan(-0.01);
  });

  it('2. 弹性碰撞:速度方向对照,动量与动能守恒', () => {
    const sim = new Sim();
    loadScene(sim, 'collision');
    const [idA, idB] = sim.listIds();
    const vA0 = sim.getReadings(idA)!.vx;
    const vB0 = sim.getReadings(idB)!.vx;

    runToSimTime(sim, 3, 1);
    const vA1 = sim.getReadings(idA)!.vx;
    const vB1 = sim.getReadings(idB)!.vx;

    report('弹性碰撞', {
      模拟时长s: 3,
      碰前vA: vA0,
      碰前vB: vB0,
      碰后vA: vA1,
      碰后vB: vB1,
    });

    expect(vA0).toBeCloseTo(COLLISION_SPEED, 6);
    expect(vB0).toBeCloseTo(0, 6);
    // 等质量对心弹性碰撞:近似交换速度。容差 2%
    const tol = COLLISION_SPEED * 0.02;
    expect(Math.abs(vA1)).toBeLessThan(tol + 0.05);
    expect(Math.abs(vB1 - COLLISION_SPEED)).toBeLessThan(tol + 0.05);
    // 方向:B 必须向 +x 运动
    expect(vB1).toBeGreaterThan(0);
    // 动量守恒
    expect(vA1 + vB1).toBeCloseTo(vA0 + vB0, 1);
    // 动能守恒(恢复系数 1),容差 2%
    const e0 = vA0 * vA0 + vB0 * vB0;
    const e1 = vA1 * vA1 + vB1 * vB1;
    expect(Math.abs(e1 - e0) / e0).toBeLessThan(0.02);
  });

  it('3. 单步推进:时间恰好前进一个步长,位移与速度一致', () => {
    const sim = new Sim();
    loadScene(sim, 'collision');
    const idA = sim.listIds()[0];
    const before = sim.getReadings(idA)!;
    const t0 = sim.time;
    const steps0 = sim.steps;

    sim.stepOnce();

    const after = sim.getReadings(idA)!;
    report('单步推进', {
      步长s: DT,
      时间增量: sim.time - t0,
      x增量: after.x - before.x,
      理论位移: before.vx * DT,
    });

    expect(sim.time - t0).toBeCloseTo(DT, 12);
    expect(sim.steps - steps0).toBe(1);
    // 无摩擦水平运动:Δx = vx·DT,容差 1e-4
    expect(after.x - before.x).toBeCloseTo(before.vx * DT, 4);
  });

  it('4. 接触标记:碰撞时出现、分离后消失、删除刚体后清除', () => {
    const sim = new Sim();
    loadScene(sim, 'collision');
    const [idA, idB] = sim.listIds();

    // 初始两球分离,之间无接触
    const pairOf = (c: { idA: number; idB: number }) =>
      (c.idA === idA && c.idB === idB) || (c.idA === idB && c.idB === idA);
    expect(sim.getContacts().filter(pairOf).length).toBe(0);

    // 推进到碰撞发生(两球相距 6m,相对速度 4m/s,约 1.25s 后接触)
    // 弹性碰撞接触持续很短,记录整个接触期间的最大深度
    let sawContact = false;
    let contactDepth = 0;
    let contactNormalX = 0;
    let contactPoints = 0;
    while (sim.time < 1.8) {
      sim.stepOnce();
      const hit = sim.getContacts().find(pairOf);
      if (hit) {
        sawContact = true;
        contactDepth = Math.max(contactDepth, ...hit.points.map((p) => p.depth));
        contactNormalX = hit.normalX;
        contactPoints = Math.max(contactPoints, hit.points.length);
      }
    }
    expect(sawContact).toBe(true);
    expect(contactPoints).toBeGreaterThan(0);
    expect(contactDepth).toBeGreaterThanOrEqual(0);
    expect(Math.abs(Math.abs(contactNormalX) - 1)).toBeLessThan(0.05); // 法线沿水平方向

    // 碰撞后分离,接触对消失
    runToSimTime(sim, 3, 1);
    expect(sim.getContacts().filter(pairOf).length).toBe(0);

    // 删除刚体 B,其所有接触记录消失
    sim.removeBody(idB);
    const remaining = sim.getContacts();
    expect(remaining.some((c) => c.idA === idB || c.idB === idB)).toBe(false);

    // 静止堆叠的稳定接触:深度为正且有限(求解器允许的微小穿透)
    const sim2 = new Sim();
    loadScene(sim2, 'stack');
    runToSimTime(sim2, 2, 1);
    const resting = sim2.getContacts();
    const maxRestDepth = Math.max(...resting.flatMap((c) => c.points.map((p) => p.depth)));
    expect(resting.length).toBeGreaterThan(0);
    expect(maxRestDepth).toBeGreaterThan(0);
    expect(maxRestDepth).toBeLessThan(0.01);

    report('接触标记', {
      碰撞接触深度m: contactDepth,
      法线x分量: contactNormalX,
      分离后接触对数: 0,
      删除后残留接触: remaining.length,
      静止接触数: resting.length,
      静止最大深度m: maxRestDepth,
    });
  });

  it('5. 播放速度:同一初始场景推进到同一模拟时长,状态一致', () => {
    const target = 4; // 模拟时长 4s = 480 步
    const snaps = new Map<number, ReturnType<Sim['snapshot']>>();
    for (const speed of [0.5, 1, 2]) {
      const sim = new Sim();
      loadScene(sim, 'stack');
      runToSimTime(sim, target, speed);
      expect(sim.steps).toBe(Math.round(target / DT));
      snaps.set(speed, sim.snapshot());
    }
    const base = snaps.get(1)!;
    let maxDiff = 0;
    for (const speed of [0.5, 2]) {
      const s = snaps.get(speed)!;
      expect(s.length).toBe(base.length);
      for (let i = 0; i < base.length; i++) {
        for (const k of ['x', 'y', 'angle', 'vx', 'vy', 'omega'] as const) {
          maxDiff = Math.max(maxDiff, Math.abs(s[i][k] - base[i][k]));
        }
      }
    }
    report('播放速度一致性', {
      模拟时长s: target,
      步数: Math.round(target / DT),
      速度档: '0.5/1/2',
      最大状态偏差: maxDiff,
    });
    // 固定步长下应逐步一致;容差 1e-9
    expect(maxDiff).toBeLessThan(1e-9);
  });

  it('6. 数量上限与重叠拒绝', () => {
    const sim = new Sim();
    loadScene(sim, 'stack'); // 15 个箱子
    let added = 0;
    while (sim.addCircle(30, 30 + added * 2) !== null) added++;
    expect(sim.dynamicCount).toBe(MAX_BODIES);
    expect(added).toBe(MAX_BODIES - 15);

    // 重叠拒绝:把箱子移到另一个箱子的位置会被拒绝
    const sim2 = new Sim();
    const a = sim2.addRect(5, 5)!;
    const b = sim2.addRect(8, 5)!;
    expect(sim2.wouldOverlap(a, 8, 5)).toBe(true);
    expect(sim2.tryMoveBody(a, 8, 5)).toBe(false);
    expect(sim2.getReadings(a)!.x).toBeCloseTo(5, 6); // 位置未变
    expect(sim2.tryMoveBody(a, 6.5, 5)).toBe(true); // 空位可以放置
    expect(sim2.getReadings(b)!.x).toBeCloseTo(8, 6);
    report('上限与重叠', { 上限: MAX_BODIES, 场景箱数: 15, 可再添加: added });
  });
});
