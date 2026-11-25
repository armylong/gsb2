import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Quaternion, Vector3 } from 'three';
import { Skeleton } from '../src/core/skeleton';
import {
  JOINT_LABELS,
  ROOT_NAME,
  createSourceDef,
  createTargetDef,
} from '../src/core/skeletons';
import { ClipSampler, createArmTurnClip, createSquatWalkClip } from '../src/core/clips';
import {
  buildRetargetedMotion,
  defaultMapping,
  framesFromMotion,
  parseMapping,
  parseMotion,
  retargetFrame,
  serializeMapping,
  serializeMotion,
  validateMapping,
} from '../src/core/retarget';
import type { JointMapping, RootMotionMode } from '../src/core/retarget';
import type { PoseFrame } from '../src/core/skeleton';

let passed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exitCode = 1;
  }
}

const source = new Skeleton(createSourceDef());
const target = new Skeleton(createTargetDef());
const mapping = defaultMapping(source, target);

/** 重定向一帧并应用到目标（顺序：源先摆好姿势，再计算，再应用到目标） */
function retargetAndApply(
  srcFrame: PoseFrame,
  mode: RootMotionMode,
  useMapping: JointMapping = mapping,
): PoseFrame {
  source.applyFrame(srcFrame);
  target.applyRest(); // 复位到静止基准，避免上一个测试的姿势污染本帧断言
  const out = retargetFrame(source, target, useMapping, srcFrame, mode);
  target.applyFrame(out);
  return out;
}

/** 关节相对自身静止局部系的旋转增量角度（度） */
function localDeltaAngle(sk: Skeleton, name: string): number {
  const i = sk.jointIndex(name);
  const delta = sk.restLocalRot[i].clone().invert().multiply(sk.localRot[i]);
  return (delta.angleTo(new Quaternion()) * 180) / Math.PI;
}

/** 关节出骨头相对自身静止指向的弯曲角（度，无符号），直接反映世界空间里的实际弯曲量 */
function worldBendAngle(sk: Skeleton, name: string): number {
  return (
    (sk.outgoingBoneRestDirection(name).angleTo(sk.outgoingBoneCurrentDirection(name)) * 180) /
    Math.PI
  );
}

/** 出骨头相对静止指向，在指定世界方向上的位移分量（判断弯向身前还是身后） */
function bendAlong(sk: Skeleton, name: string, axis: Vector3): number {
  return sk
    .outgoingBoneCurrentDirection(name)
    .clone()
    .sub(sk.outgoingBoneRestDirection(name))
    .dot(axis);
}

function worldYaw(sk: Skeleton): number {
  // 静止根朝向为单位四元数，世界 yaw 直接取根世界旋转绕 Y 的分量
  const fwd = new Vector3(0, 0, 1).applyQuaternion(sk.worldRot[0]);
  return Math.atan2(fwd.x, fwd.z);
}

console.log('1) 同一套关节层次与不同骨长/静止朝向');
check('两个骨架关节名、父子层次完全一致', () => {
  assert.deepEqual(source.jointNames, target.jointNames);
  for (const name of source.jointNames) {
    const si = source.jointIndex(name);
    const ti = target.jointIndex(name);
    assert.equal(source.parentIndex[si], target.parentIndex[ti], `${name} 父节点不一致`);
  }
  assert.equal(source.jointNames.length, 17);
});

check('目标更高更细，且对应骨长与源不同', () => {
  assert.ok(target.height > source.height * 1.4);
  let different = 0;
  for (const name of source.jointNames) {
    if (name === ROOT_NAME) continue;
    if (Math.abs(target.boneLength(name) - source.boneLength(name)) > 1e-6) different += 1;
  }
  assert.ok(different >= 10, `应至少有 10 根骨长不同，实际 ${different}`);
});

check('目标左膝静止局部轴与源相反（180° 扭转）', () => {
  const sx = new Vector3(1, 0, 0).applyQuaternion(source.restWorldRot[source.jointIndex('lknee')]);
  const tx = new Vector3(1, 0, 0).applyQuaternion(target.restWorldRot[target.jointIndex('lknee')]);
  assert.ok(sx.dot(tx) < -0.9, '左膝局部 X 应近乎反向');
  // 右膝不扭转，X 同向
  const srx = new Vector3(1, 0, 0).applyQuaternion(source.restWorldRot[source.jointIndex('rknee')]);
  const trx = new Vector3(1, 0, 0).applyQuaternion(target.restWorldRot[target.jointIndex('rknee')]);
  assert.ok(srx.dot(trx) > 0.9, '右膝局部 X 应同向');
});

