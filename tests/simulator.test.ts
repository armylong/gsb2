import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { boxesOverlap, boxTargetOverlap, rayBox, rayTarget } from '../src/sim/geometry';
import { defaultMaterial } from '../src/sim/materials';
import {
  exhaustPreset,
  makeBox,
  makeTarget,
  obliquePreset,
  reflectThenPenetratePreset,
} from '../src/sim/presets';
import { simulateShot } from '../src/sim/simulator';
import type { BoxDef, ShotParams, TargetDef } from '../src/sim/types';

/**
 * 数值容差约定 (同时记录在 README):
 * - GEOM_EPS = 1e-7: 几何 slab 求交与 t>=0 门限
 * - T_GATE   = 1e-5: 表面贴合去抖门限 (世界单位)
 * - 测试断言容差:
 *     点坐标 / 长度 / t    : TOL_DIST = 1e-4
 *     能量                : TOL_ENERGY = 1e-4
 *     方向向量 / 法线      : TOL_VEC = 1e-5
 *     角度                : TOL_ANGLE = 1e-3 度
 */
const TOL_DIST = 1e-4;
const TOL_ENERGY = 1e-4;
const TOL_VEC = 1e-5;
const TOL_ANGLE = 1e-3;

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const euler = (x = 0, y = 0, z = 0) => new THREE.Euler(x, y, z);

function baseShot(over: Partial<ShotParams>): ShotParams {
  return {
    origin: v(-10, 0, 0),
    direction: v(1, 0, 0),
    initialEnergy: 100,
    maxRange: 60,
    maxInteractions: 8,
    minEnergy: 1,
    ...over,
  };
}

function expectVec(actual: THREE.Vector3, expected: THREE.Vector3, tol = TOL_DIST): void {
  const digits = tol <= 1e-5 ? 5 : 4;
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
  expect(actual.z).toBeCloseTo(expected.z, digits);
}

describe('rayBox: 轴对齐 slab 求交与法线', () => {
  const box = makeBox({
    name: 'axis-box',
    position: v(0, 0, 0),
    rotation: euler(),
    size: v(2, 2, 2),
    material: defaultMaterial('blocking'),
  });

  it('正中穿过时 entry/exit 与表面严格吻合, 法线朝外', () => {
    const hit = rayBox(v(-5, 0, 0), v(1, 0, 0), box)!;
    expect(hit).not.toBeNull();
    expect(hit.tEntry).toBeCloseTo(4, 5);
    expect(hit.tExit).toBeCloseTo(6, 5);
    expectVec(hit.entryPoint, v(-1, 0, 0));
    expectVec(hit.exitPoint, v(1, 0, 0));
    expectVec(hit.entryNormal, v(-1, 0, 0), TOL_VEC);
    expectVec(hit.exitNormal, v(1, 0, 0), TOL_VEC);
    expect(hit.originInside).toBe(false);
  });

  it('射线平行于 slab 且在 slab 外时无交点', () => {
    const hit = rayBox(v(-5, 5, 0), v(1, 0, 0), box);
    expect(hit).toBeNull();
  });

  it('起点在盒内时 originInside=true, tEntry 裁剪为 0 且无入口法线', () => {
    const hit = rayBox(v(0, 0, 0), v(1, 0, 0), box)!;
    expect(hit.originInside).toBe(true);
    expect(hit.tEntry).toBeCloseTo(0, 6);
    expect(hit.entryNormal.lengthSq()).toBe(0);
    expect(hit.tExit).toBeCloseTo(1, 6);
  });

  it('旋转 30° 的盒子, 接触点仍落在旋转后的表面上 (非退化角度)', () => {
    const rotated = makeBox({
      name: 'rot',
      position: v(5, 0, 0),
      rotation: euler(0, Math.PI / 6, 0),
      size: v(2, 2, 2),
      material: defaultMaterial('blocking'),
    });
    const hit = rayBox(v(0, 0, 0), v(1, 0, 0), rotated)!;
    const c = Math.cos(Math.PI / 6);
    const s = Math.sin(Math.PI / 6);

    // 独立手算 (不经过被测代码的变换):
    // 局部原点 = (0,0,0)-(5,0,0) 再反向旋转 → (-5c, 0, -5s)
    // 局部方向 = (c, 0, +s); -x 面 t=(5c-1)/c≈3.8453, -z 面 t=(1-5s)/s=-3
    // 近面唯一为局部 -x, t=3.8453
    const expectedT = (5 * c - 1) / c;
    expect(hit.tEntry).toBeCloseTo(expectedT, 5);

    // 局部入口点 (-1, 0, -5s + s·t), 用独立矩阵转回世界
    const localZ = -5 * s + s * expectedT;
    const expectedWorld = new THREE.Vector3(-1, 0, localZ)
      .applyEuler(new THREE.Euler(0, Math.PI / 6, 0))
      .add(v(5, 0, 0));
    expectVec(hit.entryPoint, expectedWorld);

    // 入口法线 = 局部 (-1,0,0) 旋转后的世界向量 (-c, 0, +s)
    expectVec(hit.entryNormal, v(-c, 0, s), TOL_VEC);

    // 把实现给出的接触点反变换回局部, 必须严格落在 x=-1 面上
    const invQ = new THREE.Quaternion()
      .setFromEuler(rotated.rotation)
      .invert();
    const back = hit.entryPoint.clone().sub(rotated.position).applyQuaternion(invQ);
    expect(back.x).toBeCloseTo(-1, 5);
    expect(Math.abs(back.y)).toBeLessThan(1e-9);
    expect(Math.abs(back.z)).toBeLessThanOrEqual(1 + 1e-9);
  });
});

