import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PerspectiveCamera, Vector3 } from 'three';
import { classifySphere, updateFrustum, PLANE_NAMES } from '../src/culling/frustum';
import {
  buildSampleScene,
  updateWorldBounds,
  SampleScene,
  SCENE_SEED,
} from '../src/scene/sampleScene';
import {
  TOTAL_FRAMES,
  applyCameraPath,
  applyObjectPath,
  cameraPathAt,
} from '../src/scene/fixedPath';
import {
  RawStatus,
  boxStatus,
  extractFrustum,
  sphereStatus,
  viewProjectionOf,
} from './independentFrustum';

const here = dirname(fileURLToPath(import.meta.url));
const baselinePath = resolve(here, 'baseline.json');
const updateMode = process.argv.includes('--update');

interface Assertion {
  name: string;
  pass: boolean;
  detail: string;
}

interface HeadlessFrame {
  frame: number;
  perMeshDrawn: number;
  perGroupDrawn: number;
  skippedByGroup: number;
  groupStatus: Record<string, RawStatus>;
  perMeshMask: number[];
  perGroupMask: number[];
}

interface HeadlessReport {
  schemaVersion: 1;
  seed: number;
  totalFrames: number;
  generatedBy: 'headless';
  totals: {
    perMeshDrawn: number;
    perGroupDrawn: number;
    mismatchFrames: number;
    boundaryCrossingFrames: number;
  };
  frames: HeadlessFrame[];
}

const assertions: Assertion[] = [];
function check(name: string, pass: boolean, detail: string): void {
  assertions.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
}

const aspect = 16 / 9;
const camera = new PerspectiveCamera(52, aspect, 0.5, 40);
const lookTarget = new Vector3(0, 0, -16);

interface RichFrame extends HeadlessFrame {
  independentMismatches: number;
  boxSphereMismatches: number;
}

function runFrame(scene: SampleScene, frameIndex: number): RichFrame {
  applyObjectPath(scene, frameIndex);
  applyCameraPath(camera, lookTarget, frameIndex);
  camera.lookAt(lookTarget);
  camera.updateMatrixWorld(true);
  updateWorldBounds(scene);

  // 实现 A：产品代码（THREE.Frustum 路线）。
  const productFrustum = updateFrustum(camera);
  // 实现 B：独立提取的 Gribb-Hartmann 视锥。
  const independent = extractFrustum(viewProjectionOf(camera));

  const perMeshMask: number[] = [];
  const perGroupMask: number[] = [];
  const groupStatus: Record<string, RawStatus> = {};
  let perMeshDrawn = 0;
  let perGroupDrawn = 0;
  let skippedByGroup = 0;
  let independentMismatches = 0;
  let boxSphereMismatches = 0;

  for (const groupEntity of scene.groups) {
    const groupProduct = classifySphere(productFrustum, groupEntity.worldSphere);
    const groupIndependent = sphereStatus(
      independent,
      groupEntity.worldSphere.center,
      groupEntity.worldSphere.radius,
    );
    if (groupProduct.status !== groupIndependent) independentMismatches++;
    const groupBox = boxStatus(
      independent,
      groupEntity.worldBox.min,
      groupEntity.worldBox.max,
    );
    // 盒与球对同一实体不应出现 in/out 这种互斥分歧（允许与 intersect 互相差异）。
    if (
      (groupProduct.status === 'in' && groupBox === 'out') ||
      (groupProduct.status === 'out' && groupBox === 'in')
    ) {
      boxSphereMismatches++;
    }
    groupStatus[groupEntity.id] = groupProduct.status;

    for (const member of groupEntity.members) {
      const meshProduct = classifySphere(productFrustum, member.worldSphere);
      const meshIndependent = sphereStatus(
        independent,
        member.worldSphere.center,
        member.worldSphere.radius,
      );
      if (meshProduct.status !== meshIndependent) independentMismatches++;
      const meshBox = boxStatus(independent, member.worldBox.min, member.worldBox.max);
      if (
        (meshProduct.status === 'in' && meshBox === 'out') ||
        (meshProduct.status === 'out' && meshBox === 'in')
      ) {
        boxSphereMismatches++;
      }

      const perMeshVisible = meshProduct.status !== 'out';
      let groupDrawn: boolean;
      if (groupProduct.status === 'out') {
        groupDrawn = false;
        skippedByGroup++;
      } else if (groupProduct.status === 'in') {
        groupDrawn = true;
      } else {
        // 组局部可见：子对象必须逐个再筛，不能整组照单全收。
        groupDrawn = perMeshVisible;
      }

      if (perMeshVisible) perMeshDrawn++;
      if (groupDrawn) perGroupDrawn++;
      perMeshMask.push(perMeshVisible ? 1 : 0);
      perGroupMask.push(groupDrawn ? 1 : 0);
    }
  }

  return {
    frame: frameIndex,
    perMeshDrawn,
    perGroupDrawn,
    skippedByGroup,
    groupStatus,
    perMeshMask,
    perGroupMask,
    independentMismatches,
    boxSphereMismatches,
  };
}

