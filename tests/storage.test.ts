import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertStateMatches,
  BonePose,
  clearLocalStorage,
  decodeState,
  encodeState,
  loadFromLocalStorage,
  saveToLocalStorage,
  STORAGE_KEY,
} from '../src/weights/storage';
import { BONE_COUNT, WeightModel } from '../src/weights/WeightModel';

// 极简 localStorage shim(node 环境无 DOM)
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

const poses: BonePose[] = [
  { rotY: 10, rotZ: 0 },
  { rotY: -42, rotZ: 5 },
  { rotY: 0, rotZ: 30 },
];
const locked = [false, true, false];

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('encodeState / decodeState 往返', () => {
  it('权重与姿态序列化后可无损还原', () => {
    const model = new WeightModel(4);
    for (let v = 0; v < 4; v++) {
      model.setRaw(v, 0, 0.2);
      model.setRaw(v, 1, 0.5);
      model.setRaw(v, 2, 0.3);
    }
    const json = encodeState(model.data, poses, locked, 'elbow');
    const state = decodeState(json);

    expect(state.version).toBe(1);
    expect(state.vertexCount).toBe(4);
    expect(state.weights).toHaveLength(4 * BONE_COUNT);
    expect(state.weights[1]).toBeCloseTo(0.5);
    expect(state.poses).toEqual(poses);
    expect(state.locked).toEqual(locked);
    expect(state.presetId).toBe('elbow');
    expect(typeof state.savedAt).toBe('string');
  });

  it('非法 JSON / 错误版本 / 字段缺失 / 越界权重均被拒绝', () => {
    expect(() => decodeState('not-json')).toThrow('JSON');
    expect(() => decodeState(JSON.stringify({ version: 9 }))).toThrow('版本');
    expect(() => decodeState(JSON.stringify({ version: 1, weights: [], poses: [], locked: [] }))).toThrow();
    const bad = {
      version: 1,
      vertexCount: 1,
      weights: [1.5, -0.2, -0.3],
      poses,
      locked,
    };
    expect(() => decodeState(JSON.stringify(bad))).toThrow('越界');
  });
});

describe('localStorage 持久化', () => {
  it('保存后可按固定 key 读回并解析', () => {
    const weights = new Float32Array([0.1, 0.6, 0.3]);
    saveToLocalStorage(encodeState(weights, poses, locked, 'tail'));

    const raw = loadFromLocalStorage();
    expect(raw).not.toBeNull();
    const state = decodeState(raw!);
    expect(state.weights).toEqual(Array.from(weights));
    expect(state.poses[1].rotY).toBe(-42);

    clearLocalStorage();
    expect(loadFromLocalStorage()).toBeNull();
  });

  it('存档 key 稳定且带版本号,便于后续迁移', () => {
    expect(STORAGE_KEY).toBe('skinning-weight-debugger:v1');
  });
});

describe('assertStateMatches 顶点数守卫', () => {
  it('顶点数一致时通过,不一致时拒绝恢复', () => {
    const state = decodeState(
      encodeState(new Float32Array([0.2, 0.3, 0.5]), poses, locked, 'default'),
    );
    expect(() => assertStateMatches(state, 1)).not.toThrow();
    expect(() => assertStateMatches(state, 99)).toThrow('顶点数');
  });
});

describe('需求:回绑定姿态不改权重,存档再恢复两者都在', () => {
  it('模拟编辑 -> 姿态归零 -> 存档恢复:权重与姿态独立保持', () => {
    // 1. 初始权重
    const model = new WeightModel(2, new Float32Array([0.2, 0.5, 0.3, 0.7, 0.2, 0.1]));
    // 2. 笔刷编辑(锁定骨骼1)
    model.paintVertex(0, { bone: 0, delta: 0.2, locked: [false, true, false] });
    const edited = new Float32Array(model.data);
    expect(model.validate().ok).toBe(true);

    // 3. "回绑定姿态"只是把旋转归零,权重模型完全不参与 -> 权重不变
    const bindPoses: BonePose[] = poses.map(() => ({ rotY: 0, rotZ: 0 }));
    saveToLocalStorage(encodeState(edited, bindPoses, locked, 'default'));

    // 4. 恢复:姿态为绑定姿态,权重仍是编辑后的结果
    const restored = decodeState(loadFromLocalStorage()!);
    expect(restored.poses.every((p) => p.rotY === 0 && p.rotZ === 0)).toBe(true);
    expect(restored.weights).toEqual(Array.from(edited));
    expect(restored.locked[1]).toBe(true);
  });
});