describe('rayTarget: 靶面矩形求交', () => {
  const target = makeTarget({
    name: 't',
    position: v(5, 0, 0),
    rotation: euler(0, Math.PI / 2, 0),
    size: new THREE.Vector2(2, 2),
  });

  it('正面命中返回交点与旋转后的法线 (Three.js 绕 Y 转 +90°, 局部 +Z → 世界 +X)', () => {
    const hit = rayTarget(v(0, 0, 0), v(1, 0, 0), target)!;
    expect(hit).not.toBeNull();
    expect(hit.t).toBeCloseTo(5, 5);
    expectVec(hit.point, v(5, 0, 0));
    expectVec(hit.normal, v(1, 0, 0), TOL_VEC);
  });

  it('打在矩形外无交点', () => {
    const hit = rayTarget(v(0, 3, 0), v(1, 0, 0), target);
    expect(hit).toBeNull();
  });
});

describe('SAT 互不相交校验', () => {
  it('两个分离的 OBB 不相交, 穿插后相交', () => {
    const a = makeBox({ name: 'a', position: v(0, 0, 0), size: v(2, 2, 2), material: defaultMaterial('blocking') });
    const b = makeBox({ name: 'b', position: v(3, 0, 0), rotation: euler(0, 0.4, 0), size: v(2, 2, 2), material: defaultMaterial('blocking') });
    expect(boxesOverlap(a, b)).toBe(false);
    b.position.set(1.5, 0, 0);
    expect(boxesOverlap(a, b)).toBe(true);
  });

  it('靶面穿入盒体时判定相交', () => {
    const a = makeBox({ name: 'a', position: v(0, 0, 0), size: v(2, 2, 2), material: defaultMaterial('blocking') });
    const t = makeTarget({ name: 't', position: v(0.5, 0, 0), rotation: euler(0, Math.PI / 2, 0), size: new THREE.Vector2(2, 2) });
    expect(boxTargetOverlap(a, t)).toBe(true);
  });
});

