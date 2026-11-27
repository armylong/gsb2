import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  YawFilter,
  computeYLockedYaw,
  faceTargetQuaternion,
  wrapPi,
  YLOCK_UNDECIDABLE_RATIO,
} from '../src/orientation.ts';

describe('wrapPi', () => {
  it('把角度规范到 (-PI, PI]', () => {
    assert.equal(wrapPi(0), 0);
    assert.ok(Math.abs(wrapPi(Math.PI * 3) - Math.PI) < 1e-9);
    assert.ok(Math.abs(wrapPi(-Math.PI * 3) - Math.PI) < 1e-9);
    assert.ok(Math.abs(wrapPi(Math.PI + 0.1) + Math.PI - 0.1) < 1e-9);
  });
});

describe('YawFilter', () => {
  it('跨 ±PI 走最短路径，不发生 180° 跳变', () => {
    const f = new YawFilter(Math.PI - 0.05);
    const next = f.approach(-Math.PI + 0.05, 0.5);
    // 从 +(PI-0.05) 到 -(PI-0.05) 的最短差是 -0.1，结果应连续增长越过 PI
    assert.ok(next > Math.PI - 0.06, `实际: ${next}`);
    assert.ok(next < Math.PI + 0.06, `实际: ${next}`);
  });

  it('hold 后数值冻结，离开奇点可继续逼近', () => {
    const f = new YawFilter(1.2);
    f.hold();
    f.hold();
    assert.equal(f.value, 1.2);
    const after = f.approach(1.5, 1);
    assert.ok(Math.abs(after - 1.5) < 1e-9);
  });
});

describe('computeYLockedYaw', () => {
  const anchor = new THREE.Vector3(0, 2, 0);

  it('相机在 +Z 方向时偏航为 0（牌面默认朝 +Z）', () => {
    const r = computeYLockedYaw(new THREE.Vector3(0, 2, 5), anchor);
    assert.ok(Math.abs(r.yaw) < 1e-9);
    assert.equal(r.undecidable, false);
  });

  it('相机在 +X 方向时偏航为 +PI/2', () => {
    const r = computeYLockedYaw(new THREE.Vector3(5, 2, 0), anchor);
    assert.ok(Math.abs(r.yaw - Math.PI / 2) < 1e-9);
  });

  it('正上方（视线平行竖轴）判定为无法决定', () => {
    const r = computeYLockedYaw(new THREE.Vector3(0.001, 10, 0.001), anchor);
    assert.equal(r.undecidable, true);
    assert.ok(r.ratio < YLOCK_UNDECIDABLE_RATIO);
  });

  it('斜侧视角可决定且比例随高度下降', () => {
    const r = computeYLockedYaw(new THREE.Vector3(3, 5, 4), anchor);
    assert.equal(r.undecidable, false);
    assert.ok(r.yaw > 0 && r.yaw < Math.PI / 2);
    assert.ok(r.ratio > YLOCK_UNDECIDABLE_RATIO);
  });

  it('绕牌一圈偏航连续覆盖完整圆周', () => {
    const prev: number[] = [];
    for (let i = 0; i <= 360; i += 10) {
      const a = THREE.MathUtils.degToRad(i);
      const cam = new THREE.Vector3(Math.sin(a) * 4, 2, Math.cos(a) * 4);
      const r = computeYLockedYaw(cam, anchor);
      prev.push(r.yaw);
      assert.equal(r.undecidable, false);
    }
    // 一圈后回到起点，目标角误差应在一个采样步长内
    const wrap = (x: number) => wrapPi(x);
    assert.ok(Math.abs(wrap(prev[prev.length - 1] - prev[0])) < THREE.MathUtils.degToRad(12));
  });
});

describe('faceTargetQuaternion', () => {
  const anchor = new THREE.Vector3(0, 1, 0);
  const up = new THREE.Vector3(0, 1, 0);
  const out = new THREE.Quaternion();

  it('相机在正前方时法线（局部+Z）对准相机', () => {
    const hold = faceTargetQuaternion(out, new THREE.Vector3(0, 1, 5), anchor, up);
    assert.equal(hold, false);
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(out);
    assert.ok(Math.abs(normal.z - 1) < 1e-6);
  });

  it('视线与竖轴平行时要求保持上一姿态', () => {
    const hold = faceTargetQuaternion(out, new THREE.Vector3(0, 9, 0), anchor, up);
    assert.equal(hold, true);
  });

  it('相机与锚点重合时保持', () => {
    const hold = faceTargetQuaternion(out, anchor.clone(), anchor, up);
    assert.equal(hold, true);
  });

  it('转到侧面后法线水平分量指向相机', () => {
    faceTargetQuaternion(out, new THREE.Vector3(5, 1, 0), anchor, up);
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(out);
    assert.ok(Math.abs(normal.x - 1) < 1e-6);
    assert.ok(Math.abs(normal.y) < 1e-6);
  });
});
