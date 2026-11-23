import type { Bounds, Vec3 } from './types';

export const EPS = 1e-9;

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  return l > EPS ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}

/** 点到三角形最近点 (含内部), Ericson 算法的紧凑版本 */
export function closestPointOnTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;

  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return add(a, scale(ab, v));
  }

  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return add(a, scale(ac, w));
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return add(b, scale(sub(c, b), w));
  }

  const denom = va + vb + vc;
  if (Math.abs(denom) < EPS) return a;
  const denomInv = 1 / denom;
  return add(a, add(scale(ab, vb * denomInv), scale(ac, vc * denomInv)));
}

export function readVec3(array: Float32Array, index: number): Vec3 {
  return [array[index * 3], array[index * 3 + 1], array[index * 3 + 2]];
}

export function writeVec3(array: Float32Array, index: number, v: Vec3): void {
  array[index * 3] = v[0];
  array[index * 3 + 1] = v[1];
  array[index * 3 + 2] = v[2];
}

export function triangleNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  return cross(sub(b, a), sub(c, a));
}

export function triangleArea(a: Vec3, b: Vec3, c: Vec3): number {
  return length(triangleNormal(a, b, c)) * 0.5;
}

export function boundsFromPositions(positions: Float32Array): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX)) {
    return { min: [0, 0, 0], max: [0, 0, 0], center: [0, 0, 0], size: [0, 0, 0], radius: 0 };
  }
  const min: Vec3 = [minX, minY, minZ];
  const max: Vec3 = [maxX, maxY, maxZ];
  const center: Vec3 = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
  const size: Vec3 = [maxX - minX, maxY - minY, maxZ - minZ];
  const radius = Math.hypot(size[0], size[1], size[2]) * 0.5;
  return { min, max, center, size, radius };
}

export function hashMesh(positions: Float32Array, indices: Uint32Array): string {
  // FNV-1a + murmur 混合的 64 位指纹: 直接哈希浮点比特, 任何改动都会体现
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const view = new DataView(positions.buffer, positions.byteOffset, positions.byteLength);
  for (let i = 0; i < positions.length; i++) {
    const bits = view.getUint32(i * 4, true);
    h1 = Math.imul(h1 ^ bits, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ bits, 0x85ebca6b) >>> 0;
    h2 = (h2 ^ (h2 >>> 13)) >>> 0;
  }
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i] >>> 0;
    h1 = Math.imul(h1 ^ v, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ v, 0x5bd1e995) >>> 0;
    h2 = (h2 ^ (h2 >>> 15)) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export function arraysEqual(a: Float32Array | Uint32Array, b: Float32Array | Uint32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function meanVector(vectors: Vec3[]): Vec3 {
  if (vectors.length === 0) return [0, 0, 0];
  let x = 0;
  let y = 0;
  let z = 0;
  for (const v of vectors) {
    x += v[0];
    y += v[1];
    z += v[2];
  }
  return [x / vectors.length, y / vectors.length, z / vectors.length];
}