describe('模拟器: 现场1 斜穿长度按实际路径, 不按标称厚度', () => {
  const preset = obliquePreset();
  const result = simulateShot(preset.boxes, preset.targets, preset.shot);

  it('内部段长度 = 2/sin15° ≈ 7.7274, 远大于标称厚度 2', () => {
    const inside = result.segments.filter((s) => s.type === 'inside');
    expect(inside.length).toBe(1);
    const expected = 2 / Math.sin(Math.PI / 12);
    expect(inside[0].length).toBeCloseTo(expected, 4);
    expect(inside[0].length).toBeGreaterThan(7.7);
    expect(inside[0].length - 2).toBeGreaterThan(5); // 与标称厚度的差异
  });

  it('能量只扣一次: 出口能量 = 100 - 7.7274*5', () => {
    const inside = result.segments.find((s) => s.type === 'inside')!;
    const expectedCost = (2 / Math.sin(Math.PI / 12)) * 5;
    expect(inside.energyAfter).toBeCloseTo(100 - expectedCost, TOL_ENERGY);
    expect(inside.energyBefore).toBeCloseTo(100, TOL_ENERGY);
    // 内部段的能量差就是全部扣费, 入口飞行段不扣费
    const flight = result.segments.find((s) => s.type === 'flight')!;
    expect(flight.energyAfter - flight.energyBefore).toBeCloseTo(0, TOL_ENERGY);
  });

  it('接触顺序为 入口 → 出口 → 靶面命中, 且靶面确实命中', () => {
    const kinds = result.contacts.map((c) => c.kind);
    expect(kinds).toEqual(['entry', 'exit', 'target-hit']);
    expect(result.endReason).toBe('target-hit');
    expect(result.interactionCount).toBe(3);
  });

  it('总路程 = 各段长度之和, 包含材料内部距离', () => {
    const sum = result.segments.reduce((a, s) => a + s.length, 0);
    expect(result.totalDistance).toBeCloseTo(sum, TOL_DIST);
  });
});

describe('模拟器: 现场2 反弹方向与反弹后穿透', () => {
  const preset = reflectThenPenetratePreset();
  const result = simulateShot(preset.boxes, preset.targets, preset.shot);

  it('反射后方向严格为 +z, 反射点手算值 (-0.8284, 0, 0)', () => {
    const reflect = result.contacts.find((c) => c.kind === 'reflect')!;
    expect(reflect).toBeTruthy();
    expectVec(reflect.point, v(-0.828427, 0, 0));
    expect(reflect.incidenceDeg).toBeCloseTo(45, TOL_ANGLE);
    // 反射点之后第一段飞行的方向
    const after = result.segments.find(
      (s) => s.type === 'flight' && s.start.distanceTo(reflect.point) < 1e-4,
    )!;
    const dir = after.end.clone().sub(after.start).normalize();
    expectVec(dir, v(0, 0, 1), TOL_VEC);
  });

  it('反射扣 20% 能量: 100 → 80, 反射节点记录能量阶跃', () => {
    const node = result.segments.find((s) => s.type === 'reflection')!;
    expect(node.length).toBeCloseTo(0, 6);
    expect(node.energyBefore).toBeCloseTo(100, TOL_ENERGY);
    expect(node.energyAfter).toBeCloseTo(80, TOL_ENERGY);
  });

  it('反弹后继续穿透: 薄盒内部长度 1, 再扣 6 能量, 最终命中靶面', () => {
    const inside = result.segments.filter((s) => s.type === 'inside');
    expect(inside.length).toBe(1);
    expect(inside[0].length).toBeCloseTo(1, TOL_DIST);
    expect(inside[0].energyBefore).toBeCloseTo(80, TOL_ENERGY);
    expect(inside[0].energyAfter).toBeCloseTo(74, TOL_ENERGY);
    expect(result.endReason).toBe('target-hit');
    const kinds = result.contacts.map((c) => c.kind);
    expect(kinds).toEqual(['reflect', 'entry', 'exit', 'target-hit']);
  });
});

