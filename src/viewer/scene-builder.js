// 核心网格数据 <-> Three.js 场景对象的适配层。
// 所有高亮/线框都基于原始坐标构建，与拆分后渲染网格严格对齐。

import * as THREE from 'three';
import { ISSUE_TYPES } from '../core/inspect.js';

export const EDGE_COLORS = {
  angle: 0xffc400,        // 角度棱边：黄
  'flat-mode': 0xffc400,
  boundary: 0xff8a00,     // 边界边：橙
  'non-manifold': 0xff2d2d, // 非流形：红
  orientation: 0xd03cff,  // 方向不连续：紫
};

export const ISSUE_COLORS = {
  [ISSUE_TYPES.DEGENERATE]: 0x888888,
  [ISSUE_TYPES.REVERSED]: 0xff3b30,
  [ISSUE_TYPES.ORIENTATION_DISCONTINUITY]: 0xd03cff,
  [ISSUE_TYPES.NON_MANIFOLD]: 0xff2d2d,
  [ISSUE_TYPES.BOUNDARY]: 0xff8a00,
  [ISSUE_TYPES.ZERO_NORMAL]: 0xaaaaaa,
  [ISSUE_TYPES.DUPLICATE_VERTEX]: 0x2dd4bf,
  [ISSUE_TYPES.OPEN_COMPONENT]: 0x38bdf8,
};

// 拆分后的网格 -> BufferGeometry（携带顶点法线）
export function buildShadedGeometry(shaded) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position',
    new THREE.Float32BufferAttribute(shaded.positions, 3));
  geo.setAttribute('normal',
    new THREE.Float32BufferAttribute(shaded.normals, 3));
  geo.setIndex(shaded.faces.flat());
  return geo;
}

// 问题面高亮：从源网格挑出指定面，沿面法线微膨胀，避免 z-fighting
export function buildHighlightMesh(mesh, faceSet, color) {
  const positions = [];
  const push = (i) => {
    const o = i * 3;
    positions.push(mesh.positions[o], mesh.positions[o + 1], mesh.positions[o + 2]);
  };
  for (const fi of faceSet) {
    const [a, b, c] = mesh.faces[fi];
    push(a); push(b); push(c);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.72, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    depthWrite: false,
  });
  return new THREE.Mesh(geo, mat);
}

// 硬边/问题边线（基于拆分后索引，保证与显示网格一致）
export function buildEdgeLinesFromShaded(shaded, reasons = null) {
  const positions = [];
  const colors = [];
  const seen = new Set();
  for (const e of shaded.hardEdges) {
    if (reasons && !reasons.includes(e.reason)) continue;
    const k = `${Math.min(e.a, e.b)}_${Math.max(e.a, e.b)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const col = new THREE.Color(EDGE_COLORS[e.reason] ?? 0xffffff);
    for (const vi of [e.a, e.b]) {
      const o = vi * 3;
      positions.push(shaded.positions[o], shaded.positions[o + 1], shaded.positions[o + 2]);
      colors.push(col.r, col.g, col.b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return new THREE.LineSegments(geo,
    new THREE.LineBasicMaterial({ vertexColors: true, linewidth: 2 }));
}

// 基于源网格边记录的线（边界/非流形/方向不连续，独立于显示模式）
export function buildEdgeLinesFromMesh(mesh, edgePairs, color) {
  const positions = [];
  for (const [u, v] of edgePairs) {
    for (const vi of [u, v]) {
      const o = vi * 3;
      positions.push(mesh.positions[o], mesh.positions[o + 1], mesh.positions[o + 2]);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color }));
  lines.computeLineDistances?.();
  return lines;
}

// 顶点法线箭头（量大时自动抽样，上限 maxArrows）
export function buildNormalArrows(shaded, maxArrows = 250) {
  const group = new THREE.Group();
  const n = shaded.positions.length / 3;
  const stride = Math.max(1, Math.ceil(n / maxArrows));
  const len = estimateScale(shaded.positions) * 0.12;
  for (let i = 0; i < n; i += stride) {
    const o = i * 3;
    const origin = new THREE.Vector3(
      shaded.positions[o], shaded.positions[o + 1], shaded.positions[o + 2]);
    const dir = new THREE.Vector3(
      shaded.normals[o], shaded.normals[o + 1], shaded.normals[o + 2]);
    if (dir.lengthSq() === 0) continue;
    const arrow = new THREE.ArrowHelper(dir.normalize(), origin, len, 0x67e8f9, len * 0.35, len * 0.22);
    group.add(arrow);
  }
  return group;
}

export function estimateScale(positions) {
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], positions[i + k]);
      max[k] = Math.max(max[k], positions[i + k]);
    }
  }
  return Math.max(...max.map((m, k) => m - min[k]), 1e-6);
}

// 计算取景参数，返回居中位置与相机距离
export function frameParams(positions, fovDeg = 45) {
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], positions[i + k]);
      max[k] = Math.max(max[k], positions[i + k]);
    }
  }
  const center = min.map((lo, k) => (lo + max[k]) / 2);
  const radius = Math.max(...max.map((m, k) => m - min[k])) / 2 || 1;
  const dist = radius / Math.sin((fovDeg * Math.PI) / 360) * 1.25;
  return { center, radius, dist };
}

// 面拾取：three 的 faceIndex -> 源网格面索引
export function pickSourceFace(intersection, shaded) {
  if (intersection.faceIndex === undefined) return null;
  const outFace = Math.floor(intersection.faceIndex / 1);
  return shaded.faceMap[outFace] ?? null;
}
