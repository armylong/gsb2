/**
 * 物理行为验证（Node 无头，不依赖 Canvas/DOM）。
 * 每个用例打印可重复的具体读数，断言针对真实物理量而非按钮状态。
 */
import { describe, expect, it } from 'vitest';
import { Vec2 } from 'planck';
import { ChainEngine } from '../src/engine';
import { DEFAULT_PARAMS, FIXED_DT, RECONNECT_THRESHOLD, SCENARIOS } from '../src/config';

/** 推进 n 个固定步 */
function runSteps(engine: ChainEngine, n: number): void {
  for (let i = 0; i < n; i++) engine.stepOnce();
}

function fmt(n: number, digits = 4): string {
  return n.toFixed(digits);
}

describe('1. 连接点偏差：运动中连接点保持接近', () => {
  it('长链摆动 300 步后所有关节连接点偏差均小于 20mm', () => {
    const engine = new ChainEngine(SCENARIOS.long, { ...DEFAULT_PARAMS });
    runSteps(engine, 300); // 5 秒模拟时间

    const deviations = engine.joints.map((j) => engine.anchorDeviation(j.index));
    const maxDev = Math.max(...deviations);
    console.table(
      engine.joints.map((j) => ({
        joint: `J${j.index}`,
        deviation_mm: (engine.anchorDeviation(j.index) * 1000).toFixed(2),
      })),
    );
    console.log(`最大连接点偏差: ${(maxDev * 1000).toFixed(2)} mm`);
    expect(maxDev).toBeLessThan(0.02);
  });

  it('带重物链在重力下悬挂 300 步，重物关节偏差同样受控', () => {
    const engine = new ChainEngine(SCENARIOS.weighted, { ...DEFAULT_PARAMS });
    runSteps(engine, 300);
    const maxDev = Math.max(...engine.joints.map((j) => engine.anchorDeviation(j.index)));
    console.log(`带重物链最大偏差: ${(maxDev * 1000).toFixed(2)} mm，重物质量=${engine.weightBody?.getMass()} kg`);
    expect(maxDev).toBeLessThan(0.02);
    expect(engine.weightBody?.getMass()).toBeCloseTo(SCENARIOS.weighted.weightMass, 5);
  });
});

describe('2. 关节角度限制：关节角不长期越过限制', () => {
  it('限制 ±30° 时，600 步内越过限制的步数占比 < 2%，且越限量 < 3°（求解器容差内）', () => {
    const params = { ...DEFAULT_PARAMS, limitAngle: Math.PI / 6, limitEnabled: true };
    const engine = new ChainEngine(SCENARIOS.long, params);
    const limit = params.limitAngle;
    let violateSteps = 0;
    let maxOver = 0;
    const samples: { step: number; joint: string; angle_deg: number }[] = [];

    for (let s = 0; s < 600; s++) {
      engine.stepOnce();
      for (const rec of engine.joints) {
        if (!rec.joint || rec.isWeightJoint) continue;
        const a = rec.joint.getJointAngle();
        const over = Math.max(0, Math.abs(a) - limit);
        if (over > 1e-4) {
          violateSteps++;
          maxOver = Math.max(maxOver, over);
          if (samples.length < 5) {
            samples.push({ step: s, joint: `J${rec.index}`, angle_deg: (a * 180) / Math.PI });
          }
        }
      }
    }
    const totalChecks = 600 * engine.joints.filter((j) => !j.isWeightJoint).length;
    const ratio = violateSteps / totalChecks;
    console.log('越限样本:', samples);
    console.log(`越限占比=${(ratio * 100).toFixed(2)}%，最大越限=${(maxOver * 180 / Math.PI).toFixed(3)}°`);
    // Box2D 位置修正存在角 slop，越限只允许瞬时小幅度出现，不允许长期越过
    expect(ratio).toBeLessThan(0.02);
    expect(maxOver).toBeLessThan((3 * Math.PI) / 180);
  });

  it('关闭限制后关节可以达到比限制值更大的角度', () => {
    const limited = new ChainEngine(SCENARIOS.short, {
      ...DEFAULT_PARAMS,
      limitAngle: Math.PI / 12,
      limitEnabled: true,
    });
    const free = new ChainEngine(SCENARIOS.short, {
      ...DEFAULT_PARAMS,
      limitAngle: Math.PI / 12,
      limitEnabled: false,
    });
    runSteps(limited, 300);
    runSteps(free, 300);
    const maxLimited = Math.max(
      ...limited.joints.filter((j) => j.joint && !j.isWeightJoint).map((j) => Math.abs(j.joint!.getJointAngle())),
    );
    const maxFree = Math.max(
      ...free.joints.filter((j) => j.joint && !j.isWeightJoint).map((j) => Math.abs(j.joint!.getJointAngle())),
    );
    console.log(`限制最大角=${(maxLimited * 180 / Math.PI).toFixed(2)}°，自由最大角=${(maxFree * 180 / Math.PI).toFixed(2)}°`);
    expect(maxFree).toBeGreaterThan(maxLimited);
  });
});

