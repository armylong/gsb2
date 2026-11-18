import * as THREE from 'three';
import type { SceneObject } from './types';
import type { OutlinePipeline } from './outline';
import { applyLayout, VERIFY_CAMERA, type CameraPreset } from './layouts';
import {
  colorDistance,
  nearestColorInRing,
  sampleComposite,
  sampleId,
  sampleIdDepth,
  sampleSceneDepth,
  srgbColor,
  type FrameSnapshot,
} from './snapshot';

interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

const DEPTH_EPS = 0.02;
const COLOR_TOL = 70; // sRGB 欧氏距离，容纳抗锯齿与 alpha 混合

function applyCamera(camera: THREE.PerspectiveCamera, preset: CameraPreset): void {
  camera.position.set(...preset.position);
  camera.lookAt(new THREE.Vector3(...preset.target));
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}

/** 世界坐标 -> 设备像素坐标。 */
function project(
  world: THREE.Vector3,
  camera: THREE.PerspectiveCamera,
  widthCss: number,
  heightCss: number,
  dpr: number,
): { x: number; y: number } {
  const v = world.clone().project(camera);
  return {
    x: ((v.x + 1) / 2) * widthCss * dpr,
    y: ((1 - v.y) / 2) * heightCss * dpr,
  };
}

function centerOf(obj: SceneObject): THREE.Vector3 {
  return new THREE.Box3().setFromObject(obj.group).getCenter(new THREE.Vector3());
}

export interface VerifyDeps {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  pipeline: OutlinePipeline;
  objects: SceneObject[];
  occluder: THREE.Mesh;
  widthCss: number;
  heightCss: number;
  dpr: number;
  selectedIds: number[];
  lineWidthCss: number;
}

/**
 * 固定机位验证。所有检查在 occlusion 布局的同一相机位姿下进行，结果可复现。
 * 每个场景只做一次整帧回读（capture*Snapshot），像素分析全部在 JS 中完成。
 * 边缘误差容忍：画面短边 3%（约数像素至十几像素）外扩搜索描边像素。
 */