describe('模拟器: 现场3 能量耗尽停在材料内部', () => {
  const preset = exhaustPreset();
  const result = simulateShot(preset.boxes, preset.targets, preset.shot);

  it('停点距入口 2.5 (= 25/10), 位于盒内 (盒范围 x: 0..4), 即世界点 x=2.5', () => {
    expect(result.endReason).toBe('exhausted-inside');
    expectVec(result.endPoint, v(2.5, 0, 0));
    const inside = result.segments.find((s) => s.type === 'inside')!;
    expect(inside.length).toBeCloseTo(2.5, TOL_DIST);
    expect(inside.energyAfter).toBeCloseTo(0, TOL_ENERGY);
  });

  it('只有入口与内部停点, 无出口, 后方靶面不算命中', () => {
    const kinds = result.contacts.map((c) => c.kind);
    expect(kinds).toEqual(['entry', 'stop-inside']);
    expect(result.contacts.some((c) => c.kind === 'target-hit')).toBe(false);
  });
});

describe('模拟器: 命中次序由实际距离决定, 与创建次序无关', () => {
  const far = makeBox({
    id: 'far',
    name: '远盒(先创建)',
    position: v(8, 0, 0),
    size: v(2, 2, 2),
    material: defaultMaterial('blocking'),
  });
  const near = makeBox({
    id: 'near',
    name: '近盒(后创建)',
    position: v(3, 0, 0),
    size: v(2, 2, 2),
    material: defaultMaterial('blocking'),
  });

  it('先创建的远盒不会抢先命中', () => {
    const result = simulateShot([far, near], [], baseShot({}));
    expect(result.contacts[0].objectId).toBe('near');
    expect(result.endReason).toBe('blocked');
    expectVec(result.endPoint, v(2, 0, 0));
  });

  it('交换数组顺序后结果不变', () => {
    const result = simulateShot([near, far], [], baseShot({}));
    expect(result.contacts[0].objectId).toBe('near');
  });
});

describe('模拟器: 靶面被前方箱体遮挡时不算命中', () => {
  const blocker = makeBox({
    name: 'blocker',
    position: v(3, 0, 0),
    size: v(2, 4, 4),
    material: defaultMaterial('blocking'),
  });
  const target = makeTarget({
    name: 'behind',
    position: v(8, 0, 0),
    rotation: euler(0, Math.PI / 2, 0),
    size: new THREE.Vector2(4, 4),
  });

  it('弹道止于阻挡盒表面, 不产生 target-hit 接触', () => {
    const result = simulateShot([blocker], [target], baseShot({}));
    expect(result.endReason).toBe('blocked');
    expect(result.contacts.some((c) => c.kind === 'target-hit')).toBe(false);
    expectVec(result.endPoint, v(2, 0, 0));
  });
});

describe('模拟器: 最多 8 次交互上限', () => {
  function alternatingBoxes(n: number): BoxDef[] {
    const boxes: BoxDef[] = [];
    for (let i = 0; i < n; i++) {
      boxes.push(
        makeBox({
          id: `b${i}`,
          name: `薄盒${i}`,
          position: v(2 + i * 3, 0, 0),
          size: v(0.4, 3, 3),
          material: { ...defaultMaterial('penetrable'), resistance: 0.1 },
        }),
      );
    }
    return boxes;
  }

  it('5 个薄盒 = 10 次交互, 截断在第 8 次 (第 4 个盒子的出口)', () => {
    const result = simulateShot(alternatingBoxes(5), [], baseShot({ initialEnergy: 1000, minEnergy: 0 }));
    expect(result.interactionCount).toBe(8);
    expect(result.endReason).toBe('max-interactions');
    // 第 8 次交互是第 4 盒 (中心 x=11) 的出口 x=11.2
    expectVec(result.endPoint, v(11.2, 0, 0));
    // 第 5 盒完全没有被碰到
    expect(result.contacts.every((c) => c.objectId !== 'b4')).toBe(true);
  });

  it('maxInteractions 调到 3 时只发生 3 次交互', () => {
    const result = simulateShot(
      alternatingBoxes(3),
      [],
      baseShot({ initialEnergy: 1000, minEnergy: 0, maxInteractions: 3 }),
    );
    expect(result.interactionCount).toBe(3);
    expect(result.endReason).toBe('max-interactions');
  });
});

