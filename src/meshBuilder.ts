import * as THREE from 'three';
import type { MeshParams, PartId, TargetId } from './types';

export interface PartMesh {
  id: PartId;
  geometry: THREE.BufferGeometry;
  /** 每个顶点的参数坐标 (u: 沿圆周 0..1, v: 沿部件纵向 0..1) */
  params: Float32Array;
  /** 基础(未变形)位置, 与 geometry.attributes.position 同序 */
  base: Float32Array;
  /** 折边硬边: 这些顶点在“软变形”中位移恒为 0, 仅随刚体开合移动 */
  hardEdge: Uint8Array;
  /** 每个目标的位移向量场 (rest 空间), 长度 = 顶点数*3 */
  deltas: Record<TargetId, Float32Array>;
  /** 每一环的顶点数(盖子含独立盖心, 环宽仍为径向分段数) */
  ringSize: number;
}

export interface BuiltMeshes {
  wall: PartMesh;
  lid: PartMesh;
  params: MeshParams;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function emptyDeltas(n: number): Record<TargetId, Float32Array> {
  return {
    bulge: new Float32Array(n * 3),
    dent: new Float32Array(n * 3),
    pinch: new Float32Array(n * 3),
  };
}

/**
 * 容器壁: 开口圆柱, 顶部带卷边(hem)。
 * v=0 是底边(固定), v=1 是接缝圈。
 * 最靠近顶部的环为折边硬边(hemDepth 范围内)。
 */
export function buildWall(p: MeshParams): PartMesh {
  const { radialSeg: N, wallRings: R, radius, wallHeight, hemDepth } = p;
  const rows = R + 1;
  const vertCount = N * rows;
  const positions = new Float32Array(vertCount * 3);
  const params = new Float32Array(vertCount * 2);
  const hardEdge = new Uint8Array(vertCount);
  const hemStart = 1 - hemDepth / wallHeight;

  for (let j = 0; j <= R; j++) {
    const v = j / R;
    for (let i = 0; i < N; i++) {
      const u = i / N;
      const theta = u * Math.PI * 2;
      const idx = j * N + i;
      // 折边区: 靠近顶部的环向外微翻, 形成约定的硬卷边;
      // 顶圈半径 rTop 即接缝半径, 盖外圈逐点共用该位置
      const hemT = THREE.MathUtils.clamp((v - hemStart) / (1 - hemStart), 0, 1);
      const r = radius + 0.035 * smooth(hemT);
      const y = v * wallHeight;
      positions[idx * 3] = r * Math.cos(theta);
      positions[idx * 3 + 1] = y;
      positions[idx * 3 + 2] = r * Math.sin(theta);
      params[idx * 2] = u;
      params[idx * 2 + 1] = v;
      if (hemT >= 0.5) hardEdge[idx] = 1;
    }
  }

  const indices: number[] = [];
  for (let j = 0; j < R; j++) {
    for (let i = 0; i < N; i++) {
      const a = j * N + i;
      const b = j * N + ((i + 1) % N);
      const c = (j + 1) * N + i;
      const d = (j + 1) * N + ((i + 1) % N);
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions.slice(), 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  return { id: 'wall', geometry, params, base: positions.slice(), hardEdge, deltas: emptyDeltas(vertCount), ringSize: N };
}

/**
 * 盖子: 圆盘, 外圈一圈折边与容器壁卷边咬合。
 * v=0 是盖心, v=1 是外圈(接缝)。
 * 接缝圈顶点与壁顶圈使用同一组 theta, 位置逐点对齐。
 */
export function buildLid(p: MeshParams): PartMesh {
  const { radialSeg: N, lidRings: R, radius } = p;
  const rTop = radius + 0.035; // 与壁顶接缝圈同半径, 保证逐点对齐
  // 盖心合并为单个顶点 + 三角扇, 避免 N 个重合点产生退化面/NaN 法线
  const vertCount = N * R + 1;
  const centerIndex = 0;
  const positions = new Float32Array(vertCount * 3);
  const params = new Float32Array(vertCount * 2);
  const hardEdge = new Uint8Array(vertCount);

  positions[centerIndex * 3 + 1] = 0;
  params[centerIndex * 2] = 0;
  params[centerIndex * 2 + 1] = 0;

  // 环 j=1..R, 顶点索引 1 + (j-1)*N + i
  const ringIndex = (j: number, i: number) => 1 + (j - 1) * N + i;

  for (let j = 1; j <= R; j++) {
    const v = j / R;
    for (let i = 0; i < N; i++) {
      const u = i / N;
      const theta = u * Math.PI * 2;
      const idx = ringIndex(j, i);
      // 外圈 8% 为折边区; 外圈本身局部 y=0, 经引擎平移后与壁顶圈严格同高;
      // 折边内侧环向内下扣, 形成可辨认的硬边轮廓
      const rimT = THREE.MathUtils.clamp((v - 0.92) / 0.08, 0, 1);
      const r = rTop * v;
      const y = -0.03 * smooth(rimT) * (1 - v) / 0.08;
      positions[idx * 3] = r * Math.cos(theta);
      positions[idx * 3 + 1] = y;
      positions[idx * 3 + 2] = r * Math.sin(theta);
      params[idx * 2] = u;
      params[idx * 2 + 1] = v;
      if (rimT >= 0.5) hardEdge[idx] = 1;
    }
  }

  const indices: number[] = [];
  // 盖心三角扇(法线朝上): 盖心 -> 内环 -> 下一个内环点
  for (let i = 0; i < N; i++) {
    const a = ringIndex(1, i);
    const b = ringIndex(1, (i + 1) % N);
    indices.push(centerIndex, a, b);
  }
  // 环间四边形(法线朝上): 两三角形 (a,b,c) 与 (b,d,c)
  for (let j = 1; j < R; j++) {
    for (let i = 0; i < N; i++) {
      const a = ringIndex(j, i);
      const b = ringIndex(j, (i + 1) % N);
      const c = ringIndex(j + 1, i);
      const d = ringIndex(j + 1, (i + 1) % N);
      indices.push(a, b, c, b, d, c);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions.slice(), 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  return { id: 'lid', geometry, params, base: positions.slice(), hardEdge, deltas: emptyDeltas(vertCount), ringSize: N };
}

/** 圆周方向距离 (0..0.5) */
function angDist(u: number, center: number): number {
  let x = Math.abs(u - center);
  if (x > 0.5) x = 1 - x;
  return x;
}

/**
 * 目标作用强度的参数空间衰减。
 * 三个目标的作用区刻意部分重叠: 同时开启时重叠区即“共同影响区域”。
 * 纵向 sin 包络保证两端(v=0 壁底 / v=1 接缝)衰减到 0, 固定点不动。
 */
export function targetFalloff(part: PartId, target: TargetId, u: number, v: number): number {
  const vf = Math.sin(Math.PI * THREE.MathUtils.clamp(v, 0, 1));
  let af = 1;
  if (part === 'wall') {
    if (target === 'bulge') af = Math.exp(-Math.pow(angDist(u, 0.25) / 0.22, 2));
    if (target === 'dent') af = Math.exp(-Math.pow(angDist(u, 0.38) / 0.2, 2));
    if (target === 'pinch') af = Math.exp(-Math.pow(angDist(u, 0.5) / 0.3, 2));
  } else {
    // 盖子: 鼓起偏盖心, 按凹偏心, 捏窄覆盖整个盖面
    if (target === 'bulge') af = Math.exp(-Math.pow(v / 0.75, 2)) + 0.15;
    if (target === 'dent') af = Math.exp(-Math.pow(angDist(u, 0.3) / 0.28, 2)) * (0.4 + 0.6 * v);
    if (target === 'pinch') af = 1;
  }
  return THREE.MathUtils.clamp(vf * af, 0, 1);
}

/**
 * 由同一基础网格生成三个目标位移场。
 * 位移定义在 rest 空间, 混合即线性加权; 硬边点位移恒为 0。
 */
export function buildAll(p: MeshParams): BuiltMeshes {
  const wall = buildWall(p);
  const lid = buildLid(p);

  for (const mesh of [wall, lid]) {
    const n = mesh.base.length / 3;
    for (const target of ['bulge', 'dent', 'pinch'] as TargetId[]) {
      const arr = mesh.deltas[target];
      for (let k = 0; k < n; k++) {
        if (mesh.hardEdge[k]) continue;
        const u = mesh.params[k * 2];
        const v = mesh.params[k * 2 + 1];
        const profile = targetFalloff(mesh.id, target, u, v);
        if (profile <= 0) continue;
        const bx = mesh.base[k * 3];
        const bz = mesh.base[k * 3 + 2];

        if (mesh.id === 'wall') {
          const radial = new THREE.Vector3(bx, 0, bz).normalize();
          if (target === 'bulge') {
            // 鼓起: 径向外凸
            arr[k * 3] = radial.x * 0.35 * profile;
            arr[k * 3 + 1] = 0.04 * profile;
            arr[k * 3 + 2] = radial.z * 0.35 * profile;
          } else if (target === 'dent') {
            // 按凹: 径向内压, 作用区与鼓起部分重叠
            arr[k * 3] = -radial.x * 0.3 * profile;
            arr[k * 3 + 1] = -0.03 * profile;
            arr[k * 3 + 2] = -radial.z * 0.3 * profile;
          } else {
            // 捏窄: 沿一个轴向内收, 椭圆化
            const squeeze = Math.cos(u * Math.PI * 2) * 0.22 * profile;
            arr[k * 3] = -radial.x * 0.18 * profile + squeeze * 0.4;
            arr[k * 3 + 1] = 0;
            arr[k * 3 + 2] = -radial.z * 0.18 * profile - squeeze * 0.4;
          }
        } else {
          const radialLen = Math.hypot(bx, bz);
          const radial = radialLen > 1e-9
            ? new THREE.Vector3(bx / radialLen, 0, bz / radialLen)
            : new THREE.Vector3(1, 0, 0);
          if (target === 'bulge') {
            arr[k * 3 + 1] = 0.3 * profile; // 盖面向上鼓
          } else if (target === 'dent') {
            arr[k * 3 + 1] = -0.25 * profile; // 盖面向下凹
          } else {
            const squeeze = Math.cos(u * Math.PI * 2) * 0.16 * profile;
            arr[k * 3] = -radial.x * 0.12 * profile + squeeze * 0.4;
            arr[k * 3 + 2] = -radial.z * 0.12 * profile - squeeze * 0.4;
          }
        }
      }
    }
  }

  return { wall, lid, params: p };
}
