import * as THREE from 'three';
import { classifyHit, facePoint2, FaceId } from './geom';

export interface ImageSpec {
  cx: number;
  cy: number;
  cz: number;
  w: number;
  h: number;
}

/** 取色器:输入目标图局部坐标(米,原点在图中心),返回 css 颜色 */
export type Sampler = (u: number, v: number) => string;

export type CornerStatus = 'ok' | 'miss' | 'blocked';

export interface CornerResult {
  status: CornerStatus;
  face: FaceId | null;
  p: THREE.Vector3 | null;
  p2: [number, number] | null;
}

export interface PaintCell {
  i: number;
  j: number;
  face: FaceId;
  /** 四角三维落点,顺序 [左下, 右下, 右上, 左上](图像局部 u 右、v 上) */
  corners3: THREE.Vector3[];
  /** 四角在所属面上的二维坐标(米) */
  corners2: [number, number][];
  /** 四角对应的目标图局部坐标(米) */
  srcUV: [number, number][];
  color: string;
}

export type MarkKind = 'miss' | 'edge' | 'blocked';

export interface MarkCell {
  i: number;
  j: number;
  kind: MarkKind;
}

export interface ProjectionResult {
  cells: PaintCell[];
  marks: MarkCell[];
  nu: number;
  nv: number;
}

/**
 * 核心投影:把目标图划分成 nu×nv 网格,从 eye 向每个网格角点引射线,
 * 取与场景(地面+台阶)的第一个交点作为落点 —— 第一个交点天然处理了遮挡:
 * 视线先打到台阶正面时,被挡住的地面根本不会被命中。
 */
export function computeProjection(
  eye: THREE.Vector3,
  img: ImageSpec,
  occluders: THREE.Object3D[],
  nu: number,
  nv: number,
  sample: Sampler,
): ProjectionResult {
  const ray = new THREE.Raycaster();
  const uOf = (i: number) => -img.w / 2 + (i / nu) * img.w;
  const vOf = (j: number) => -img.h / 2 + (j / nv) * img.h;

  // 先对所有网格角点做射线求交
  const corners: CornerResult[] = new Array((nu + 1) * (nv + 1));
  const cidx = (i: number, j: number) => j * (nu + 1) + i;
  const target = new THREE.Vector3();
  const dir = new THREE.Vector3();

  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      target.set(img.cx + uOf(i), img.cy + vOf(j), img.cz);
      dir.copy(target).sub(eye).normalize();
      ray.set(eye, dir);
      const hits = ray.intersectObjects(occluders, false);
      let res: CornerResult = { status: 'miss', face: null, p: null, p2: null };
      if (hits.length > 0) {
        const face = classifyHit(hits[0]);
        if (face) {
          res = { status: 'ok', face, p: hits[0].point.clone(), p2: facePoint2(face, hits[0].point) };
        } else {
          res = { status: 'blocked', face: null, p: hits[0].point.clone(), p2: null };
        }
      }
      corners[cidx(i, j)] = res;
    }
  }

  // 再按单元格归类
  const cells: PaintCell[] = [];
  const marks: MarkCell[] = [];
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      // 角点顺序:左下 (i,j) → 右下 (i+1,j) → 右上 (i+1,j+1) → 左上 (i,j+1)
      const quad = [corners[cidx(i, j)], corners[cidx(i + 1, j)], corners[cidx(i + 1, j + 1)], corners[cidx(i, j + 1)]];
      const uv: [number, number][] = [
        [uOf(i), vOf(j)],
        [uOf(i + 1), vOf(j)],
        [uOf(i + 1), vOf(j + 1)],
        [uOf(i), vOf(j + 1)],
      ];
      const allOk = quad.every((c) => c.status === 'ok');
      if (allOk && quad.every((c) => c.face === quad[0].face)) {
        cells.push({
          i,
          j,
          face: quad[0].face!,
          corners3: quad.map((c) => c.p!),
          corners2: quad.map((c) => c.p2!),
          srcUV: uv,
          color: sample(uOf(i + 0.5), vOf(j + 0.5)),
        });
      } else if (quad.every((c) => c.status === 'miss')) {
        marks.push({ i, j, kind: 'miss' });
      } else if (quad.some((c) => c.status === 'blocked') && !quad.some((c) => c.status === 'ok')) {
        marks.push({ i, j, kind: 'blocked' });
      } else {
        // 四角落点跨面 / 部分落空:处于面的边界上
        marks.push({ i, j, kind: 'edge' });
      }
    }
  }
  return { cells, marks, nu, nv };
}

/** 单点查询:目标图上 (u,v) 处,从 eye 看过去落到哪里 */
export function projectPoint(
  eye: THREE.Vector3,
  img: ImageSpec,
  occluders: THREE.Object3D[],
  u: number,
  v: number,
): { face: FaceId | null; status: CornerStatus; p: THREE.Vector3 | null } {
  const ray = new THREE.Raycaster();
  const target = new THREE.Vector3(img.cx + u, img.cy + v, img.cz);
  const dir = target.clone().sub(eye).normalize();
  ray.set(eye, dir);
  const hits = ray.intersectObjects(occluders, false);
  if (hits.length === 0) return { face: null, status: 'miss', p: null };
  const face = classifyHit(hits[0]);
  if (!face) return { face: null, status: 'blocked', p: hits[0].point.clone() };
  return { face, status: 'ok', p: hits[0].point.clone() };
}