describe('3. 拆开后下游作为自由物体继续运动', () => {
  it('暂停时拆开 J2，下游链节获得自由运动且关节保持断开', () => {
    const engine = new ChainEngine(SCENARIOS.long, { ...DEFAULT_PARAMS });
    runSteps(engine, 120);
    // 记录拆开瞬间下游某节的速度与位置
    const target = engine.links[4].body;
    const posBefore = target.getPosition().clone();
    const velBefore = target.getLinearVelocity().clone();

    engine.breakJoint(2);
    expect(engine.joints[2].broken).toBe(true);
    expect(engine.joints[2].joint).toBeNull();
    expect(engine.anchorDeviation(2)).toBeGreaterThan(0); // 断开后两点不再被约束

    // 再跑 120 步，下游在重力下自由下落/摆动
    runSteps(engine, 120);
    const posAfter = target.getPosition();
    const moved = Vec2.distance(posBefore, posAfter);
    const readout = engine.getJointReadout(2)!;
    console.log(
      `拆开前 B4 速度=(${fmt(velBefore.x)}, ${fmt(velBefore.y)})，` +
        `120 步后位移=${fmt(moved)} m，J2 偏差=${(readout.anchorDeviation * 1000).toFixed(1)} mm`,
    );
    expect(moved).toBeGreaterThan(0.3);
    expect(engine.joints[2].broken).toBe(true);
    // 上游仍然连在固定端
    expect(engine.joints[0].broken).toBe(false);
    expect(engine.anchorDeviation(0)).toBeLessThan(0.02);
  });

  it('拆开不改变其他关节的连接状态，重置后全部恢复', () => {
    const engine = new ChainEngine(SCENARIOS.short, { ...DEFAULT_PARAMS });
    runSteps(engine, 60);
    engine.breakJoint(1);
    expect(engine.joints.filter((j) => j.broken)).toHaveLength(1);
    // 模拟“重置”：用相同配置重建
    const fresh = new ChainEngine(SCENARIOS.short, { ...DEFAULT_PARAMS });
    expect(fresh.joints.every((j) => !j.broken)).toBe(true);
    expect(fresh.joints.every((j) => engine.anchorDeviation.call(fresh, j.index) < 1e-9)).toBe(true);
  });
});

describe('4. 远距离重连被拒绝，近距离允许，且不瞬移', () => {
  it('拆开后漂远 -> restoreJoint 返回 false 且保持拆开、位姿不变', () => {
    const engine = new ChainEngine(SCENARIOS.weighted, { ...DEFAULT_PARAMS });
    runSteps(engine, 60);
    const breakIndex = engine.joints.length - 1; // 重物关节
    const rec = engine.joints[breakIndex];
    const bodyBPosBefore = rec.bodyB.getPosition().clone();

    engine.breakJoint(breakIndex);
    runSteps(engine, 180); // 重物自由坠落，连接点明显拉开

    const deviation = engine.anchorDeviation(breakIndex);
    const bodyBPosMid = rec.bodyB.getPosition().clone();
    const ok = engine.restoreJoint(breakIndex);
    const bodyBPosAfter = rec.bodyB.getPosition().clone();

    console.log(
      `重连前偏差=${(deviation * 1000).toFixed(1)} mm，阈值=${RECONNECT_THRESHOLD * 1000} mm，` +
        `restore=${ok}，重连尝试前后重物位置变化=${fmt(Vec2.distance(bodyBPosMid, bodyBPosAfter), 8)} m`,
    );
    expect(deviation).toBeGreaterThan(RECONNECT_THRESHOLD);
    expect(ok).toBe(false);
    expect(engine.joints[breakIndex].broken).toBe(true);
    // 拒绝重连不得修改任何体位（不瞬移拼回）
    expect(Vec2.distance(bodyBPosMid, bodyBPosAfter)).toBeLessThan(1e-12);
    expect(bodyBPosBefore).toBeTruthy();
  });

  it('把下游物体移回阈值内（通过真实物理拖拽，非瞬移）后可以恢复', () => {
    const engine = new ChainEngine(SCENARIOS.short, { ...DEFAULT_PARAMS });
    runSteps(engine, 30);
    engine.breakJoint(2);

    // 用 mouse joint 把断开的下游第一节拉回 A 端附近 —— 这是施加力而非 setTransform。
    // 真实操作流程：用户拖拽到连接点足够近时（仍按住）点击恢复。
    const rec = engine.joints[2];
    const targetPoint = rec.bodyA.getWorldPoint(rec.localAnchorA);
    expect(engine.beginDrag(rec.bodyB.getPosition())).toBe(true);
    let bestDeviation = Infinity;
    let reached = false;
    for (let i = 0; i < 1500; i++) {
      const anchorB = rec.bodyB.getWorldPoint(rec.localAnchorB);
      const next = new Vec2(
        anchorB.x + (targetPoint.x - anchorB.x) * 0.2,
        anchorB.y + (targetPoint.y - anchorB.y) * 0.2,
      );
      engine.updateDrag(next);
      engine.stepOnce();
      bestDeviation = Math.min(bestDeviation, engine.anchorDeviation(2));
      if (engine.anchorDeviation(2) <= RECONNECT_THRESHOLD * 0.8) {
        reached = true;
        break;
      }
    }
    expect(reached).toBe(true);

    // 保持拖拽约束（施加力中）直接恢复，恢复后再松手 —— 对应 UI 的暂停操作时序
    const deviationAtRestore = engine.anchorDeviation(2);
    const ok = engine.restoreJoint(2);
    engine.endDrag();
    console.log(`拖拽最小偏差=${(bestDeviation * 1000).toFixed(1)} mm，恢复时偏差=${(deviationAtRestore * 1000).toFixed(1)} mm，restore=${ok}`);
    expect(deviationAtRestore).toBeLessThan(RECONNECT_THRESHOLD);
    expect(ok).toBe(true);
    expect(engine.joints[2].broken).toBe(false);

    // 恢复后继续模拟，连接点重新被约束住
    runSteps(engine, 120);
    expect(engine.anchorDeviation(2)).toBeLessThan(0.02);
  });
});