console.log('2) 重定向保留目标骨长、不碰源顶点');
check('重定向后目标每根骨长等于其静止骨长', () => {
  const arm = new ClipSampler(createArmTurnClip());
  for (const t of [0, 0.9, 1.7, 2.4, 3]) {
    retargetAndApply(arm.sample(t, source), 'height');
    for (const name of target.jointNames) {
      if (name === ROOT_NAME) continue;
      const i = target.jointIndex(name);
      const p = target.parentIndex[i];
      const len = target.worldPos[i].distanceTo(target.worldPos[p]);
      assert.ok(
        Math.abs(len - target.boneLength(name)) < 1e-9,
        `${name} 在 t=${t} 骨长发生变化`,
      );
    }
  }
});

console.log('3) 弯曲方向：轴相反时仍按正确解剖方向弯');
const squat = new ClipSampler(createSquatWalkClip());
check('深蹲帧双膝世界弯曲量一致，且都弯向身后（目标左膝轴相反也一样弯）', () => {
  retargetAndApply(squat.sample(0.6, source), 'keep');
  for (const knee of ['lknee', 'rknee']) {
    const s = worldBendAngle(source, knee);
    const t = worldBendAngle(target, knee);
    assert.ok(s > 60, `源 ${knee} 应明显屈膝，实际 ${s.toFixed(1)}°`);
    assert.ok(
      Math.abs(s - t) < 1e-6,
      `${JOINT_LABELS[knee]} 世界弯曲量不一致：源 ${s.toFixed(2)}° 目标 ${t.toFixed(2)}°`,
    );
    // 膝盖弯曲主轴朝身后（-Z），两个骨架小腿都应向 -Z 摆
    assert.ok(bendAlong(source, knee, new Vector3(0, 0, -1)) > 0, `源 ${knee} 应弯向身后`);
    assert.ok(bendAlong(target, knee, new Vector3(0, 0, -1)) > 0, `目标 ${knee} 应弯向身后`);
  }
  // 左膝局部轴确实相反：相同的世界屈膝在目标局部系里绕的是相反方向的轴
  const srcAxis = new Vector3(1, 0, 0).applyQuaternion(source.restWorldRot[source.jointIndex('lknee')]);
  const tgtAxis = new Vector3(1, 0, 0).applyQuaternion(target.restWorldRot[target.jointIndex('lknee')]);
  assert.ok(srcAxis.dot(tgtAxis) < -0.9, '左膝局部 X 轴应相反，但世界弯曲仍同向');
});

check('抬臂帧双肘屈曲量一致且弯向身前（左右镜像、A/T 静止差异各自正确）', () => {
  const armClip = new ClipSampler(createArmTurnClip());
  retargetAndApply(armClip.sample(0.9, source), 'keep');
  for (const elbow of ['lelbow', 'relbow']) {
    const s = localDeltaAngle(source, elbow);
    const t = localDeltaAngle(target, elbow);
    assert.ok(s > 25, `源 ${elbow} 应屈肘，实际 ${s.toFixed(1)}°`);
    assert.ok(
      Math.abs(s - t) < 1e-6,
      `${elbow} 局部屈曲量不一致：源 ${s.toFixed(2)}° 目标 ${t.toFixed(2)}°`,
    );
  }
  // 世界空间里两个骨架的小臂都应向身前（+Z）收拢
  assert.ok(bendAlong(source, 'lelbow', new Vector3(0, 0, 1)) > 0, '源左小臂应弯向身前');
  assert.ok(bendAlong(target, 'lelbow', new Vector3(0, 0, 1)) > 0, '目标左小臂应弯向身前');
  // 目标左肘静止局部轴与源相反，但世界弯曲仍同向
  const srcAxis = new Vector3(1, 0, 0).applyQuaternion(source.restWorldRot[source.jointIndex('lelbow')]);
  const tgtAxis = new Vector3(1, 0, 0).applyQuaternion(target.restWorldRot[target.jointIndex('lelbow')]);
  assert.ok(srcAxis.dot(tgtAxis) < -0.9, '左肘局部 X 轴应相反');
});

