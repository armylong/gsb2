import { describe, expect, it } from 'vitest';
import { anglesAt, getPose, rad, sequencePhases } from '../src/core/kinematics';
import { ALL_SCENARIOS, getScenario, scenarioMidCollision } from '../src/core/scenarios';
import { contactsAt, scanCollisions } from '../src/core/collision';
import { dot } from '../src/core/math3d';

const fullRange: [number, number] = [0, 1];

describe('运动学', () => {
  it('t=0/1 对应角度范围起止', () => {
    const s = getScenario('clear');
    const a0 = anglesAt(s.mechanism, 0);
    const a1 = anglesAt(s.mechanism, 1);
    expect(a0.doorAngle).toBeCloseTo(rad(0), 8);
    expect(a1.doorAngle).toBeCloseTo(rad(90), 8);
  });

  it('door-first 顺序: 前半段托板不动, 后半段门不动', () => {
    const s = getScenario('start-contact');
    const phases = sequencePhases(s.mechanism.sequence);
    expect(phases.door).toEqual([0, 0.5]);
    expect(phases.tray).toEqual([0.5, 1]);
    const mid = anglesAt(s.mechanism, 0.5);
    expect(mid.doorAngle).toBeCloseTo(rad(90), 8);
    expect(mid.trayAngle).toBeCloseTo(rad(0), 8);
  });

  it('simultaneous 顺序: 中点两个转动都在一半', () => {
    const s = getScenario('clear');
    const mid = anglesAt(s.mechanism, 0.5);
    expect(mid.doorAngle).toBeCloseTo(rad(45), 8);
    expect(mid.trayAngle).toBeCloseTo(rad(45), 8);
  });

  it('tray-first 顺序: 前半段门不动, 托板先翻', () => {
    const s = getScenario('clear');
    s.mechanism.sequence = 'tray-first';
    const a = anglesAt(s.mechanism, 0.25);
    expect(a.doorAngle).toBeCloseTo(rad(0), 8);
    expect(a.trayAngle).toBeCloseTo(rad(45), 8);
    const b = anglesAt(s.mechanism, 0.75);
    expect(b.trayAngle).toBeCloseTo(rad(90), 8);
    expect(b.doorAngle).toBeCloseTo(rad(45), 8);
  });

  it('门板关闭时位于 x∈[-15,15], z∈[0,500]', () => {
    const s = getScenario('clear');
    const pose = getPose(s.mechanism, 0);
    const o = pose.doorOBB;
    expect(o.center[2]).toBeCloseTo(250, 6);
    // 轴对齐时中心 ± 半尺寸
    expect(o.center[0] - o.half[0]).toBeCloseTo(-15, 6);
    expect(o.center[2] + o.half[2]).toBeCloseTo(500, 6);
  });

  it('门打开 90° 后扫到 +x 一侧, 自由边在 x≈500', () => {
    const s = getScenario('clear');
    const pose = getPose(s.mechanism, 1);
    // 自由边中心: pivot + R_y(90)·(0,0,500) = (500,0,0)
    const tip = [
      pose.doorOBB.center[0] + pose.doorOBB.axes[2][0] * pose.doorOBB.half[2],
      pose.doorOBB.center[1] + pose.doorOBB.axes[2][1] * pose.doorOBB.half[2],
      pose.doorOBB.center[2] + pose.doorOBB.axes[2][2] * pose.doorOBB.half[2],
    ];
    expect(tip[0]).toBeCloseTo(500, 6);
    expect(tip[2]).toBeCloseTo(0, 6);
  });

  it('姿态只由 t 决定: 同一 t 重复计算完全一致', () => {
    const s = getScenario('mid-collision');
    const p1 = getPose(s.mechanism, 0.37);
    const p2 = getPose(s.mechanism, 0.37);
    expect(p1.doorOBB.center).toEqual(p2.doorOBB.center);
    expect(p1.trayOBB.center).toEqual(p2.trayOBB.center);
  });
});

describe('预设 A: 无遮挡', () => {
  const s = getScenario('clear');
  it('全程无碰撞事件', () => {
    const res = scanCollisions(s.mechanism, s.obstacles, { range: fullRange, steps: 600 });
    expect(res.events).toHaveLength(0);
  });
  it('任意时刻都没有活动接触', () => {
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      expect(contactsAt(s.mechanism, s.obstacles, t, 1, 1)).toHaveLength(0);
    }
  });
});

describe('预设 B: 起始已接触', () => {
  const s = getScenario('start-contact');
  it('t=0 即有接触, 且为贴边', () => {
    const live = contactsAt(s.mechanism, s.obstacles, 0, 1, 1);
    expect(live.length).toBeGreaterThan(0);
    const doorHit = live.find((c) => c.part === 'door');
    expect(doorHit).toBeDefined();
    expect(doorHit!.kind).toBe('grazing');
  });
  it('扫描得到进入时刻 ≈ 0 的事件, 并很快分开', () => {
    const res = scanCollisions(s.mechanism, s.obstacles, { range: fullRange, steps: 1200 });
    expect(res.events.length).toBeGreaterThan(0);
    const first = res.events[0];
    expect(first.enterT).toBeLessThan(0.01);
    expect(first.exitT).toBeLessThan(0.1);
  });
});

