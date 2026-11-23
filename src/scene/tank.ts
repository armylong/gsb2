import * as THREE from 'three';
import { BLOCKS, FRAME_BARS, PLANES, TANK, type V3 } from '../physics/geometry';
import { createBackRulerMesh, createFrontRulerMesh } from './rulerTexture';

export interface SceneGroups {
  root: THREE.Group;
  rulerGroup: THREE.Group;
  blockGroup: THREE.Group;
  frameGroup: THREE.Group;
  glassGroup: THREE.Group;
}

const toV3 = (p: V3): THREE.Vector3 => new THREE.Vector3(p.x, p.y, p.z);

function pane(name: string, w: number, h: number, depth: number, pos: THREE.Vector3, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, depth), mat);
  m.name = name;
  m.position.copy(pos);
  const edge = new THREE.LineSegments(
    new THREE.EdgesGeometry(m.geometry),
    new THREE.LineBasicMaterial({ color: 0x9ad7ff, transparent: true, opacity: 0.55 }),
  );
  m.add(edge);
  return m;
}

export function buildTank(scene: THREE.Scene): SceneGroups {
  const root = new THREE.Group();
  root.name = '水槽';
  scene.add(root);

  const hx = TANK.innerHalf.x;
  const hy = TANK.innerHalf.y;
  const hz = TANK.innerHalf.z;

  // ---- 玻璃（四壁；槽底由不透明框/底板承担） ----
  const glassGroup = new THREE.Group();
  glassGroup.name = '玻璃';
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0xbfe9ff,
    transparent: true,
    opacity: 0.16,
    roughness: 0.05,
    metalness: 0,
    transmission: 0.35,
    ior: 1.5,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const gz = TANK.glass;
  glassGroup.add(pane('前玻璃', hx * 2, hy, gz, new THREE.Vector3(0, hy / 2, PLANES.frontOuter - gz / 2), glassMat));
  glassGroup.add(pane('后玻璃', hx * 2, hy, gz, new THREE.Vector3(0, hy / 2, PLANES.backOuter + gz / 2), glassMat));
  // 侧壁旋转 90°
  const right = pane('右玻璃', hz * 2, hy, gz, new THREE.Vector3(PLANES.rightOuter - gz / 2, hy / 2, 0), glassMat);
  right.rotation.y = Math.PI / 2;
  const left = pane('左玻璃', hz * 2, hy, gz, new THREE.Vector3(PLANES.leftOuter + gz / 2, hy / 2, 0), glassMat);
  left.rotation.y = Math.PI / 2;
  glassGroup.add(right, left);
  root.add(glassGroup);

  // ---- 水体（内腔水下部分，半透明蓝色） ----
  const waterH = PLANES.waterY;
  const waterMat = new THREE.MeshPhysicalMaterial({
    color: 0x2f8fd0,
    transparent: true,
    opacity: 0.22,
    roughness: 0.15,
    metalness: 0,
    transmission: 0.25,
    ior: 1.333,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const water = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, waterH, hz * 2), waterMat);
  water.name = '水体';
  water.position.set(0, waterH / 2, 0);
  root.add(water);

  // 水面高亮线
  const surf = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(hx * 2, 0.08, hz * 2)),
    new THREE.LineBasicMaterial({ color: 0x7fd4ff, transparent: true, opacity: 0.8 }),
  );
  surf.position.set(0, PLANES.waterY, 0);
  root.add(surf);

  // ---- 不透明槽框 ----
  const frameGroup = new THREE.Group();
  frameGroup.name = '槽框';
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x37475c, roughness: 0.6, metalness: 0.35 });
  for (const bar of FRAME_BARS) {
    const sx = bar.max.x - bar.min.x;
    const sy = bar.max.y - bar.min.y;
    const sz = bar.max.z - bar.min.z;
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), frameMat);
    m.name = bar.name;
    m.position.set((bar.min.x + bar.max.x) / 2, (bar.min.y + bar.max.y) / 2, (bar.min.z + bar.max.z) / 2);
    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(m.geometry),
      new THREE.LineBasicMaterial({ color: 0x6b829e, transparent: true, opacity: 0.6 }),
    );
    m.add(edge);
    frameGroup.add(m);
  }
  root.add(frameGroup);

  // ---- 标尺 ----
  const rulerGroup = new THREE.Group();
  rulerGroup.name = '标尺';
  rulerGroup.add(createBackRulerMesh(), createFrontRulerMesh());
  root.add(rulerGroup);

  // ---- 水中方块 ----
  const blockGroup = new THREE.Group();
  blockGroup.name = '方块';
  for (const b of BLOCKS) {
    const sx = b.max.x - b.min.x;
    const sy = b.max.y - b.min.y;
    const sz = b.max.z - b.min.z;
    const mat = new THREE.MeshStandardMaterial({ color: b.color, roughness: 0.55, metalness: 0.05 });
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
    m.name = b.name;
    m.position.set((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(m.geometry),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 }),
    );
    m.add(edge);
    blockGroup.add(m);
  }
  root.add(blockGroup);

  // ---- 地面网格与参考轴 ----
  const grid = new THREE.GridHelper(90, 18, 0x2a4a6b, 0x1a2c44);
  grid.position.y = -2.02;
  scene.add(grid);
  const axes = new THREE.AxesHelper(6);
  axes.position.set(-hx - 4, 0, hz + 4);
  scene.add(axes);

  // ---- 灯光 ----
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 1.1);
  key.position.set(30, 45, 35);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x88bbff, 0.45);
  fill.position.set(-30, 20, -25);
  scene.add(fill);

  // 背景
  scene.background = new THREE.Color(0x0d1420);
  scene.fog = new THREE.Fog(0x0d1420, 130, 240);

  return { root, rulerGroup, blockGroup, frameGroup, glassGroup };
}

export { toV3 };
