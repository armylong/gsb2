import { describe, expect, it } from 'vitest';
import { BONE_COUNT, clamp01, WeightModel } from '../src/weights/WeightModel';

function makeModel(weights: number[]): WeightModel {
  const model = new WeightModel(weights.length / BONE_COUNT);
  model.data.set(weights);
  return model;
}

const sum = (model: WeightModel, v = 0) =>
  Array.from({ length: BONE_COUNT }, (_, b) => model.get(v, b)).reduce((a, w) => a + w, 0);

describe('WeightModel 基础约束', () => {
  it('clamp01 把值夹在 [0,1]', () => {
    expect(clamp01(-2)).toBe(0);
    expect(clamp01(0.4)).toBeCloseTo(0.4);
    expect(clamp01(3)).toBe(1);
  });

  it('构造数据长度非法时抛错', () => {
    expect(() => new WeightModel(2, new Float32Array(5))).toThrow();
  });

  it('validate 接受归一且范围合法的权重', () => {
    const model = makeModel([0.2, 0.3, 0.5]);
    const result = model.validate();
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('validate 拒绝权重和不为 1 的数据', () => {
    const model = makeModel([0.2, 0.3, 0.4]);
    expect(model.validate().ok).toBe(false);
  });
});

describe('笔刷:加权重', () => {
  it('增加目标骨骼权重时,其余未锁定骨骼按比例被扣减,总和仍为 1', () => {
    const model = makeModel([0.2, 0.5, 0.3]);
    const changed = model.paintVertex(0, { bone: 1, delta: 0.2, locked: [false, false, false] });

    expect(changed).toBe(true);
    expect(model.get(0, 1)).toBeCloseTo(0.7);
    // 0.2 / 0.3 的比例保持不变
    expect(model.get(0, 0) / model.get(0, 2)).toBeCloseTo(0.2 / 0.3);
    expect(sum(model)).toBeCloseTo(1);
    expect(model.validate().ok).toBe(true);
  });

  it('目标骨骼已到 1 时增量被夹断,返回 false', () => {
    const model = makeModel([0, 1, 0]);
    const changed = model.paintVertex(0, { bone: 1, delta: 0.3, locked: [false, false, false] });
    expect(changed).toBe(false);
    expect(model.weightsOf(0)).toEqual([0, 1, 0]);
  });
});

describe('笔刷:减权重', () => {
  it('减少目标骨骼权重时,其余骨骼按剩余空间比例补足,总和仍为 1', () => {
    const model = makeModel([0.2, 0.5, 0.3]);
    const changed = model.paintVertex(0, { bone: 1, delta: -0.3, locked: [false, false, false] });

    expect(changed).toBe(true);
    expect(model.get(0, 1)).toBeCloseTo(0.2);
    expect(sum(model)).toBeCloseTo(1);
    expect(model.validate().ok).toBe(true);
  });

  it('目标骨骼为 0 时无法继续减,返回 false', () => {
    const model = makeModel([0.4, 0.6, 0]);
    const changed = model.paintVertex(0, { bone: 2, delta: -0.2, locked: [false, false, false] });
    expect(changed).toBe(false);
  });
});

describe('锁定约束', () => {
  it('目标骨骼被锁定时笔刷直接忽略', () => {
    const model = makeModel([0.2, 0.5, 0.3]);
    const before = model.weightsOf(0);
    const changed = model.paintVertex(0, { bone: 1, delta: 0.2, locked: [false, true, false] });
    expect(changed).toBe(false);
    expect(model.weightsOf(0)).toEqual(before);
  });

  it('非目标锁定骨骼的权重在再分配中保持不变', () => {
    const model = makeModel([0.2, 0.5, 0.3]);
    const changed = model.paintVertex(0, { bone: 1, delta: 0.2, locked: [true, false, false] });

    expect(changed).toBe(true);
    expect(model.get(0, 0)).toBeCloseTo(0.2); // 骨骼0 锁定,纹丝不动
    expect(model.get(0, 1)).toBeCloseTo(0.7);
    expect(model.get(0, 2)).toBeCloseTo(0.1); // 只有骨骼2 吸收差值
    expect(sum(model)).toBeCloseTo(1);
  });

  it('减权重时锁定骨骼同样不参与补足', () => {
    const model = makeModel([0.2, 0.5, 0.3]);
    const changed = model.paintVertex(0, { bone: 1, delta: -0.3, locked: [true, false, false] });

    expect(changed).toBe(true);
    expect(model.get(0, 0)).toBeCloseTo(0.2);
    expect(model.get(0, 1)).toBeCloseTo(0.2);
    expect(model.get(0, 2)).toBeCloseTo(0.6);
    expect(sum(model)).toBeCloseTo(1);
  });

  it('其余未锁定骨骼都为 0、无法吸收增量时,修改被整体拒绝', () => {
    // 骨骼2 锁定;唯一可扣减的骨骼1 权重为 0,无处转移 -> 拒绝
    const model = makeModel([0, 0, 1]);
    const changed = model.paintVertex(0, { bone: 0, delta: 0.4, locked: [false, false, true] });
    expect(changed).toBe(false);
    expect(model.weightsOf(0)).toEqual([0, 0, 1]);
  });

  it('两根骨骼锁定时,唯一未锁定骨骼没有可用空间,笔刷被拒绝且锁定值不变', () => {
    const model = makeModel([0.2, 0.5, 0.3]);
    const before = model.weightsOf(0);
    const changed = model.paintVertex(0, { bone: 2, delta: 0.25, locked: [true, true, false] });
    expect(changed).toBe(false);
    expect(model.weightsOf(0)).toEqual(before);
    // 反向(减权重)同样无处补足
    const down = model.paintVertex(0, { bone: 2, delta: -0.2, locked: [true, true, false] });
    expect(down).toBe(false);
  });

  it('两根骨骼锁定时,唯一未锁定骨骼无论加或减都无对端可分摊,笔刷被拒绝且锁定值不变', () => {
    const model = makeModel([0.2, 0.5, 0.3]);
    const before = model.weightsOf(0);
    // 加权重:没有其他未锁定骨骼可供扣减
    const up = model.paintVertex(0, { bone: 1, delta: 0.2, locked: [true, false, true] });
    expect(up).toBe(false);
    // 减权重:释放的量没有其他未锁定骨骼可以接管
    const down = model.paintVertex(0, { bone: 1, delta: -0.2, locked: [true, false, true] });
    expect(down).toBe(false);
    expect(model.weightsOf(0)).toEqual(before);
  });

  it('只锁一根时,未锁定骨骼之间可正常再分配,锁定值与归一保持', () => {
    const model = makeModel([0.2, 0.5, 0.3]);
    const changed = model.paintVertex(0, { bone: 2, delta: -0.2, locked: [true, false, false] });
    expect(changed).toBe(true);
    expect(model.get(0, 0)).toBeCloseTo(0.2);
    expect(model.get(0, 2)).toBeCloseTo(0.1);
    expect(model.get(0, 1)).toBeCloseTo(0.7);
    expect(sum(model)).toBeCloseTo(1);
  });
});

describe('预设与锁定', () => {
  it('applyPresetPreservingLocks 保留锁定权重,未锁定部分重新归一', () => {
    const model = makeModel([0.2, 0.5, 0.3]);
    model.applyPresetPreservingLocks([1, 0, 0], 0, [false, true, false]);

    expect(model.get(0, 1)).toBeCloseTo(0.5);
    expect(model.get(0, 0) + model.get(0, 2)).toBeCloseTo(0.5);
    expect(sum(model)).toBeCloseTo(1);
  });

  it('clone 产出互不影响的深拷贝', () => {
    const model = makeModel([0.2, 0.5, 0.3]);
    const copy = model.clone();
    copy.setRaw(0, 0, 0.9);
    expect(model.get(0, 0)).toBeCloseTo(0.2);
    expect(copy.get(0, 0)).toBeCloseTo(0.9);
  });
});
