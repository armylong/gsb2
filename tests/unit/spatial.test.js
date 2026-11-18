import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  azimuth,
  elevation,
  distance,
  describeSpatial,
  azimuthLabel,
  wrapAngle,
  relativeVector,
} from '../../src/spatial.js';

const listenerAt = (over = {}) => ({ x: 0, y: 0, z: 0, yaw: 0, ...over });
const sourceAt = (over = {}) => ({ x: 0, y: 0, z: 0, ...over });

test('距离计算与坐标轴无关，等于欧氏距离', () => {
  assert.equal(distance(sourceAt({ x: 3, z: 4 }), listenerAt()), 5);
  assert.equal(distance(sourceAt({ x: 1, y: 2, z: 2 }), listenerAt()), 3);
  assert.equal(distance(sourceAt({ x: -5 }), listenerAt({ x: 2 })), 7);
});

test('相对向量以听者为原点', () => {
  assert.deepEqual(
    relativeVector(sourceAt({ x: 4, y: 1, z: -2 }), listenerAt({ x: 1, y: 1, z: 2 })),
    { x: 3, y: 0, z: -4 },
  );
});

test('yaw=0 时右侧声源方位角为正、左侧为负（左右定位基础）', () => {
  // 听者面向 -z，右方为 +x
  assert.ok(Math.abs(azimuth(sourceAt({ x: 5, z: -0.0001 }), listenerAt()) - 90) < 0.01);
  assert.ok(Math.abs(azimuth(sourceAt({ x: -5, z: -0.0001 }), listenerAt()) + 90) < 0.01);
  assert.equal(azimuth(sourceAt({ z: -5 }), listenerAt()), 0);
  // 正后方接近 ±180
  const behind = azimuth(sourceAt({ z: 5 }), listenerAt());
  assert.ok(Math.abs(behind) > 179, `后方角度应为 ~180，实际 ${behind}`);
});

test('听者转向后，原本在右的声源会移到左（朝向变化反转左右）', () => {
  const src = sourceAt({ x: 5, z: -0.0001 });
  const before = azimuth(src, listenerAt());
  assert.ok(Math.abs(before - 90) < 0.01);
  // 听者右转 180°，同一世界坐标的声源相对方位变到左侧
  const after = azimuth(src, listenerAt({ yaw: 180 }));
  assert.ok(Math.abs(after + 90) < 0.01);
  // 右转 90° 后，原右侧声源落在正后方
  const quarter = azimuth(src, listenerAt({ yaw: 90 }));
  assert.ok(Math.abs(Math.abs(quarter) - 180) < 1, `实际 ${quarter}`);
});

test('连续转向时方位角平滑跟随且始终落在 (-180,180]', () => {
  const src = sourceAt({ x: 3, z: -4 });
  const angles = [];
  for (let yaw = 0; yaw <= 720; yaw += 15) {
    const a = azimuth(src, listenerAt({ yaw }));
    assert.ok(a > -180 && a <= 180);
    angles.push(a);
  }
  // 转满两圈后方位角应回到初始值（无累积漂移）
  assert.ok(Math.abs(angles[angles.length - 1] - angles[0]) < 1e-9);
});

test('仰角随高度差变化', () => {
  // 声源在听者正上方（水平距离为 0）
  assert.equal(elevation(sourceAt({ x: 0, y: 5, z: 0 }), listenerAt({ x: 0, y: 0, z: 0 })), 90);
  assert.ok(elevation(sourceAt({ y: 3, z: -4 }), listenerAt()) > 30);
  // 同高度时仰角为 0（atan2(0, 正数) = +0，用容差比较以兼容 -0）
  assert.ok(Math.abs(elevation(sourceAt({ y: 2 }), listenerAt({ y: 2, z: 3 }))) < 1e-12);
});

test('方位文字标签分区正确', () => {
  assert.equal(azimuthLabel(0), '正前方');
  assert.equal(azimuthLabel(90), '右侧');
  assert.equal(azimuthLabel(-90), '左侧');
  assert.equal(azimuthLabel(180), '右后方');
  assert.equal(azimuthLabel(-180), '左后方');
});

test('describeSpatial 同时给出距离、方位、仰角和标签', () => {
  const r = describeSpatial(sourceAt({ x: 3, z: -4, y: 0 }), listenerAt());
  assert.equal(r.distance, 5);
  assert.ok(r.azimuth > 30 && r.azimuth < 40);
  assert.equal(r.elevation, 0);
  assert.equal(r.label, '右前方');
});

test('wrapAngle 把任意角度规范到 (-180,180]', () => {
  assert.equal(wrapAngle(190), -170);
  assert.equal(wrapAngle(-190), 170);
  // 360 的整数倍归一为 0（可能是 +0/-0，数值上等价）
  assert.equal(Object.is(wrapAngle(360), -0) || wrapAngle(360) === 0, true);
  assert.equal(Object.is(wrapAngle(-360), -0) || wrapAngle(-360) === 0, true);
});
