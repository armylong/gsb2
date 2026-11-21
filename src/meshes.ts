import * as THREE from "three";
import type { MeshData } from "./core/section";

// ---- 已知尺寸（验证用解析解的依据） ----
export const SHELL_OUTER = 4; // 外立方体边长
export const SHELL_INNER = 3; // 内腔立方体边长（壁厚 0.5）
export const TORUS_MAJOR = 2; // 环体中心半径 R
export const TORUS_MINOR = 1; // 环管半径 r

export type MeshKind = "shell" | "torus" | "brokenShell" | "brokenTorus";

export interface BuiltMesh {
  data: MeshData;
  kind: MeshKind;
  label: string;
  geometry: THREE.BufferGeometry;
}

function toMeshData(geometry: THREE.BufferGeometry): MeshData {
  const pos = geometry.getAttribute("position") as THREE.BufferAttribute;
  let rawIndices: Uint32Array;
  if (geometry.getIndex()) {
    const idx = geometry.getIndex()!;
    rawIndices = new Uint32Array(idx.count);
    rawIndices.set(idx.array as Uint32Array);
  } else {
    rawIndices = new Uint32Array(pos.count);
    for (let i = 0; i < rawIndices.length; i++) rawIndices[i] = i;
  }

  // 焊接重复顶点：BoxGeometry 面与面之间、TorusGeometry 接缝处都存在
  // 坐标相同但索引不同的顶点，不焊接会导致网格被误判为破面、截交环被切碎。
  const weldTol = 1e-7;
  const weldMap = new Map<string, number>();
  const remap = new Uint32Array(pos.count);
  const unique: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const key = `${Math.round(pos.getX(i) / weldTol)}|${Math.round(pos.getY(i) / weldTol)}|${Math.round(pos.getZ(i) / weldTol)}`;
    let id = weldMap.get(key);
    if (id === undefined) {
      id = unique.length;
      unique.push(i);
      weldMap.set(key, id);
    }
    remap[i] = id;
  }
  const positions = new Float64Array(unique.length * 3);
  unique.forEach((src, dst) => {
    positions[dst * 3] = pos.getX(src);
    positions[dst * 3 + 1] = pos.getY(src);
    positions[dst * 3 + 2] = pos.getZ(src);
  });
  const indices = new Uint32Array(rawIndices.length);
  for (let i = 0; i < rawIndices.length; i++) indices[i] = remap[rawIndices[i]];
  return { positions, indices };
}

/** 封闭方壳：外法线朝外的外盒 + 法线朝内的内盒，围成完全封闭的空心壳体 */
function shellGeometry(outer: number, inner: number): THREE.BufferGeometry {
  // 外盒做 4×4 细分，破面版本才能在顶面挖出规则小洞
  const outerBox = new THREE.BoxGeometry(outer, outer, outer, 4, 4, 4);
  const innerBox = new THREE.BoxGeometry(inner, inner, inner);
  // 翻转内盒三角面朝向，使法线指向内腔
  const innerIndex = innerBox.getIndex()!;
  const reversed = new Uint32Array(innerIndex.count);
  for (let t = 0; t < innerIndex.count; t += 3) {
    reversed[t] = innerIndex.getX(t);
    reversed[t + 1] = innerIndex.getX(t + 2);
    reversed[t + 2] = innerIndex.getX(t + 1);
  }
  const innerGeom = new THREE.BufferGeometry();
  innerGeom.setAttribute("position", innerBox.getAttribute("position").clone());
  innerGeom.setIndex(new THREE.BufferAttribute(reversed, 1));

  const merged = mergeGeometries(outerBox, innerGeom);
  outerBox.dispose();
  innerBox.dispose();
  innerGeom.dispose();
  return merged;
}

function mergeGeometries(a: THREE.BufferGeometry, b: THREE.BufferGeometry): THREE.BufferGeometry {
  const posA = a.getAttribute("position") as THREE.BufferAttribute;
  const posB = b.getAttribute("position") as THREE.BufferAttribute;
  const idxA = a.getIndex()!;
  const idxB = b.getIndex()!;
  const offset = posA.count;
  const positions = new Float32Array((posA.count + posB.count) * 3);
  positions.set(posA.array as Float32Array, 0);
  positions.set(posB.array as Float32Array, posA.count * 3);
  const indices = new Uint32Array(idxA.count + idxB.count);
  indices.set(idxA.array as Uint32Array, 0);
  for (let i = 0; i < idxB.count; i++) indices[idxA.count + i] = idxB.getX(i) + offset;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  g.setIndex(new THREE.BufferAttribute(indices, 1));
  return g;
}

/**
 * 破面方壳：在外盒顶面中心挖掉若干三角面，形成边界边。
 * 只动 z≈2 的外顶面，内腔保持完整。
 */
function brokenShellGeometry(outer: number, inner: number): THREE.BufferGeometry {
  const g = shellGeometry(outer, inner);
  // 4×4 细分下，每格边长 1；取中心 2×2 格（质心在 ±0.5），得到 8 条边界边
  removeTriangles(g, (centroid) => centroid.z > outer / 2 - 1e-6 && Math.abs(centroid.x) <= 0.5 + 1e-6 && Math.abs(centroid.y) <= 0.5 + 1e-6);
  return g;
}

/** 破面环体：在环管底部外侧挖掉一小块三角面 */
function brokenTorusGeometry(R: number, r: number): THREE.BufferGeometry {
  const g = new THREE.TorusGeometry(R, r, 256, 64);
  removeTriangles(g, (centroid) => centroid.z < -0.6 * r && centroid.x > R - 0.15);
  return g;
}

function removeTriangles(g: THREE.BufferGeometry, keepRemoved: (centroid: THREE.Vector3) => boolean): void {
  const idx = g.getIndex()!;
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  const kept: number[] = [];
  const c = new THREE.Vector3();
  for (let t = 0; t < idx.count; t += 3) {
    const i0 = idx.getX(t);
    const i1 = idx.getX(t + 1);
    const i2 = idx.getX(t + 2);
    c.set(0, 0, 0);
    c.add(new THREE.Vector3(pos.getX(i0), pos.getY(i0), pos.getZ(i0)));
    c.add(new THREE.Vector3(pos.getX(i1), pos.getY(i1), pos.getZ(i1)));
    c.add(new THREE.Vector3(pos.getX(i2), pos.getY(i2), pos.getZ(i2)));
    c.multiplyScalar(1 / 3);
    if (!keepRemoved(c)) kept.push(i0, i1, i2);
  }
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(kept), 1));
}

export function buildMesh(kind: MeshKind): BuiltMesh {
  let geometry: THREE.BufferGeometry;
  let label: string;
  switch (kind) {
    case "shell":
      geometry = shellGeometry(SHELL_OUTER, SHELL_INNER);
      label = "封闭方壳";
      break;
    case "torus":
      // 高细分让解析解与三角化结果的差异足够小
      geometry = new THREE.TorusGeometry(TORUS_MAJOR, TORUS_MINOR, 200, 256);
      label = "带孔环体（圆环）";
      break;
    case "brokenShell":
      geometry = brokenShellGeometry(SHELL_OUTER, SHELL_INNER);
      label = "破面方壳（顶面挖洞）";
      break;
    case "brokenTorus":
      geometry = brokenTorusGeometry(TORUS_MAJOR, TORUS_MINOR);
      label = "破面环体（管底挖洞）";
      break;
  }
  return { data: toMeshData(geometry), kind, label, geometry };
}
