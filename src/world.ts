import * as THREE from 'three';
import { MISSING_FRAME, PANELS, ROUTE_POINTS, getEdge } from './panels';
import type { PanelDef } from './types';

const PANEL_THICKNESS = 0.12;

function makeLabel(text: string, color: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(10,15,25,0.72)';
  ctx.roundRect(8, 18, 496, 92, 18);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.roundRect(8, 18, 496, 92, 18);
  ctx.stroke();
  ctx.font = 'bold 42px sans-serif';
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 256, 66);
  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(2.2, 0.55, 1);
  return sprite;
}

/** 一块矩形面板：薄盒，盒中心沿 -normal 下沉半个厚度，使 +normal 面正好贴在定义平面上 */
function panelMesh(panel: PanelDef): THREE.Mesh {
  const geo = new THREE.BoxGeometry(panel.halfU * 2, panel.halfV * 2, PANEL_THICKNESS);
  const material = new THREE.MeshStandardMaterial({
    color: panel.color,
    roughness: 0.55,
    metalness: 0.15,
    side: THREE.DoubleSide,
    transparent: !panel.stickable,
    opacity: panel.stickable ? 1 : 0.55,
  });
  const mesh = new THREE.Mesh(geo, material);
  // 局部 +Z 对齐到面板 normal，局部 X/Y 对齐 uAxis/vAxis
  const basis = new THREE.Matrix4().makeBasis(panel.uAxis, panel.vAxis, panel.normal);
  mesh.quaternion.setFromRotationMatrix(basis);
  mesh.position
    .copy(panel.center)
    .addScaledVector(panel.normal, -PANEL_THICKNESS / 2 - (panel.thicknessHalf ?? 0));
  mesh.name = panel.id;
  return mesh;
}

function addEdges(group: THREE.Group, panel: PanelDef) {
  const edges = [
    ['minU', 0x8fb8e6],
    ['maxU', 0x8fb8e6],
    ['minV', 0x8fb8e6],
    ['maxV', 0xffc857],
  ] as const;
  for (const [edgeId, color] of edges) {
    const seg = getEdge(panel, edgeId);
    const curve = new THREE.LineCurve3(seg.a, seg.b);
    const tube = new THREE.TubeGeometry(curve, 1, 0.035, 8, false);
    const mat = new THREE.MeshBasicMaterial({ color });
    group.add(new THREE.Mesh(tube, mat));
  }
}

function addBarrierStripes(panel: PanelDef): THREE.Group {
  const g = new THREE.Group();
  const stripeMat = new THREE.MeshBasicMaterial({ color: 0xffd166 });
  const count = 5;
  for (let i = 0; i < count; i++) {
    const v = -panel.halfV + ((i + 0.5) / count) * panel.halfV * 2;
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(panel.halfU * 1.9, 0.06, 0.02),
      stripeMat,
    );
    const basis = new THREE.Matrix4().makeBasis(panel.uAxis, panel.vAxis, panel.normal);
    stripe.quaternion.setFromRotationMatrix(basis);
    stripe.position
      .copy(panel.center)
      .addScaledVector(panel.vAxis, v)
      .addScaledVector(panel.normal, 0.012);
    g.add(stripe);
  }
  return g;
}

function addMissingFrame(scene: THREE.Scene) {
  const { xHalf, z, y0, y1 } = MISSING_FRAME;
  const pts = [
    new THREE.Vector3(-xHalf, y0, z),
    new THREE.Vector3(xHalf, y0, z),
    new THREE.Vector3(xHalf, y1, z),
    new THREE.Vector3(-xHalf, y1, z),
  ];
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineDashedMaterial({
    color: 0xff5d5d,
    dashSize: 0.18,
    gapSize: 0.12,
    linewidth: 2,
  });
  const line = new THREE.LineLoop(geo, mat);
  line.computeLineDistances();
  scene.add(line);
  const label = makeLabel('缺面：无吸附，跨出即坠落', '#ff8080');
  label.position.set(0, y1 + 0.4, z);
  scene.add(label);
}

export interface WorldRefs {
  scene: THREE.Scene;
  discGroup: THREE.Group;
  discBody: THREE.Mesh;
  headingArrow: THREE.Object3D;
  contactMarker: THREE.Mesh;
  inputFrame: THREE.Group;
  routeLine: THREE.Line;
}

export function buildWorld(): WorldRefs {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0f17);
  scene.fog = new THREE.Fog(0x0b0f17, 22, 46);

  scene.add(new THREE.AmbientLight(0x9fc0ff, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(6, 12, 8);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x88aaff, 0.5);
  fill.position.set(-8, 5, -6);
  scene.add(fill);

  const grid = new THREE.GridHelper(24, 24, 0x33415c, 0x1c2638);
  grid.position.y = -0.14;
  scene.add(grid);

  // 面板
  for (const panel of PANELS) {
    scene.add(panelMesh(panel));
    const edgeGroup = new THREE.Group();
    addEdges(edgeGroup, panel);
    scene.add(edgeGroup);
    const label = makeLabel(
      panel.label,
      panel.stickable ? '#9fd0ff' : '#ff9f9f',
    );
    label.position
      .copy(panel.center)
      .addScaledVector(panel.normal, 0.55)
      .addScaledVector(panel.vAxis, panel.halfV - 0.25);
    scene.add(label);
    if (!panel.stickable) scene.add(addBarrierStripes(panel));
  }

  addMissingFrame(scene);

  // 脚本路线
  const routeGeo = new THREE.BufferGeometry().setFromPoints(ROUTE_POINTS);
  const routeLine = new THREE.Line(
    routeGeo,
    new THREE.LineDashedMaterial({
      color: 0x67e8f9,
      dashSize: 0.25,
      gapSize: 0.15,
    }),
  );
  routeLine.computeLineDistances();
  scene.add(routeLine);

  // 圆盘：扁平圆柱 + 朝向箭头
  const discGroup = new THREE.Group();
  const discBody = new THREE.Mesh(
    new THREE.CylinderGeometry(0.28, 0.28, 0.12, 40),
    new THREE.MeshStandardMaterial({ color: 0xf4f1e8, roughness: 0.3, metalness: 0.4 }),
  );
  discGroup.add(discBody);

  const arrow = new THREE.ArrowHelper(
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 0, 0),
    0.55,
    0xffd166,
    0.16,
    0.11,
  );
  discGroup.add(arrow);
  scene.add(discGroup);

  // 接触面标记（圆盘在面上的投影点）
  const contactMarker = new THREE.Mesh(
    new THREE.RingGeometry(0.34, 0.44, 32),
    new THREE.MeshBasicMaterial({
      color: 0x67e8f9,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
    }),
  );
  scene.add(contactMarker);

  // 输入参照框：屏幕“上 / 右”在当前吸附面上的投影方向
  const inputFrame = new THREE.Group();
  const upArrow = new THREE.ArrowHelper(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 0, 0),
    0.7,
    0x7dd3fc,
    0.16,
    0.1,
  );
  upArrow.name = 'screenUp';
  const rightArrow = new THREE.ArrowHelper(
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 0, 0),
    0.55,
    0xf9a8d4,
    0.14,
    0.09,
  );
  rightArrow.name = 'screenRight';
  inputFrame.add(upArrow, rightArrow);
  scene.add(inputFrame);

  return { scene, discGroup, discBody, headingArrow: arrow, contactMarker, inputFrame, routeLine };
}