describe('预设 C: 中途擦碰', () => {
  const s = scenarioMidCollision();
  it('起止姿态都让开', () => {
    expect(contactsAt(s.mechanism, s.obstacles, 0, 1, 1)).toHaveLength(0);
    expect(contactsAt(s.mechanism, s.obstacles, 1, 1, 1)).toHaveLength(0);
  });

  const res = scanCollisions(s.mechanism, s.obstacles, { range: fullRange, steps: 1200 });
  it('途中至少一个贴边事件和一个侵入事件', () => {
    expect(res.events.length).toBeGreaterThanOrEqual(2);
    const kinds = new Set(res.events.map((e) => e.kind));
    expect(kinds.has('grazing')).toBe(true);
    expect(kinds.has('penetrating')).toBe(true);
  });
  it('所有事件都发生在区间内部 (起止让开)', () => {
    for (const e of res.events) {
      expect(e.enterT).toBeGreaterThan(0.02);
      expect(e.exitT).toBeLessThan(0.98);
    }
  });
  it('侵入事件的最大侵入深度明显大于贴边容差', () => {
    const pen = res.events.find((e) => e.kind === 'penetrating');
    expect(pen).toBeDefined();
    expect(pen!.maxDepth).toBeGreaterThan(5);
  });
  it('事件带面/边标签', () => {
    for (const e of res.events) {
      expect(e.enterLabel.obstacleFace.length).toBeGreaterThan(0);
      expect(e.enterLabel.partSide.length).toBeGreaterThan(0);
    }
  });
  it('事件级别与标签类型一致', () => {
    for (const e of res.events) {
      expect(e.enterLabel.kind).toBe(e.kind);
    }
  });
});

describe('检查区间收紧', () => {
  const s = getScenario('mid-collision');
  it('只扫描提前结束的区间时, 之后才发生的事件消失', () => {
    const full = scanCollisions(s.mechanism, s.obstacles, { range: [0, 1], steps: 1200 });
    const lastEnter = Math.max(...full.events.map((e) => e.enterT));
    const cut = lastEnter - 0.05;
    const tight = scanCollisions(s.mechanism, s.obstacles, { range: [0, cut], steps: 1200 });
    expect(tight.events.length).toBeLessThan(full.events.length);
    for (const e of tight.events) expect(e.enterT).toBeLessThanOrEqual(cut + 1e-9);
  });
  it('转动范围改短后旧碰撞提示移除 (门只开到 5°, 碰撞始于约 6.8°)', () => {
    const full = scanCollisions(s.mechanism, s.obstacles, { range: [0, 1], steps: 1200 });
    expect(full.events.length).toBeGreaterThan(0);
    const shortMechanism = JSON.parse(JSON.stringify(s.mechanism));
    shortMechanism.door.angleRange = [rad(0), rad(5)];
    const res = scanCollisions(shortMechanism, s.obstacles, { range: [0, 1], steps: 1200 });
    // 门还没转到碰撞角度 => 旧的桌板碰撞事件全部消失
    const shelfHits = res.events.filter((e) => e.obstacleId === 'obs-shelf');
    expect(shelfHits).toHaveLength(0);
  });
});

describe('扫描确定性', () => {
  const s = getScenario('mid-collision');
  it('不同步数/重复运行给出一致的事件结构', () => {
    const r1 = scanCollisions(s.mechanism, s.obstacles, { range: [0, 1], steps: 600 });
    const r2 = scanCollisions(s.mechanism, s.obstacles, { range: [0, 1], steps: 900 });
    expect(r1.events.map((e) => `${e.obstacleId}:${e.part}`)).toEqual(
      r2.events.map((e) => `${e.obstacleId}:${e.part}`),
    );
    for (let i = 0; i < r1.events.length; i++) {
      expect(Math.abs(r1.events[i].enterT - r2.events[i].enterT)).toBeLessThan(0.01);
    }
  });
  it('所有预设均可加载且结构完整', () => {
    expect(ALL_SCENARIOS).toHaveLength(3);
    for (const sc of ALL_SCENARIOS) {
      expect(sc.mechanism.door.size).toHaveLength(3);
      expect(sc.obstacles.length).toBeGreaterThan(0);
      // 托板铰链轴在世界系中始终保持水平 (随门转动)
      const pose = getPose(sc.mechanism, 0.5);
      expect(dot(pose.trayOBB.axes[0], [0, 1, 0])).toBeDefined();
    }
  });
});