describe('5. 碰撞：地面、圆形障碍、非相邻链节', () => {
  it('长链最终与地面或障碍发生真实接触（contact 计数 > 0）', () => {
    const engine = new ChainEngine(SCENARIOS.long, { ...DEFAULT_PARAMS });
    let sawContact = false;
    engine.world.on('begin-contact', () => {
      sawContact = true;
    });
    runSteps(engine, 900);
    console.log('900 步内是否发生过接触:', sawContact, '当前 contact 数:', engine.world.getContactCount());
    expect(sawContact).toBe(true);
  });

  it('相邻链节按统一规则排除碰撞，非相邻链节之间允许碰撞', () => {
    // 直链自然摆动时相邻链节几何上不重叠，因此用 setTransform 制造确定性重叠场景，
    // 再观察 pre-solve 的统一过滤行为（setTransform 仅用于布置测试场景，非拖拽实现）。
    const makeOverlap = (filterOn: boolean) => {
      const engine = new ChainEngine(SCENARIOS.long, { ...DEFAULT_PARAMS, adjacentFilter: filterOn });
      const b0 = engine.links[0].body;
      const p = b0.getPosition();
      // B1 与 B0 相邻；B3 与 B0 非相邻，叠到同一位置
      engine.links[1].body.setTransform(new Vec2(p.x, p.y), engine.links[1].body.getAngle());
      engine.links[3].body.setTransform(new Vec2(p.x, p.y), engine.links[3].body.getAngle());

      let adjacentTouch = 0;
      let adjacentDisabled = 0;
      let nonAdjacentTouch = 0;
      engine.world.on('pre-solve', (c) => {
        const ia = engine.links.findIndex((l) => l.body === c.getFixtureA().getBody());
        const ib = engine.links.findIndex((l) => l.body === c.getFixtureB().getBody());
        if (ia < 0 || ib < 0) return;
        if (Math.abs(ia - ib) === 1) {
          adjacentTouch++;
          if (!c.isEnabled()) adjacentDisabled++;
        } else if (Math.abs(ia - ib) > 1) {
          nonAdjacentTouch++;
        }
      });
      runSteps(engine, 60);
      return { adjacentTouch, adjacentDisabled, nonAdjacentTouch };
    };

    const filtered = makeOverlap(true);
    const unfiltered = makeOverlap(false);
    console.log({ filtered, unfiltered });

    // 开启过滤：相邻接触全部生成但被统一规则禁用，非相邻接触保持启用
    expect(filtered.adjacentTouch).toBeGreaterThan(0);
    expect(filtered.adjacentDisabled).toBe(filtered.adjacentTouch);
    expect(filtered.nonAdjacentTouch).toBeGreaterThan(0);
    // 关闭过滤：相邻接触不被禁用
    expect(unfiltered.adjacentTouch).toBeGreaterThan(0);
    expect(unfiltered.adjacentDisabled).toBe(0);
  });
});

