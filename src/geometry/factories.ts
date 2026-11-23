/**
 * 代码生成的零件几何
 *
 * 所有零件都以「装配位置下的局部原点」为基准建模:
 * - 外壳节点在地板中心; 盖板节点在板件中心(铰链轴高度); 支架节点在板件中心
 * - 螺钉/垫片以贴合面为原点, 头部朝 +Y、螺杆朝 -Y, 即「装配方向」就是局部 +Y
 *   父组件被平移后, 局部坐标轴跟随, 螺钉依旧沿自己的装配方向抽出
 */
import * as THREE from 'three';
import { PART_IDS } from '../preset';
import { addEdges, type MaterialTable } from './materials';

type Factory = (m: MaterialTable) => THREE.Object3D;

/** 硬边零件统一走 box + 描边 */
function makeBox(w: number, h: number, d: number, material: THREE.Material, edges = true): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  if (edges) addEdges(mesh);
  return mesh;
}

/** 圆柱, 默认轴沿 Y; axis='x' 时转到 X 轴(铰链件用) */
function makeCylinder(
  radiusTop: number,
  radiusBottom: number,
  height: number,
  segments: number,
  material: THREE.Material,
  axis: 'x' | 'y' = 'y',
): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments),
    material,
  );
  if (axis === 'x') mesh.rotation.z = Math.PI / 2;
  addEdges(mesh, 0x1f2d3a, 0.25);
  return mesh;
}

// ---------------------------------------------------------------- 外壳
const buildHousing: Factory = (m) => {
  const g = new THREE.Group();

  // 地板与四面围壁, 形成上方开口的盒体
  const floor = makeBox(6, 0.25, 4, m.housing);
  floor.position.set(0, 0.125, 0);
  g.add(floor);

  const wallH = 2.8;
  const wallY = 0.25 + wallH / 2;
  const front = makeBox(6, wallH, 0.25, m.housing);
  front.position.set(0, wallY, 1.875);
  const back = makeBox(6, wallH, 0.25, m.housing);
  back.position.set(0, wallY, -1.875);
  const left = makeBox(0.25, wallH, 4, m.housing);
  left.position.set(-2.875, wallY, 0);
  const right = makeBox(0.25, wallH, 4, m.housing);
  right.position.set(2.875, wallY, 0);
  g.add(front, back, left, right);

  // 前面板上的仪表显示窗
  const screen = makeBox(4.2, 1.4, 0.06, m.screen, false);
  screen.position.set(0, 1.7, 2.03);
  g.add(screen);

  // 内部两个螺钉柱(B 组螺杆拧入这里)
  for (const x of [-1.4, 1.4]) {
    const boss = makeCylinder(0.35, 0.35, 0.5, 24, m.housingDark);
    boss.position.set(x, 0.45, 0);
    g.add(boss);
  }

  // 背部两个铰链耳片(轴沿 X)
  for (const x of [-1.7, 1.7]) {
    const lug = makeCylinder(0.35, 0.35, 1.0, 24, m.housingDark, 'x');
    lug.position.set(x, 3.125, -2);
    g.add(lug);
  }
  return g;
};

// ---------------------------------------------------------------- 盖板组件
const buildCover: Factory = (m) => {
  const g = new THREE.Group();

  const plate = makeBox(6.4, 0.25, 4.2, m.cover);
  g.add(plate);

  // 顶面观察窗(半透明玻璃)
  const glass = makeBox(4.4, 0.06, 2.6, m.glass, false);
  glass.position.set(0, 0.155, 0.1);
  g.add(glass);

  // 底面四条限位裙边
  const skirtMat = m.coverDark;
  const skirtFront = makeBox(5.9, 0.18, 0.12, skirtMat, false);
  skirtFront.position.set(0, -0.2, 1.95);
  const skirtBack = makeBox(5.9, 0.18, 0.12, skirtMat, false);
  skirtBack.position.set(0, -0.2, -1.95);
  const skirtL = makeBox(0.12, 0.18, 3.7, skirtMat, false);
  skirtL.position.set(-3.0, -0.2, 0);
  const skirtR = skirtL.clone();
  skirtR.position.x = 3.0;
  g.add(skirtFront, skirtBack, skirtL, skirtR);

  // 中央铰链耳, 与外壳两个耳片同轴穿插
  const ear = makeCylinder(0.3, 0.3, 1.6, 24, m.coverDark, 'x');
  ear.position.set(0, 0, -2);
  g.add(ear);
  return g;
};