console.log('4) 根的转向连续，两种模式都成立');
const arm = new ClipSampler(createArmTurnClip());
check('中段 150° 转身在目标上复现，根 yaw 与源一致', () => {
  retargetAndApply(arm.sample(1.7, source), 'keep');
  const sy = (worldYaw(source) * 180) / Math.PI;
  const ty = (worldYaw(target) * 180) / Math.PI;
  assert.ok(Math.abs(sy - 150) < 1e-6, `源 yaw=${sy}`);
  assert.ok(Math.abs(ty - 150) < 1e-6, `目标 yaw=${ty}`);
});

check('height / keep 两种模式下根旋转一致且连续（逐帧无跳变）', () => {
  for (const mode of ['height', 'keep'] as RootMotionMode[]) {
    let prevYaw: number | null = null;
    for (let t = 0; t <= arm.duration + 1e-6; t += 0.1) {
      retargetAndApply(arm.sample(t, source), mode);
      const yaw = worldYaw(target);
      if (prevYaw !== null) {
        let d = yaw - prevYaw;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        assert.ok(Math.abs(d) < 0.55, `${mode} 模式 t=${t.toFixed(1)} 根旋转不连续`);
      }
      prevYaw = yaw;
    }
  }
});

console.log('5) 根位移：身高换算 / 保持原位，且拖时间条不累计');
check('keep 模式目标根始终在静止原点', () => {
  for (const t of [0, 0.6, 1.3, 2.7, 3.6]) {
    const out = retargetAndApply(squat.sample(t, source), 'keep');
    assert.ok(
      new Vector3(...out.rootPos).distanceTo(target.restWorldPos[0]) < 1e-10,
      `t=${t} 根离开了静止原点`,
    );
  }
});

check('height 模式位移按身高比 1.5 缩放', () => {
  const out = retargetAndApply(squat.sample(3.6, source), 'height');
  const expected = target.restWorldPos[0].clone();
  expected.z += 1.4 * (target.height / source.height);
  assert.ok(new Vector3(...out.rootPos).distanceTo(expected) < 1e-9);
  assert.ok(Math.abs(target.height / source.height - 1.5) < 1e-9);
});

check('同一时间点反复采样结果完全相同（无累计漂移）', () => {
  const f1 = retargetAndApply(squat.sample(2.0, source), 'height');
  for (let k = 0; k < 5; k++) {
    const f2 = retargetAndApply(squat.sample(2.0, source), 'height');
    assert.deepEqual(f2.rootPos, f1.rootPos);
    assert.deepEqual(f2.rootRot, f1.rootRot);
  }
});

console.log('6) 起始姿势、中段转身、末帧可复现');
check('片段首帧 = 各自静止姿势（目标回到自己的静止局部旋转）', () => {
  retargetAndApply(arm.sample(0, source), 'height');
  for (let i = 0; i < target.count; i++) {
    assert.ok(
      target.localRot[i].angleTo(target.restLocalRot[i]) < 1e-9,
      `${target.jointNames[i]} 首帧未保持静止`,
    );
  }
  // 根回到静止原点后，所有世界位置应与静止世界位置一致
  target.update();
  for (let i = 0; i < target.count; i++) {
    assert.ok(
      target.worldPos[i].distanceTo(target.restWorldPos[i]) < 1e-9,
      `${target.jointNames[i]} 首帧位置偏离静止姿势`,
    );
  }
});

check('抬臂片段末帧回到静止（朝向与位置）', () => {
  retargetAndApply(arm.sample(arm.duration, source), 'height');
  assert.ok(Math.abs(worldYaw(target)) < 1e-9);
  for (let i = 0; i < target.count; i++) {
    assert.ok(target.localRot[i].angleTo(target.restLocalRot[i]) < 1e-9);
  }
});

check('蹲起片段末帧：站直、根停在前进终点', () => {
  const out = retargetAndApply(squat.sample(squat.duration, source), 'height');
  for (const name of ['lknee', 'rknee', 'lhip', 'rhip']) {
    assert.ok(worldBendAngle(target, name) < 1e-6, `${name} 末帧未伸直`);
  }
  const dz = new Vector3(...out.rootPos).sub(target.restWorldPos[0]).z;
  assert.ok(Math.abs(dz - 1.4 * 1.5) < 1e-9);
});