export function runVerification(deps: VerifyDeps): string {
  const {
    scene,
    camera,
    pipeline,
    objects,
    occluder,
    widthCss,
    heightCss,
    dpr,
    selectedIds,
    lineWidthCss,
  } = deps;

  const results: CheckResult[] = [];
  const byId = new Map(objects.map((o) => [o.id, o]));
  const edgeTol = Math.round(Math.min(widthCss, heightCss) * 0.03 * dpr);

  // 统一进入可复现的验证状态（恢复全部对象的可见性与身份）
  applyLayout('occlusion', objects, occluder);
  for (const o of objects) {
    o.hidden = false;
    o.group.visible = true;
  }
  applyCamera(camera, VERIFY_CAMERA);

  // 快照 A：遮挡关系（ID + 场景深度）
  const snapA: FrameSnapshot = pipeline.captureOcclusionSnapshot(objects, scene, camera);
  // 快照 B：最终合成画面（全部 9 个对象都选中，保证轮廓齐全）
  const snapB: FrameSnapshot = pipeline.captureCompositeSnapshot(
    scene,
    camera,
    objects,
    'hidden',
    lineWidthCss,
    dpr,
  );

  // ---- 检查 1：挡板覆盖区，对象自身深度远于场景深度（被判定为遮挡）----
  {
    const target = byId.get(1)!; // 球体：挡板后方大半被覆盖
    const p = project(centerOf(target), camera, widthCss, heightCss, dpr);
    const id = sampleId(snapA, p.x, p.y);
    const idDepth = sampleIdDepth(snapA, p.x, p.y);
    const sceneDepth = sampleSceneDepth(snapA, p.x, p.y);
    const diff = idDepth - sceneDepth;
    results.push({
      name: '1. 挡板覆盖区：ID 深度 > 场景深度（判定为遮挡）',
      pass: id === target.id && diff > DEPTH_EPS,
      detail:
        `投影 (${p.x.toFixed(0)}, ${p.y.toFixed(0)})，id=${id}（期望 ${target.id}），` +
        `ID 深度=${idDepth.toFixed(4)}，场景深度=${sceneDepth.toFixed(4)}，差值=${diff.toFixed(4)}` +
        `（阈值 ${DEPTH_EPS}）`,
    });
  }

  // ---- 检查 2：完全隐藏对象（圆柱 id=3 在挡板正中）ID 存在、被遮挡、区域内无可见实线 ----
  {
    const hiddenObj = byId.get(3)!;
    const p = project(centerOf(hiddenObj), camera, widthCss, heightCss, dpr);
    const id = sampleId(snapA, p.x, p.y);
    const diff = sampleIdDepth(snapA, p.x, p.y) - sampleSceneDepth(snapA, p.x, p.y);
    // 在中心附近搜索该对象的可见本色实线；虚线用压暗色，不会与本色匹配
    const solidTarget = srgbColor(hiddenObj.color);
    const search = nearestColorInRing(snapB, p.x, p.y, edgeTol * 3, solidTarget);
    results.push({
      name: '2. 完全隐藏对象：ID 存在且被挡板遮挡，区域内无可见实线',
      pass: id === hiddenObj.id && diff > DEPTH_EPS && search.distance > COLOR_TOL,
      detail:
        `id=${id}（期望 ${hiddenObj.id}），深度差=${diff.toFixed(4)}；` +
        `中心 ${edgeTol * 3}px 内最近实线色距 ${search.distance.toFixed(1)}` +
        `（阈值 >${COLOR_TOL} 表示无实线）`,
    });
  }

  // ---- 检查 3：多子网格对象内部接缝不产生描边，外轮廓仍有描边 ----
  {
    const dumbbell = byId.get(9)!;
    const seamWorld = dumbbell.group.localToWorld(new THREE.Vector3(-0.425, 0, 0));
    const pSeam = project(seamWorld, camera, widthCss, heightCss, dpr);
    const pCenter = project(centerOf(dumbbell), camera, widthCss, heightCss, dpr);
    const outlineTarget = srgbColor(dumbbell.color);
    let minSeamDist = Infinity;
    for (let dx = -3; dx <= 3; dx++) {
      for (let dy = -3; dy <= 3; dy++) {
        minSeamDist = Math.min(
          minSeamDist,
          colorDistance(sampleComposite(snapB, pSeam.x + dx, pSeam.y + dy), outlineTarget),
        );
      }
    }
    const silhouette = nearestColorInRing(snapB, pCenter.x, pCenter.y, edgeTol * 4, outlineTarget);
    results.push({
      name: '3. 子网格组合：哑铃接缝无描边，外轮廓仍有描边',
      pass: minSeamDist > COLOR_TOL && silhouette.distance <= COLOR_TOL,
      detail:
        `接缝 7×7 区域与描边色最小距离 ${minSeamDist.toFixed(1)}（> ${COLOR_TOL} 为无描边）；` +
        `外轮廓对照色距 ${silhouette.distance.toFixed(1)}（≤ ${COLOR_TOL} 为检出）`,
    });
  }

  // ---- 检查 4：两个对象相接，两侧各自检出本身份定色描边 ----
  {
    applyLayout('touch', objects, occluder);
    applyCamera(camera, VERIFY_CAMERA);
    const snapTouch = pipeline.captureCompositeSnapshot(
      scene,
      camera,
      objects,
      'hidden',
      lineWidthCss,
      dpr,
    );
    const a = byId.get(7)!; // L 形
    const b = byId.get(8)!; // U 形，在 x=0.5 处相接
    const pa = project(centerOf(a), camera, widthCss, heightCss, dpr);
    const pb = project(centerOf(b), camera, widthCss, heightCss, dpr);
    const hitA = nearestColorInRing(snapTouch, pa.x, pa.y, edgeTol * 4, srgbColor(a.color));
    const hitB = nearestColorInRing(snapTouch, pb.x, pb.y, edgeTol * 4, srgbColor(b.color));
    results.push({
      name: '4. 两个选中对象相接：两侧各自检出身份色描边',
      pass: hitA.distance <= COLOR_TOL && hitB.distance <= COLOR_TOL,
      detail:
        `L 形色距 ${hitA.distance.toFixed(1)} @(${hitA.x.toFixed(0)},${hitA.y.toFixed(0)})；` +
        `U 形色距 ${hitB.distance.toFixed(1)} @(${hitB.x.toFixed(0)},${hitB.y.toFixed(0)})；` +
        `搜索半径 ${edgeTol * 4} 设备像素`,
    });
    applyLayout('occlusion', objects, occluder);
    applyCamera(camera, VERIFY_CAMERA);
  }

  // ---- 检查 5：隐藏对象不可点选（不写入 ID 缓冲，场景中也不渲染）----
  {
    const target = byId.get(5)!;
    const p = project(centerOf(target), camera, widthCss, heightCss, dpr);
    target.hidden = true;
    target.group.visible = false;
    const picked = pipeline.pick(p.x, p.y, objects, camera);
    target.hidden = false;
    target.group.visible = true;
    results.push({
      name: '5. 隐藏对象不可被点选（且不产生描边）',
      pass: picked !== target.id,
      detail: `对隐藏对象中心拾取，返回 id=${picked}（期望 != ${target.id}）`,
    });
  }

  const lines = results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n      ${r.detail}`);
  const passCount = results.filter((r) => r.pass).length;
  lines.unshift(
    `固定机位验证：${passCount}/${results.length} 通过｜机位 ` +
      `(${VERIFY_CAMERA.position.join(', ')}) 目标 (${VERIFY_CAMERA.target.join(', ')})｜` +
      `边缘误差容忍 ±${edgeTol} 设备像素（画面短边 3%），颜色容忍 sRGB 距离 ${COLOR_TOL}`,
  );
  lines.push(
    `当前选中：${selectedIds.length ? selectedIds.join(', ') : '无'}；` +
      `描边宽度 ${lineWidthCss} CSS px（dpr=${dpr}）`,
  );
  return lines.join('\n');
}