// ---------------------------------------------------------------- 铰链销轴
const buildHingePin: Factory = (m) => {
  const g = new THREE.Group();
  const pin = makeCylinder(0.16, 0.16, 5.2, 24, m.steel, 'x');
  g.add(pin);
  // 右端的限位大头, 抽出方向是 -X, 大头留在右侧便于辨认朝向
  const head = makeCylinder(0.28, 0.28, 0.22, 24, m.steel, 'x');
  head.position.x = 2.7;
  g.add(head);
  return g;
};

// ---------------------------------------------------------------- 垫片
const buildWasher: Factory = (m) => {
  const g = new THREE.Group();
  const ring = makeCylinder(0.42, 0.42, 0.08, 32, m.washer);
  ring.position.y = 0.04;
  const hole = makeCylinder(0.14, 0.14, 0.09, 24, m.slot, 'y');
  hole.position.y = 0.045;
  g.add(ring, hole);
  return g;
};

// ---------------------------------------------------------------- 螺钉(六角头 + 螺杆)
const buildScrew: Factory = (m) => {
  const g = new THREE.Group();
  // 六角头, 顶面开一字槽, 用来直观显示螺钉朝向
  const head = makeCylinder(0.3, 0.3, 0.22, 6, m.steel);
  head.position.y = 0.11;
  const slot = makeBox(0.36, 0.03, 0.1, m.slot, false);
  slot.position.y = 0.225;
  // 螺杆朝下(-Y)拧入母体
  const shaft = makeCylinder(0.11, 0.11, 1.1, 20, m.steel);
  shaft.position.y = -0.33;
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.16, 20), m.steel);
  tip.rotation.x = Math.PI;
  tip.position.y = -0.96;
  addEdges(tip, 0x1f2d3a, 0.25);
  g.add(head, slot, shaft, tip);
  return g;
};

// ---------------------------------------------------------------- 内支架
const buildBracket: Factory = (m) => {
  const g = new THREE.Group();
  const plate = makeBox(4.6, 0.24, 2.6, m.bracket);
  g.add(plate);
  // 两侧安装脚, 落在外壳地板上
  for (const x of [-2.21, 2.21]) {
    const foot = makeBox(0.18, 0.28, 2.6, m.bracket);
    foot.position.set(x, -0.26, 0);
    g.add(foot);
  }
  // 板上两个过孔的深色标记
  for (const x of [-1.4, 1.4]) {
    const mark = makeCylinder(0.16, 0.16, 0.02, 24, m.slot);
    mark.position.set(x, 0.125, 0);
    g.add(mark);
  }
  return g;
};

const FACTORIES: Record<string, Factory> = {
  [PART_IDS.housing]: buildHousing,
  [PART_IDS.cover]: buildCover,
  [PART_IDS.hingePin]: buildHingePin,
  [PART_IDS.bracket]: buildBracket,
};

/** 螺钉与垫片共用同型几何, 按 id 前缀分发 */
export function createPartGeometry(partId: string, materials: MaterialTable): THREE.Object3D {
  if (FACTORIES[partId]) return FACTORIES[partId](materials);
  if (partId.includes('Screw')) return buildScrew(materials);
  if (partId.includes('Washer')) return buildWasher(materials);
  throw new Error(`没有为零件 ${partId} 注册几何工厂`);
}