console.log('7) 对应关系校验：缺失、重复时指出具体关节，其余仍可预览');
check('缺失目标与重复配置都被指出，且可用对应继续工作', () => {
  const bad: JointMapping = { ...mapping };
  delete bad.lelbow; // 源左肘找不到目标
  bad.lshoulder = 'lknee'; // 两个源关节同时配到 lknee，制造重复
  bad.rshoulder = 'lknee';
  const { usable, issues } = validateMapping(source, target, bad);
  const kinds = issues.map((i) => i.kind);
  assert.ok(kinds.includes('missing'), '应报缺失');
  assert.ok(kinds.includes('duplicate'), '应报重复');
  const missing = issues.find((i) => i.kind === 'missing');
  assert.equal(missing?.source, 'lelbow');
  const dup = issues.find((i) => i.kind === 'duplicate');
  assert.equal(dup?.target, 'lknee');
  assert.ok(dup?.sources?.includes('lshoulder') && dup.sources.includes('rshoulder'));
  // 其余对应仍可驱动目标：右膝在左/右肩对应失效的链路之外，应继续正常弯曲
  retargetAndApply(squat.sample(0.6, source), 'keep', usable);
  assert.ok(worldBendAngle(target, 'rknee') > 60, '右膝对应未受影响应继续弯曲');
  assert.ok(worldBendAngle(target, 'lknee') < 1e-9, 'lknee 对应冲突应保持静止');
  // 左肘没有对应：自身局部旋转必须是静止增量（父链异常也不影响这个判定）
  const li = target.jointIndex('lelbow');
  assert.ok(
    target.localRot[li].angleTo(target.restLocalRot[li]) < 1e-9,
    '左肘无对应应保持静止局部旋转',
  );
});

check('目标关节不存在时报 unknown-target', () => {
  const bad = { ...mapping, head: 'no-such-joint' };
  const { issues } = validateMapping(source, target, bad);
  assert.ok(issues.some((i) => i.kind === 'unknown-target' && i.source === 'head'));
});

check('对应关系可序列化并还原', () => {
  const restored = parseMapping(serializeMapping(mapping));
  assert.deepEqual(restored, mapping);
});

console.log('8) 导出动作数据并重新打开复现');
check('导出 -> 落盘 -> 读回：起始/中段/末帧姿势一致', () => {
  const frames: PoseFrame[] = [];
  for (let t = 0; t <= arm.duration + 1e-6; t += 0.1) frames.push(arm.sample(t, source));
  const data = buildRetargetedMotion(
    source,
    target,
    mapping,
    arm.clip.id,
    arm.clip.name,
    frames,
    'height',
    10,
  );
  const file = join(tmpdir(), `retarget-${Date.now()}.json`);
  writeFileSync(file, serializeMotion(data));
  try {
    const restored = parseMotion(readFileSync(file, 'utf8'));
    assert.equal(restored.frames.length, frames.length);
    const again = framesFromMotion(restored);
    const probe = [0, Math.floor(again.length / 2), again.length - 1];
    for (const idx of probe) {
      const expected = retargetAndApply(frames[idx], 'height');
      target.applyFrame(again[idx]);
      assert.ok(
        new Vector3(...again[idx].rootPos).distanceTo(new Vector3(...expected.rootPos)) < 1e-9,
      );
      assert.ok(
        new Quaternion(...again[idx].rootRot).angleTo(new Quaternion(...expected.rootRot)) < 1e-9,
      );
      for (const jn of Object.keys(expected.locals)) {
        assert.ok(
          new Quaternion(...again[idx].locals[jn]).angleTo(
            new Quaternion(...expected.locals[jn]),
          ) < 1e-9,
          `${jn} 导出前后姿势不一致`,
        );
      }
    }
    // 中段必须保留转身
    const mid = again[Math.floor(again.length / 2)];
    target.applyFrame(mid);
    const midYaw = Math.abs((worldYaw(target) * 180) / Math.PI);
    assert.ok(midYaw > 100, `中段转身丢失，yaw=${midYaw.toFixed(1)}°`);
  } finally {
    rmSync(file, { force: true });
  }
});

check('非法格式文件被拒绝', () => {
  assert.throws(() => parseMotion(JSON.stringify({ format: 'other', frames: [] })));
  assert.throws(() => parseMotion(JSON.stringify({ format: 'paper-puppet-retarget/1', frames: [] })));
});

console.log('');
if (process.exitCode === 1) {
  console.error(`验证失败（已通过 ${passed} 项）`);
} else {
  console.log(`全部通过：${passed} 项检查 ✓`);
}
