/**
 * geometry.ts —— 带斜面的非对称物体
 *
 * 一个棱柱:截面是切掉一个角的矩形(非对称),沿 Y 拉伸。
 * 共 7 个平面(5 个侧面 + 顶/底),每个面法线不同、朝向明确,
 * 便于在不同面上选检查点核对反射方向。使用非索引几何体 + 平面着色,
 * 保证每个面的法线严格恒定,读数与画面一致。
 */

import {
  BufferGeometry, Float32BufferAttribute, EdgesGeometry, LineSegments,
  LineBasicMaterial,
  MeshStandardMaterial, Mesh, type BufferAttribute,
} from 'three';

/** 截面多边形(xz 平面,逆时针,使顶面法线为 +Y) */
const SECTION: [number, number][] = [
  [-1.0, -0.8],
  [0.7, -0.8],
  [1.0, -0.5], // 被切掉的角:斜边从 (0.7,-0.8) 到 (1.0,-0.5)
  [1.0, 0.8],
  [-1.0, 0.8],
];
const Y_TOP = 0.9;
const Y_BOTTOM = -0.9;

export function createChamferedGeometry(): BufferGeometry {
  const positions: number[] = [];
  const n = SECTION.length;

  const pushTri = (
    a: [number, number, number], b: [number, number, number], c: [number, number, number],
    normal: [number, number, number],
  ): void => {
    positions.push(...a, ...b, ...c);
    // 每个顶点写同样的法线(平面着色)
    normals.push(...normal, ...normal, ...normal);
  };
  const normals: number[] = [];

  // 顶面(扇形,逆时针截面 -> +Y)
  const centerTop: [number, number, number] = [0, Y_TOP, 0];
  for (let i = 0; i < n; i++) {
    const p1 = SECTION[i];
    const p2 = SECTION[(i + 1) % n];
    pushTri(
      centerTop,
      [p1[0], Y_TOP, p1[1]],
      [p2[0], Y_TOP, p2[1]],
      [0, 1, 0],
    );
  }
  // 底面(反向绕序 -> -Y)
  const centerBottom: [number, number, number] = [0, Y_BOTTOM, 0];
  for (let i = 0; i < n; i++) {
    const p1 = SECTION[i];
    const p2 = SECTION[(i + 1) % n];
    pushTri(
      centerBottom,
      [p2[0], Y_BOTTOM, p2[1]],
      [p1[0], Y_BOTTOM, p1[1]],
      [0, -1, 0],
    );
  }
  // 侧面:每条截面边挤出一个四边形(两个三角形)
  for (let i = 0; i < n; i++) {
    const p1 = SECTION[i];
    const p2 = SECTION[(i + 1) % n];
    const dx = p2[0] - p1[0];
    const dz = p2[1] - p1[1];
    // 外法线(xz 内):边 (dx,dz) 逆时针的右侧
    const nl = Math.hypot(dx, dz);
    const normal: [number, number, number] = [dz / nl, 0, -dx / nl];
    const a: [number, number, number] = [p1[0], Y_BOTTOM, p1[1]];
    const b: [number, number, number] = [p2[0], Y_BOTTOM, p2[1]];
    const c: [number, number, number] = [p2[0], Y_TOP, p2[1]];
    const d: [number, number, number] = [p1[0], Y_TOP, p1[1]];
    pushTri(a, b, c, normal);
    pushTri(a, c, d, normal);
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  return geo;
}

export interface ChamferObject {
  mesh: Mesh;
  edges: LineSegments;
  material: MeshStandardMaterial;
}

export function createChamferedObject(): ChamferObject {
  const geo = createChamferedGeometry();
  const material = new MeshStandardMaterial({
    color: 0xcfd6dd,
    metalness: 0.95,
    roughness: 0.18,
    envMapIntensity: 1.0,
  });
  const mesh = new Mesh(geo, material);
  mesh.name = 'chamfered';
  const edges = new LineSegments(
    new EdgesGeometry(geo, 20),
    new LineBasicMaterial({ color: 0x111418 }),
  );
  return { mesh, edges, material };
}

/** 遍历平面三角面(用于检查点法线展示等) */
export function triangleCount(geo: BufferGeometry): number {
  return (geo.getAttribute('position') as BufferAttribute).count / 3;
}