describe('6. 暂停/单步语义与固定步长', () => {
  it('暂停推进若干帧不改变任何速度与位姿；单步只推进一个 FIXED_DT', () => {
    const engine = new ChainEngine(SCENARIOS.short, { ...DEFAULT_PARAMS });
    runSteps(engine, 60);
    const snapshot = engine.links.map((l) => ({
      p: l.body.getPosition().clone(),
      v: l.body.getLinearVelocity().clone(),
      a: l.body.getAngle(),
    }));

    // 模拟 App 的暂停行为：完全不调用 step
    const t0 = engine.getSimTime();
    for (let i = 0; i < 10; i++) {
      // 无 step 调用
    }
    expect(engine.getSimTime()).toBe(t0);
    engine.links.forEach((l, i) => {
      expect(Vec2.distance(l.body.getPosition(), snapshot[i].p)).toBe(0);
      expect(Vec2.distance(l.body.getLinearVelocity(), snapshot[i].v)).toBe(0);
      expect(l.body.getAngle()).toBe(snapshot[i].a);
    });

    // 单步恰好推进一个固定步
    engine.stepOnce();
    expect(engine.getSimTime() - t0).toBeCloseTo(FIXED_DT, 9);
    expect(engine.getStepCount()).toBe(61);
  });

  it('相同初始状态分别按 60Hz 与 30Hz 节奏取步，推进相同模拟时间后状态接近', () => {
    const make = () => new ChainEngine(SCENARIOS.long, { ...DEFAULT_PARAMS });
    const engine60 = make();
    const engine30 = make();

    // 60Hz：每次 rAF 间隔 1/60，每帧 advance 一次
    for (let f = 0; f < 300; f++) engine60.advance(1 / 60);
    // 30Hz：每次 rAF 间隔 1/30（浏览器隔帧渲染，物理仍按真实时间取步）
    for (let f = 0; f < 150; f++) engine30.advance(1 / 30);

    expect(engine60.getSimTime()).toBeCloseTo(5, 6);
    expect(engine30.getSimTime()).toBeCloseTo(5, 6);

    let maxPosDiff = 0;
    let maxAngleDiff = 0;
    engine60.links.forEach((l, i) => {
      maxPosDiff = Math.max(
        maxPosDiff,
        Vec2.distance(l.body.getPosition(), engine30.links[i].body.getPosition()),
      );
      maxAngleDiff = Math.max(
        maxAngleDiff,
        Math.abs(l.body.getAngle() - engine30.links[i].body.getAngle()),
      );
    });
    console.log(
      `同模拟时间 5s：最大位置差=${(maxPosDiff * 1000).toFixed(2)} mm，` +
        `最大角度差=${(maxAngleDiff * 180 / Math.PI).toFixed(3)}°`,
    );
    // 不要求逐位相同（取步边界不同），但运动幅度应接近
    expect(maxPosDiff).toBeLessThan(0.15);
    expect(maxAngleDiff).toBeLessThan(0.15);
  });

  it('隐藏页面式的大时间间隔不会补出失控运动（步数被截断）', () => {
    const engine = new ChainEngine(SCENARIOS.short, { ...DEFAULT_PARAMS });
    const before = engine.getStepCount();
    // 页面隐藏 10 秒后回来，一次性给出 10s 间隔
    const steps = engine.advance(10);
    const after = engine.getStepCount();
    console.log(`10 秒间隔实际执行步数=${steps}，累计步 ${before} -> ${after}`);
    expect(steps).toBeLessThanOrEqual(5);
    // 末端位置仍在合理视场内，没有穿透地面
    const lastBody = engine.links[engine.links.length - 1].body;
    expect(lastBody.getPosition().y).toBeGreaterThan(-8);
  });

  it('rAF 抖动下零头结转不丢模拟时间：抖动序列与均匀序列累计步数一致', () => {
    // 模拟真实浏览器帧间隔在 1/60 附近抖动（±4ms），总真实时间均为 2 秒
    const jittered = new ChainEngine(SCENARIOS.short, { ...DEFAULT_PARAMS });
    const uniform = new ChainEngine(SCENARIOS.short, { ...DEFAULT_PARAMS });
    const totalReal = 2;
    const frames = 120;
    // 确定性伪随机抖动，保证可重复
    let seed = 42;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 2 ** 32;
      return seed / 2 ** 32;
    };
    for (let f = 0; f < frames; f++) {
      const jitter = (rand() - 0.5) * 0.008;
      jittered.advance(totalReal / frames + jitter);
      uniform.advance(totalReal / frames);
    }
    console.log(
      `2 秒真实时间：抖动序列步数=${jittered.getStepCount()}，` +
        `均匀序列步数=${uniform.getStepCount()}，理论步数=${Math.round(totalReal / FIXED_DT)}`,
    );
    // 累积器吸收抖动，两者步数差异不超过 1 步，且都接近理论 120 步
    expect(Math.abs(jittered.getStepCount() - uniform.getStepCount())).toBeLessThanOrEqual(1);
    expect(Math.abs(jittered.getStepCount() - 120)).toBeLessThanOrEqual(1);
  });
});