function runAll(): { report: HeadlessReport; independentTotal: number; boxSphereTotal: number } {
  const scene = buildSampleScene(SCENE_SEED);
  const frames: HeadlessFrame[] = [];
  let independentTotal = 0;
  let boxSphereTotal = 0;
  for (let f = 0; f < TOTAL_FRAMES; f++) {
    const rich = runFrame(scene, f);
    independentTotal += rich.independentMismatches;
    boxSphereTotal += rich.boxSphereMismatches;
    frames.push({
      frame: rich.frame,
      perMeshDrawn: rich.perMeshDrawn,
      perGroupDrawn: rich.perGroupDrawn,
      skippedByGroup: rich.skippedByGroup,
      groupStatus: rich.groupStatus,
      perMeshMask: rich.perMeshMask,
      perGroupMask: rich.perGroupMask,
    });
  }
  const totals = {
    perMeshDrawn: frames.reduce((s, f) => s + f.perMeshDrawn, 0),
    perGroupDrawn: frames.reduce((s, f) => s + f.perGroupDrawn, 0),
    mismatchFrames: frames.filter((f) => f.perMeshDrawn !== f.perGroupDrawn).length,
    boundaryCrossingFrames: frames.filter((f) =>
      Object.values(f.groupStatus).includes('intersect'),
    ).length,
  };
  return {
    report: {
      schemaVersion: 1,
      seed: SCENE_SEED,
      totalFrames: TOTAL_FRAMES,
      generatedBy: 'headless',
      totals,
      frames,
    },
    independentTotal,
    boxSphereTotal,
  };
}

/**
 * 边界抖动测试：把每个「边界交叉」的成员沿最近视锥面的法线双向微位移，
 * 验证包围体重算后判定连续变化、不会漏画刚跨进视锥的对象。
 * 位移加在成员所在组上（世界空间平移），避免组带旋转时局部坐标与世界法线方向不一致。
 */
function boundaryJitterTest(): { checked: number; leaks: number } {
  const scene = buildSampleScene(SCENE_SEED);
  let checked = 0;
  let leaks = 0;
  const probeFrames = [12, 37, 63, 91, 124, 157];
  for (const f of probeFrames) {
    applyObjectPath(scene, f);
    applyCameraPath(camera, lookTarget, f);
    camera.lookAt(lookTarget);
    camera.updateMatrixWorld(true);
    updateWorldBounds(scene);
    const frustum = updateFrustum(camera);

    for (const member of scene.meshes) {
      const before = classifySphere(frustum, member.worldSphere);
      if (before.status !== 'intersect') continue;
      const owner = scene.groups.find((g) => g.members.includes(member));
      if (!owner) continue;
      checked++;

      // 取离球心最近的视锥面：交叉意味着 |distance| < radius。
      let bestPlane = frustum.planes[0];
      let bestDistance = Infinity;
      for (const plane of frustum.planes) {
        const d = plane.distanceToPoint(member.worldSphere.center);
        if (Math.abs(d) < Math.abs(bestDistance)) {
          bestDistance = d;
          bestPlane = plane;
        }
      }
      const r = member.worldSphere.radius;
      const savedPosition = owner.group.position.clone();

      // 向内推（沿法线）到该面距离为正：对面必须不再把它判成 out。
      const inward = r - bestDistance + 0.05;
      owner.group.position.addScaledVector(bestPlane.normal, inward);
      updateWorldBounds(scene);
      const distanceIn = bestPlane.distanceToPoint(member.worldSphere.center);
      if (classifySphere(frustum, member.worldSphere).status === 'out' || distanceIn <= 0) {
        leaks++;
      }

      // 向外推到该面距离 < -r：该面必定拒绝，整个球必须判 out（不能误留）。
      const outward = bestDistance + r + 0.1;
      owner.group.position.addScaledVector(bestPlane.normal, -inward - outward);
      updateWorldBounds(scene);
      const afterOut = classifySphere(frustum, member.worldSphere);
      if (afterOut.status !== 'out' || afterOut.rejectedBy !== PLANE_NAMES[frustum.planes.indexOf(bestPlane)]) {
        leaks++;
      }

      owner.group.position.copy(savedPosition);
      updateWorldBounds(scene);
    }
  }
  return { checked, leaks };
}

