/**
 * 可运行的验证命令：npm test
 * 使用 Node 内置测试运行器（node --test），无需额外测试框架。
 * 验证：
 *  1. CPU 权重核心的归一化、主导轴、陡度、偏置等行为；
 *  2. 与 GLSL 着色器同一公式（shaders.ts 中的 GLSL 逻辑以此处为基准）；
 *  3. 程序生成网格的法线朝向（水平/竖直/斜面/转角/弯面）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { triplanarWeights, rawAxisWeight, planeUV, sampleCoordinates } from '../src/triplanar';
import { createRampGeometry, createCornerGeometry, createBendGeometry, createBoxGeometry } from '../src/geometry';

const base = { biases: { x: 1, y: 1, z: 1 }, sharpness: 1 };

test('轴对齐面：权重完全落在对应轴上', () => {
  const r = triplanarWeights({ x: 0.5, y: 0.2, z: -0.3 }, { x: 0, y: 1, z: 0 }, base);
  assert.equal(r.dominantAxis, 1);
  assert.ok(Math.abs(r.axes[1].weight - 1) < 1e-12);
  assert.ok(Math.abs(r.axes[0].weight) < 1e-12);
  assert.equal(r.maxWeight, 1);
});

test('三轴等角 (1,1,1)：权重相等且归一化为 1', () => {
  const r = triplanarWeights({ x: 1, y: 2, z: 3 }, { x: 1, y: 1, z: 1 }, base);
  for (const a of r.axes) assert.ok(Math.abs(a.weight - 1 / 3) < 1e-12);
  assert.ok(Math.abs(r.axes.reduce((s, a) => s + a.weight, 0) - 1) < 1e-12);
});

test('反向法线 (-1,-1,-1)：权重与正向一致，符号为负', () => {
  const p = { x: 0, y: 0, z: 0 };
  const pos = triplanarWeights(p, { x: 1, y: 1, z: 1 }, base);
  const neg = triplanarWeights(p, { x: -1, y: -1, z: -1 }, base);
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(pos.axes[i].weight - neg.axes[i].weight) < 1e-12);
    assert.equal(neg.axes[i].sign, -1);
    assert.equal(pos.axes[i].sign, 1);
  }
});

test('陡度提升：分量不均等的面上主导权重上升、过渡带变窄', () => {
  // 精确 45° 是平局（任何指数都保持 0.5/0.5），故用 0.8/0.6 体现锐化
  const n = { x: 0.8, y: 0.6, z: 0 };
  const linear = triplanarWeights({ x: 0, y: 0, z: 0 }, n, base);
  const sharp = triplanarWeights({ x: 0, y: 0, z: 0 }, n, { ...base, sharpness: 8 });
  // 线性归一化：0.8/(0.8+0.6) ≈ 0.571；锐化后 ≈ 0.909
  assert.ok(Math.abs(linear.axes[0].weight - 0.8 / 1.4) < 1e-9);
  assert.ok(sharp.axes[0].weight > 0.9, `锐化后 X 权重应 >0.9，实际 ${sharp.axes[0].weight}`);
  assert.ok(sharp.axes[1].weight < linear.axes[1].weight);
  assert.ok(sharp.maxWeight > linear.maxWeight);
});

test('轴偏置：把 X 偏置清零后任何面都不再使用 X 轴', () => {
  const r = triplanarWeights(
    { x: 0, y: 0, z: 0 },
    { x: 0.9, y: 0.1, z: 0.1 },
    { biases: { x: 0, y: 1, z: 1 }, sharpness: 1 },
  );
  assert.equal(r.axes[0].weight, 0);
  assert.notEqual(r.dominantAxis, 0);
});

test('未归一化法线：内部归一化后结果稳定', () => {
  const r1 = triplanarWeights({ x: 0, y: 0, z: 0 }, { x: 2, y: 2, z: 2 }, base);
  const r2 = triplanarWeights({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }, base);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(r1.axes[i].weight - r2.axes[i].weight) < 1e-12);
});

test('零向量法线不产生 NaN（回退为等权）', () => {
  const r = triplanarWeights({ x: 1, y: 2, z: 3 }, { x: 0, y: 0, z: 0 }, base);
  for (const a of r.axes) {
    assert.ok(Number.isFinite(a.weight));
    assert.ok(Math.abs(a.weight - 1 / 3) < 1e-12);
  }
});

test('平面 UV 与 GLSL planeX/Y/Z 公式一致', () => {
  const p = { x: 1, y: 2, z: 3 };
  // X 平面，法线 +X：(-z, y)；法线 -X：(z, y)
  assert.deepEqual(planeUV(p, { x: 1, y: 0, z: 0 }, 0), [-3, 2]);
  assert.deepEqual(planeUV(p, { x: -1, y: 0, z: 0 }, 0), [3, 2]);
  // Y 平面：(x, ±z)
  assert.deepEqual(planeUV(p, { x: 0, y: 1, z: 0 }, 1), [1, 3]);
  assert.deepEqual(planeUV(p, { x: 0, y: -1, z: 0 }, 1), [1, -3]);
  // Z 平面：(x, y)
  assert.deepEqual(planeUV(p, { x: 0, y: 0, z: 1 }, 2), [1, 2]);
});

test('rawAxisWeight 即 |n| * bias（陡度在归一化后施加）', () => {
  const n = { x: 0.5, y: 0, z: 0 };
  assert.ok(Math.abs(rawAxisWeight(n, 0, base) - 0.5) < 1e-12);
  assert.ok(Math.abs(rawAxisWeight(n, 0, { biases: { x: 2, y: 1, z: 1 }, sharpness: 3 }) - 1) < 1e-12);
  assert.equal(rawAxisWeight(n, 1, base), 0);
});

test('sampleCoordinates 应用缩放与偏移', () => {
  assert.deepEqual(sampleCoordinates([2, -1], 1.5, { x: 10, y: 20, z: 0 }), [13, 18.5]);
});

test('45° 斜面落在混合区内（maxWeight 低于常见阈值）', () => {
  const r = triplanarWeights({ x: 0, y: 0, z: 0 }, { x: Math.SQRT1_2, y: Math.SQRT1_2, z: 0 }, base);
  assert.ok(r.maxWeight < 0.8);
});

// ---------- 几何检查 ----------
function distinctNormals(geo: ReturnType<typeof createRampGeometry>): THREE_NormalLike[] {
  const n = geo.getAttribute('normal');
  const seen = new Map<string, THREE_NormalLike>();
  for (let i = 0; i < n.count; i++) {
    const v = { x: round(n.getX(i)), y: round(n.getY(i)), z: round(n.getZ(i)) };
    seen.set(`${v.x},${v.y},${v.z}`, v);
  }
  return [...seen.values()];
}

type THREE_NormalLike = { x: number; y: number; z: number };
const round = (v: number) => Math.round(v * 1000) / 1000;
const hasNormal = (list: THREE_NormalLike[], x: number, y: number, z: number) =>
  list.some((n) => n.x === x && n.y === y && n.z === z);

test('斜坡台：同时具备 +Y 水平、±X 竖直、±Z 端盖与 45° 斜面法线', () => {
  const geo = createRampGeometry();
  const normals = distinctNormals(geo);
  assert.ok(hasNormal(normals, 0, 1, 0), '应有 +Y 水平面');
  assert.ok(hasNormal(normals, 1, 0, 0) && hasNormal(normals, -1, 0, 0), '应有 ±X 竖直侧壁');
  assert.ok(hasNormal(normals, 0, 0, 1) && hasNormal(normals, 0, 0, -1), '应有 ±Z 端盖');
  const d = Math.SQRT1_2;
  // 斜面向 +z 升高，朝外法线为 (0, +0.707, -0.707)
  assert.ok(hasNormal(normals, 0, round(d), round(-d)), '应有 45° 斜面法线 (0,+0.707,-0.707)');
  assert.ok(hasNormal(normals, 0, -1, 0), '应有朝下底盖');
  // 无 NaN
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    assert.ok(Number.isFinite(pos.getX(i)) && Number.isFinite(pos.getY(i)) && Number.isFinite(pos.getZ(i)));
  }
});

test('凹转角：地板 +Y、两墙分别 +X / +Z，交线处三轴权重可过渡', () => {
  const geo = createCornerGeometry();
  const normals = distinctNormals(geo);
  assert.ok(hasNormal(normals, 0, 1, 0));
  assert.ok(hasNormal(normals, 1, 0, 0));
  assert.ok(hasNormal(normals, 0, 0, 1));
  // 交线附近的法线 (1,1,0) 在 sharpness=1 时两轴各 0.5
  const r = triplanarWeights({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }, base);
  assert.ok(Math.abs(r.axes[0].weight - 0.5) < 1e-12);
  assert.ok(Math.abs(r.axes[1].weight - 0.5) < 1e-12);
});

test('圆弧弯面：法线从 +Y 连续扫到 -Z，覆盖中间全部斜面角度', () => {
  const geo = createBendGeometry(16);
  const normals = distinctNormals(geo);
  assert.ok(hasNormal(normals, 0, 1, 0));
  assert.ok(hasNormal(normals, 0, 0, -1));
  // 至少出现 8 种不同的中间角度法线（平滑过渡而非硬切）
  const middles = normals.filter((n) => n.y > 0.2 && n.z < -0.2);
  assert.ok(middles.length >= 8, `中间角度法线数量不足: ${middles.length}`);
  assert.ok(geo.index !== null, '弯面应为索引网格以共享平滑顶点');
});

test('立方体：六个轴对齐朝向齐全', () => {
  const geo = createBoxGeometry();
  const normals = distinctNormals(geo);
  for (const [x, y, z] of [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ]) {
    assert.ok(hasNormal(normals, x, y, z));
  }
});

test('全部网格顶点都有有限坐标且包围球有效', () => {
  for (const factory of [createRampGeometry, createCornerGeometry, createBendGeometry, createBoxGeometry]) {
    const geo = factory();
    geo.computeBoundingSphere();
    assert.ok(geo.boundingSphere && Number.isFinite(geo.boundingSphere.radius) && geo.boundingSphere.radius > 0);
  }
});
