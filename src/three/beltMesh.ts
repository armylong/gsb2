/**
 * 沿带路挤出的薄带网格 + 程序生成的滚轮与接触弧高亮。
 */
import * as THREE from 'three';
import { sampleAt, type BeltPath, type Pulley } from '../math/belt';

export const BELT_WIDTH = 1.1;
const BELT_THICKNESS = 0.07;

/** 沿带路生成闭合挤出薄带：外侧面（+法线）贴带面纹理，其余面深色 */
export function buildRibbon(path: BeltPath, texture: THREE.Texture): THREE.Mesh {
  const N = Math.max(240, Math.round(path.length * 26));
  const W = BELT_WIDTH;
  const T = BELT_THICKNESS;

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const groups: { start: number; count: number; materialIndex: number }[] = [];

  interface RingData {
    verts: THREE.Vector3[];
    nrm: THREE.Vector3;
    u: number;
  }
  const ring: RingData[] = [];
  for (let i = 0; i <= N; i++) {
    const s = (i / N) * path.length;
    const smp = sampleAt(path, s);
    const p = new THREE.Vector3(smp.p.x, smp.p.y, 0);
    const n = new THREE.Vector3(smp.normal.x, smp.normal.y, 0);
    const zL = -W / 2;
    const zR = W / 2;
    const inner = p.clone().addScaledVector(n, -T / 2);
    const outer = p.clone().addScaledVector(n, T / 2);
    ring.push({
      verts: [
        new THREE.Vector3(inner.x, inner.y, zL), // 0 inner-left
        new THREE.Vector3(inner.x, inner.y, zR), // 1 inner-right
        new THREE.Vector3(outer.x, outer.y, zR), // 2 outer-right
        new THREE.Vector3(outer.x, outer.y, zL), // 3 outer-left
      ],
      nrm: n,
      u: s / path.length,
    });
  }

  const pushQuad = (
    a: THREE.Vector3,
    b: THREE.Vector3,
    c: THREE.Vector3,
    d: THREE.Vector3,
    nrm: THREE.Vector3,
    ua: number,
    ub: number,
    vA: number,
    vB: number,
    mat: number,
  ) => {
    const start = positions.length / 3;
    for (const [vtx, uu, vv] of [
      [a, ua, vA],
      [b, ub, vA],
      [c, ub, vB],
      [a, ua, vA],
      [c, ub, vB],
      [d, ua, vB],
    ] as const) {
      positions.push(vtx.x, vtx.y, vtx.z);
      normals.push(nrm.x, nrm.y, nrm.z);
      uvs.push(uu, vv);
    }
    groups.push({ start, count: 6, materialIndex: mat });
  };

  for (let i = 0; i < N; i++) {
    const a = ring[i];
    const b = ring[i + 1];
    const zAxis = new THREE.Vector3(0, 0, 1);
    // 外侧面（材质 0，纹理）
    pushQuad(a.verts[3], a.verts[2], b.verts[2], b.verts[3], a.nrm, a.u, b.u, 0, 1, 0);
    // 内侧面（材质 1）
    pushQuad(a.verts[1], a.verts[0], b.verts[0], b.verts[1], a.nrm.clone().negate(), a.u, b.u, 0, 1, 1);
    // 左右侧边（材质 1）
    pushQuad(a.verts[0], a.verts[3], b.verts[3], b.verts[0], zAxis.clone().negate(), a.u, b.u, 0, 1, 1);
    pushQuad(a.verts[2], a.verts[1], b.verts[1], b.verts[2], zAxis, a.u, b.u, 0, 1, 1);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  for (const g of groups) geo.addGroup(g.start, g.count, g.materialIndex);

  const outerMat = new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 0.65,
    metalness: 0.08,
  });
  const sideMat = new THREE.MeshStandardMaterial({ color: '#1c2027', roughness: 0.9, metalness: 0.1 });
  const mesh = new THREE.Mesh(geo, [outerMat, sideMat]);
  return mesh;
}

/** 程序生成一只滚轮：金属轮体、轮缘、轮毂、端面转动标志 */
export function buildPulley(pulley: Pulley, index: number): THREE.Group {
  const { radius: r, center } = pulley;
  const group = new THREE.Group();
  group.position.set(center.x, center.y, 0);

  const metal = new THREE.MeshStandardMaterial({ color: '#8b95a5', roughness: 0.35, metalness: 0.75 });
  const dark = new THREE.MeshStandardMaterial({ color: '#3a4150', roughness: 0.5, metalness: 0.6 });

  const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, BELT_WIDTH * 1.12, 56), metal);
  body.rotation.x = Math.PI / 2; // 轴对齐 z
  group.add(body);

  // 两端轮缘
  for (const z of [-BELT_WIDTH * 0.56, BELT_WIDTH * 0.56]) {
    const rim = new THREE.Mesh(new THREE.TorusGeometry(r, 0.045, 12, 64), dark);
    rim.position.z = z;
    group.add(rim);
  }

  // 轮毂
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.22, r * 0.22, BELT_WIDTH * 1.2, 32), dark);
  hub.rotation.x = Math.PI / 2;
  group.add(hub);

  // 端面辐条
  const spokeMat = new THREE.MeshStandardMaterial({ color: '#5d6675', roughness: 0.4, metalness: 0.7 });
  for (let k = 0; k < 4; k++) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(r * 0.78, 0.05, 0.04), spokeMat);
    spoke.position.x = r * 0.39;
    spoke.position.z = BELT_WIDTH * 0.58;
    const sg = new THREE.Group();
    sg.add(spoke);
    sg.rotation.z = (k * Math.PI) / 2;
    group.add(sg);
  }

  // 端面转动标志：亮色径向线 + 端点，方便肉眼验证轮随带转动
  const markerMat = new THREE.MeshBasicMaterial({ color: '#ff7a59' });
  const line = new THREE.Mesh(new THREE.BoxGeometry(r * 0.85, 0.035, 0.05), markerMat);
  line.position.x = r * 0.425;
  line.position.z = BELT_WIDTH * 0.62;
  group.add(line);
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 12), markerMat);
  dot.position.set(r * 0.85, 0, BELT_WIDTH * 0.62);
  group.add(dot);

  group.userData.index = index;
  group.userData.radius = r;
  return group;
}

/** 接触弧高亮：固定在世界坐标的黄色弧段 + 两个切点小球 */
export function buildContactArc(path: BeltPath): THREE.Group {
  const group = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({ color: '#ffd23f' });
  const ballMat = new THREE.MeshBasicMaterial({ color: '#ffd23f' });

  for (const contact of path.contacts) {
    const pulley = path.pulleys[contact.pulley];
    const pts: THREE.Vector3[] = [];
    const steps = 48;
    const rr = pulley.radius + 0.025;
    for (let i = 0; i <= steps; i++) {
      const theta = contact.thetaStart - (i / steps) * contact.wrap;
      pts.push(
        new THREE.Vector3(
          pulley.center.x + rr * Math.cos(theta),
          pulley.center.y + rr * Math.sin(theta),
          BELT_WIDTH * 0.58,
        ),
      );
    }
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
    group.add(line);

    for (const theta of [contact.thetaStart, contact.thetaEnd]) {
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.065, 16, 12), ballMat);
      ball.position.set(
        pulley.center.x + rr * Math.cos(theta),
        pulley.center.y + rr * Math.sin(theta),
        BELT_WIDTH * 0.58,
      );
      group.add(ball);
    }
  }
  return group;
}