describe('模拟器: 无命中也要画到射程终点, 最低能量结束', () => {
  it('空场景: 单段飞行长度等于最大射程', () => {
    const result = simulateShot([], [], baseShot({ origin: v(0, 0, 0), maxRange: 25 }));
    expect(result.endReason).toBe('max-range');
    expect(result.segments.length).toBe(1);
    expect(result.segments[0].length).toBeCloseTo(25, TOL_DIST);
    expectVec(result.endPoint, v(25, 0, 0));
    expect(result.totalDistance).toBeCloseTo(25, TOL_DIST);
  });

  it('初始能量低于最低能量阈值时直接结束, 不产生线段', () => {
    const result = simulateShot([], [], baseShot({ initialEnergy: 0.5, minEnergy: 1 }));
    expect(result.endReason).toBe('min-energy');
    expect(result.segments.length).toBe(0);
  });

  it('射程小于到第一个物体的距离时, 先到射程终点', () => {
    const box = makeBox({
      name: 'far',
      position: v(10, 0, 0),
      size: v(2, 2, 2),
      material: defaultMaterial('blocking'),
    });
    const result = simulateShot([box], [], baseShot({ maxRange: 5 }));
    expect(result.endReason).toBe('max-range');
    expectVec(result.endPoint, v(-5, 0, 0));
  });
});

describe('模拟器: 反弹条件不满足时停在表面, 且不会连续命中同一处', () => {
  it('入射角超过材料允许角度 → reflect-rejected, 停在表面', () => {
    // 斜向入射: dir=(0.5,0,-0.866), 对朝向入射方的竖直墙面入射角 30°
    const dir = v(0.5, 0, -Math.sqrt(0.75)).normalize();
    const narrow = makeBox({
      name: 'narrow',
      position: v(2, 0, 0),
      size: v(2, 6, 6),
      material: { ...defaultMaterial('reflective'), maxReflectAngleDeg: 20, reflectLossRatio: 0.2 },
    });
    const result = simulateShot([narrow], [], baseShot({ origin: v(0, 0, 4), direction: dir }));
    expect(result.endReason).toBe('reflect-rejected');
    expect(result.contacts.length).toBe(1);
  });

  it('反射后能量低于最低能量 → reflect-rejected', () => {
    const flat = makeBox({
      name: 'flat',
      position: v(2, 0, 0),
      size: v(2, 6, 6),
      material: { ...defaultMaterial('reflective'), maxReflectAngleDeg: 80, reflectLossRatio: 0.5 },
    });
    const result = simulateShot([flat], [], baseShot({ initialEnergy: 1.5, minEnergy: 1 }));
    expect(result.endReason).toBe('reflect-rejected');
  });

  it('连续反弹: 两面平行反射墙之间不会因贴合表面重复计数', () => {
    const wallA = makeBox({
      name: 'wallA',
      position: v(0, 0, 3),
      size: v(8, 6, 0.5),
      material: { ...defaultMaterial('reflective'), maxReflectAngleDeg: 80, reflectLossRatio: 0.1 },
    });
    const wallB = makeBox({
      name: 'wallB',
      position: v(0, 0, -3),
      size: v(8, 6, 0.5),
      material: { ...defaultMaterial('reflective'), maxReflectAngleDeg: 80, reflectLossRatio: 0.1 },
    });
    const result = simulateShot(
      [wallA, wallB],
      [],
      baseShot({ origin: v(0, 0, 0), direction: v(0, 0, 1), initialEnergy: 100, minEnergy: 1, maxRange: 2000 }),
    );
    // 每次反射扣 10%, 100*0.9^k < 1 在第 44 次之前; 但交互上限 8 先生效
    expect(result.interactionCount).toBe(8);
    expect(result.endReason).toBe('max-interactions');
    // 接触点必须交替出现在两面墙上, 不能连续两次同一物体同一处
    const reflectContacts = result.contacts.filter((c) => c.kind === 'reflect');
    for (let i = 1; i < reflectContacts.length; i++) {
      expect(reflectContacts[i].objectId).not.toBe(reflectContacts[i - 1].objectId);
    }
  });
});