/** 近/远平面专项：near 拉大、far 缩短，确认 near/far 拒绝原因生效。 */
function depthPlaneTest(): Assertion {
  const scene = buildSampleScene(SCENE_SEED);
  applyObjectPath(scene, 0);
  camera.position.set(0, 0, 0);
  lookTarget.set(0, 0, -16);
  camera.fov = 52;
  camera.near = 13;
  camera.far = 15;
  camera.lookAt(lookTarget);
  camera.updateMatrixWorld(true);
  updateWorldBounds(scene);
  const frustum = updateFrustum(camera);
  const reasons = new Set<string>();
  for (const member of scene.meshes) {
    const result = classifySphere(frustum, member.worldSphere);
    if (result.status === 'out' && result.rejectedBy) reasons.add(result.rejectedBy);
  }
  const pass = reasons.has('near') || reasons.has('far');
  return {
    name: '深度裁剪：收紧 near/far 后出现 near/far 拒绝',
    pass,
    detail: `实际拒绝面集合=[${[...reasons].join(', ')}]`,
  };
}

function main(): void {
  console.log(`\n== 视锥剔除无头验证（seed=${SCENE_SEED}, frames=${TOTAL_FRAMES}）==\n`);
  const { report, independentTotal, boxSphereTotal } = runAll();

  check(
    '固定路径覆盖了组级边界交叉帧',
    report.totals.boundaryCrossingFrames > 0,
    `${report.totals.boundaryCrossingFrames}/${TOTAL_FRAMES} 帧存在 intersect 组`,
  );
  check(
    '逐物件与按组的总提交数一致（下钻保证不漏不重）',
    report.totals.perMeshDrawn === report.totals.perGroupDrawn,
    `perMesh=${report.totals.perMeshDrawn}, perGroup=${report.totals.perGroupDrawn}`,
  );
  check(
    '每帧逐物件/按组提交数都相等',
    report.totals.mismatchFrames === 0,
    `${report.totals.mismatchFrames} 帧不一致`,
  );
  check(
    '按组策略确实有整组 out 跳过发生',
    report.frames.some((f) => f.skippedByGroup > 0),
    `累计跳过 ${report.frames.reduce((s, f) => s + f.skippedByGroup, 0)} 个子对象判定`,
  );
  check(
    '两套独立视锥数学结论完全一致（THREE.Frustum vs Gribb-Hartmann）',
    independentTotal === 0,
    `${independentTotal} 处分歧`,
  );
  check(
    '球判定与盒判定没有 in/out 互斥分歧',
    boxSphereTotal === 0,
    `${boxSphereTotal} 处互斥分歧`,
  );
  check(
    '存在被剔除帧（镜头外摆件确实不提交）',
    report.frames.some((f) => f.perMeshDrawn < f.perMeshMask.length),
    `峰值提交 ${Math.max(...report.frames.map((f) => f.perMeshDrawn))}/${sceneMeshCount()}`,
  );

  const jitter = boundaryJitterTest();
  check(
    '边界抖动：跨进视锥不漏画、跨出视锥不误留',
    jitter.leaks === 0 && jitter.checked > 0,
    `检查 ${jitter.checked} 个交叉实体，${jitter.leaks} 处漏/误`,
  );

  assertions.push(depthPlaneTest());

  // 基线对照（要求 5：可复现对照）。
  if (updateMode || !existsSync(baselinePath)) {
    mkdirSync(dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, JSON.stringify(report, null, 2) + '\n');
    console.log(`\n基线已写入 ${baselinePath}`);
  } else {
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as HeadlessReport;
    const same = JSON.stringify(baseline) === JSON.stringify(report);
    check(
      '与已保存基线逐字节一致（可复现对照）',
      same,
      same ? 'baseline.json 完全匹配' : '存在差异，可用 npm run verify:update 复核后更新',
    );
  }

  const failed = assertions.filter((a) => !a.pass);
  console.log(`\n== 结果：${assertions.length - failed.length}/${assertions.length} 通过 ==\n`);
  if (failed.length > 0) process.exitCode = 1;
}

function sceneMeshCount(): number {
  return buildSampleScene(SCENE_SEED).meshes.length;
}

// 固定路径里的相机参数也做一次确定性自检。
const p0 = cameraPathAt(0);
const pMid = cameraPathAt(90);
check(
  '固定路径本身确定性（同帧参数稳定）',
  JSON.stringify(cameraPathAt(42)) === JSON.stringify(cameraPathAt(42)) &&
    JSON.stringify(p0) !== JSON.stringify(pMid),
  'frame 42 两次取值相等且与 frame 90 不同',
);

main();