describe('模拟器: 发射点已在盒体内部 (边缘构型)', () => {
  const originInside = v(0, 0, 0);
  const centered = (over: Partial<BoxDef>) =>
    makeBox({ name: 'centered', position: v(0, 0, 0), size: v(2, 2, 2), ...over, material: over.material ?? defaultMaterial('blocking') });

  it('可穿透: 入口在发射点, 内部段从发射点计到出口并正常扣费, 之后飞满射程', () => {
    const box = centered({ material: { ...defaultMaterial('penetrable'), resistance: 4 } });
    const result = simulateShot(
      [box],
      [],
      baseShot({ origin: originInside, maxRange: 60, initialEnergy: 100 }),
    );
    // 盒内 x 方向从 0 到 1, 内部长度 1, 扣费 4
    const inside = result.segments.find((s) => s.type === 'inside')!;
    expect(inside.length).toBeCloseTo(1, TOL_DIST);
    expect(inside.energyAfter).toBeCloseTo(96, TOL_ENERGY);
    expect(result.contacts.map((c) => c.kind)).toEqual(['entry', 'exit']);
    expectVec(result.contacts[0].point, v(0, 0, 0));
    expectVec(result.contacts[1].point, v(1, 0, 0));
    expect(result.endReason).toBe('max-range');
  });

  it('完全阻挡: 交互发生在穿出的出口面 (1,0,0), 而非发射点', () => {
    const box = centered({ material: defaultMaterial('blocking') });
    const result = simulateShot([box], [], baseShot({ origin: originInside }));
    expect(result.endReason).toBe('blocked');
    expect(result.contacts.length).toBe(1);
    expectVec(result.endPoint, v(1, 0, 0));
    expectVec(result.contacts[0].normal!, v(1, 0, 0), TOL_VEC);
  });

  it('可反弹: 在出口面按出口法线判定, 角度满足时沿 -x 反射', () => {
    const box = centered({
      material: { ...defaultMaterial('reflective'), maxReflectAngleDeg: 90, reflectLossRatio: 0.2 },
    });
    const result = simulateShot([box], [], baseShot({ origin: originInside, initialEnergy: 100 }));
    expect(result.contacts[0].kind).toBe('reflect');
    expectVec(result.contacts[0].point, v(1, 0, 0));
    // 出口法线朝 +x, +x 入射反射后为 -x
    const after = result.segments.filter((s) => s.type === 'flight').pop()!;
    const dir = after.end.clone().sub(after.start).normalize();
    expectVec(dir, v(-1, 0, 0), TOL_VEC);
  });
});

describe('模拟器: 穿透过程中射程先耗尽', () => {
  it('内部段停点由剩余射程截断, 结束原因为 max-range', () => {
    const thick = makeBox({
      name: 'thick',
      position: v(4, 0, 0),
      size: v(6, 4, 4), // x 范围 1..7
      material: { ...defaultMaterial('penetrable'), resistance: 0.1 },
    });
    // 射程 3 (原点 x=0): 入口在 x=1 (走 1), 内部还能走 2 → 停在 x=3
    const result = simulateShot(
      [thick],
      [],
      baseShot({ origin: v(0, 0, 0), maxRange: 3, initialEnergy: 1000 }),
    );
    expectVec(result.endPoint, v(3, 0, 0));
    expect(result.endReason).toBe('max-range');
    const inside = result.segments.find((s) => s.type === 'inside')!;
    expect(inside.length).toBeCloseTo(2, TOL_DIST);
  });
});

describe('靶面与靶面/箱体的 SAT 辅助', () => {
  it('两个分离靶面不相交', () => {
    const a: TargetDef = makeTarget({ name: 'a', position: v(0, 0, 0) });
    const b: TargetDef = makeTarget({ name: 'b', position: v(5, 0, 0) });
    // targetsOverlap 通过薄盒 SAT 实现, 这里直接验证 boxTargetOverlap 路径可用
    const probe: BoxDef = makeBox({ name: 'p', position: v(0, 0, 0), size: v(1, 1, 1), material: defaultMaterial('blocking') });
    expect(boxTargetOverlap(probe, b)).toBe(false);
    expect(boxTargetOverlap(probe, a)).toBe(true);
  });
});
