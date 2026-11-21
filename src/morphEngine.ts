import * as THREE from 'three';
import type { PartMesh } from './meshBuilder';
import type { PartId, TargetId, Weights } from './types';

const TARGET_IDS: TargetId[] = ['bulge', 'dent', 'pinch'];

export interface MorphResult {
  /** 每个部件发生翻转的三角形本地面序号(对应该部件 geometry.index 的三元组序号) */
  invertedFaces: Record<PartId, number[]>;
  /** 接近翻转(法线与初始法线夹角过大)的面 */
  strainedFaces: Record<PartId, number[]>;
  /** 接缝两侧对应顶点的最大世界坐标间距 */
  seamMaxGap: number;
}

/**
 * 变形引擎: 形状是权重的纯函数。
 * 给定同一组权重永远得到同一画面, 时间轴反向/切换目标都不会跳变。
 */
export class MorphEngine {
  readonly wall: PartMesh;
  readonly lid: PartMesh;
  readonly wallHeight: number;
  readonly radialSeg: number;
  /** 盖子铰链枢轴(世界坐标), 沿 Z 轴 */
  readonly hingePivot = new THREE.Vector3();
  /** 各三角形的初始法线(部件局部空间), 用于翻面判定 */
  private baseFaceNormals: Record<PartId, THREE.Vector3[]>;
  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();
  private tmpC = new THREE.Vector3();

  constructor(wall: PartMesh, lid: PartMesh, wallHeight: number, seamRadius: number, radialSeg: number) {
    this.wall = wall;
    this.lid = lid;
    this.wallHeight = wallHeight;
    this.radialSeg = radialSeg;
    this.hingePivot.set(seamRadius, wallHeight, 0);
    this.baseFaceNormals = {
      wall: this.computeFaceNormals(wall, wall.base),
      lid: this.computeFaceNormals(lid, lid.base),
    };
  }

  /** 把一组权重应用到两个网格, 返回质检结果 */
  apply(w: Weights): MorphResult {
    this.applySoft(this.wall, w.wall);
    this.applyLid(w);
    this.recomputeNormals(this.wall);
    this.recomputeNormals(this.lid);

    const invertedFaces = { wall: [], lid: [] } as Record<PartId, number[]>;
    const strainedFaces = { wall: [], lid: [] } as Record<PartId, number[]>;
    this.detectFlip(this.wall, invertedFaces, strainedFaces, null);
    // 盖子当前法线在世界空间, 基准法线要先做同样的铰链刚体旋转再比较,
    // 否则正常开合会被误报成翻转
    const hingeQuat = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      THREE.MathUtils.degToRad(w.hingeDeg),
    );
    this.detectFlip(this.lid, invertedFaces, strainedFaces, hingeQuat);

    return {
      invertedFaces,
      strainedFaces,
      seamMaxGap: this.measureSeamGap(w.hingeDeg),
    };
  }

  /** 容器壁: rest + 加权目标位移 (硬边点位移场为 0, 底环被 sin 包络钉住) */
  private applySoft(mesh: PartMesh, weights: Record<TargetId, number>) {
    const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
    const n = mesh.base.length / 3;
    for (let k = 0; k < n; k++) {
      let dx = 0;
      let dy = 0;
      let dz = 0;
      for (const t of TARGET_IDS) {
        const wt = weights[t];
        if (wt === 0) continue;
        const d = mesh.deltas[t];
        dx += wt * d[k * 3];
        dy += wt * d[k * 3 + 1];
        dz += wt * d[k * 3 + 2];
      }
      pos.setXYZ(k, mesh.base[k * 3] + dx, mesh.base[k * 3 + 1] + dy, mesh.base[k * 3 + 2] + dz);
    }
    pos.needsUpdate = true;
  }

  /**
   * 盖子: 先在局部空间做软变形 + 软垂(flex),
   * 再整体绕铰链做刚体旋转。折边硬边不参与软变形, 只随刚体运动。
   */
  private applyLid(w: Weights) {
    const mesh = this.lid;
    const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
    const n = mesh.base.length / 3;
    const angle = THREE.MathUtils.degToRad(w.hingeDeg);
    const hingeR = this.hingePivot.x;
    const droop = w.flex * Math.sin(angle) * 0.35;

    for (let k = 0; k < n; k++) {
      let dx = 0;
      let dy = 0;
      let dz = 0;
      for (const t of TARGET_IDS) {
        const wt = w.lid[t];
        if (wt === 0) continue;
        const d = mesh.deltas[t];
        dx += wt * d[k * 3];
        dy += wt * d[k * 3 + 1];
        dz += wt * d[k * 3 + 2];
      }
      const lx = mesh.base[k * 3] + dx;
      let ly = mesh.base[k * 3 + 1] + dy;
      const lz = mesh.base[k * 3 + 2] + dz;

      // 软垂: 离铰链越远、越靠近盖心(非硬边)下垂越多
      if (!mesh.hardEdge[k] && droop !== 0) {
        const v = mesh.params[k * 2 + 1];
        const softMask = THREE.MathUtils.clamp((1 - v) / 0.15, 0, 1);
        const distFromHinge = THREE.MathUtils.clamp((hingeR - lx) / (2 * hingeR), 0, 1);
        ly -= droop * distFromHinge * softMask;
      }

      // 刚体开合: 绕世界 Z 轴、过铰链点旋转, 再抬到接缝高度
      const rx = lx - hingeR;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const wx = this.hingePivot.x + rx * cos - ly * sin;
      const wy = this.wallHeight + rx * sin + ly * cos;
      pos.setXYZ(k, wx, wy, lz);
    }
    pos.needsUpdate = true;
  }

  /**
   * 重算法线: 硬边顶点只累计折边面的法线, 软区顶点只累计软面,
   * 两区交界处因此保留一条明确折痕, 折边内部仍平滑。
   */
  private recomputeNormals(mesh: PartMesh) {
    const geo = mesh.geometry;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const index = geo.getIndex()!;
    const n = pos.count;
    const normals = new Float32Array(n * 3);
    const faceN: THREE.Vector3[] = [];
    const triCount = index.count / 3;

    for (let f = 0; f < triCount; f++) {
      const ia = index.getX(f * 3);
      const ib = index.getX(f * 3 + 1);
      const ic = index.getX(f * 3 + 2);
      this.tmpA.fromBufferAttribute(pos, ia);
      this.tmpB.fromBufferAttribute(pos, ib);
      this.tmpC.fromBufferAttribute(pos, ic);
      const fn = new THREE.Vector3()
        .subVectors(this.tmpB, this.tmpA)
        .cross(new THREE.Vector3().subVectors(this.tmpC, this.tmpA));
      if (fn.lengthSq() >= 1e-12) fn.normalize(); // 退化面保留零向量占位, 索引仍对齐
      faceN.push(fn);
      const faceHard = mesh.hardEdge[ia] === 1 && mesh.hardEdge[ib] === 1 && mesh.hardEdge[ic] === 1;
      for (const vi of [ia, ib, ic]) {
        // 硬边顶点不收软面法线, 软顶点不收硬面法线 -> 边界折痕
        if (faceHard !== (mesh.hardEdge[vi] === 1)) continue;
        normals[vi * 3] += fn.x;
        normals[vi * 3 + 1] += fn.y;
        normals[vi * 3 + 2] += fn.z;
      }
    }
    for (let k = 0; k < n; k++) {
      let l = Math.hypot(normals[k * 3], normals[k * 3 + 1], normals[k * 3 + 2]);
      if (l < 1e-12) {
        // 折痕隔离导致零法线: 回退到该顶点参与的任一面法线, 避免发黑
        const fallback = this.fallbackNormal(mesh, k);
        normals[k * 3] = fallback.x;
        normals[k * 3 + 1] = fallback.y;
        normals[k * 3 + 2] = fallback.z;
        l = fallback.length() || 1;
      }
      normals[k * 3] /= l;
      normals[k * 3 + 1] /= l;
      normals[k * 3 + 2] /= l;
    }
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  }

  private fallbackNormal(mesh: PartMesh, vertex: number): THREE.Vector3 {
    const index = mesh.geometry.getIndex()!;
    const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
    for (let f = 0; f < index.count; f += 3) {
      const tri = [index.getX(f), index.getX(f + 1), index.getX(f + 2)];
      if (!tri.includes(vertex)) continue;
      this.tmpA.fromBufferAttribute(pos, tri[0]);
      this.tmpB.fromBufferAttribute(pos, tri[1]);
      this.tmpC.fromBufferAttribute(pos, tri[2]);
      const n = new THREE.Vector3()
        .subVectors(this.tmpB, this.tmpA)
        .cross(new THREE.Vector3().subVectors(this.tmpC, this.tmpA));
      if (n.lengthSq() >= 1e-12) return n.normalize();
    }
    return new THREE.Vector3(0, 1, 0);
  }

  private computeFaceNormals(mesh: PartMesh, positions: Float32Array): THREE.Vector3[] {
    const index = mesh.geometry.getIndex()!;
    const triCount = index.count / 3;
    const out: THREE.Vector3[] = [];
    for (let f = 0; f < triCount; f++) {
      const ia = index.getX(f * 3);
      const ib = index.getX(f * 3 + 1);
      const ic = index.getX(f * 3 + 2);
      const a = new THREE.Vector3(positions[ia * 3], positions[ia * 3 + 1], positions[ia * 3 + 2]);
      const b = new THREE.Vector3(positions[ib * 3], positions[ib * 3 + 1], positions[ib * 3 + 2]);
      const c = new THREE.Vector3(positions[ic * 3], positions[ic * 3 + 1], positions[ic * 3 + 2]);
      out.push(new THREE.Vector3().subVectors(b, a).cross(c.sub(a)).normalize());
    }
    return out;
  }

  /** 翻面判定: 当前面法线与(经刚体变换的)初始法线点积 <0 为翻转, <0.35 为危险 */
  private detectFlip(
    mesh: PartMesh,
    inverted: Record<PartId, number[]>,
    strained: Record<PartId, number[]>,
    rigidRotation: THREE.Quaternion | null,
  ) {
    const geo = mesh.geometry;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const index = geo.getIndex()!;
    const triCount = index.count / 3;
    const baseN = this.baseFaceNormals[mesh.id];
    const rotatedBase = new THREE.Vector3();

    for (let f = 0; f < triCount; f++) {
      const ia = index.getX(f * 3);
      const ib = index.getX(f * 3 + 1);
      const ic = index.getX(f * 3 + 2);
      this.tmpA.fromBufferAttribute(pos, ia);
      this.tmpB.fromBufferAttribute(pos, ib);
      this.tmpC.fromBufferAttribute(pos, ic);
      const fn = new THREE.Vector3()
        .subVectors(this.tmpB, this.tmpA)
        .cross(new THREE.Vector3().subVectors(this.tmpC, this.tmpA));
      if (fn.lengthSq() < 1e-12) continue; // 退化面不参与翻转判定
      fn.normalize();
      rotatedBase.copy(baseN[f]);
      if (rigidRotation) rotatedBase.applyQuaternion(rigidRotation);
      const d = fn.dot(rotatedBase);
      if (d < 0) inverted[mesh.id].push(f);
      else if (d < 0.35) strained[mesh.id].push(f);
    }
  }

  /**
   * 接缝间距: 同一 u 索引下, 壁顶圈与盖外圈的世界坐标距离。
   * 铰链闭合时两圈都是硬边/零衰减, 间距应恒为 0。
   */
  private measureSeamGap(hingeDeg: number): number {
    if (hingeDeg > 1e-6) return -1; // 开盖后接缝分离属于预期, 不参与对齐考核
    const wallPos = this.wall.geometry.attributes.position as THREE.BufferAttribute;
    const lidPos = this.lid.geometry.attributes.position as THREE.BufferAttribute;
    const N = this.radialSeg;
    let maxGap = 0;
    const wallTopStart = wallPos.count - N;
    const lidRimStart = lidPos.count - N;
    for (let i = 0; i < N; i++) {
      this.tmpA.fromBufferAttribute(wallPos, wallTopStart + i);
      this.tmpB.fromBufferAttribute(lidPos, lidRimStart + i);
      maxGap = Math.max(maxGap, this.tmpA.distanceTo(this.tmpB));
    }
    return maxGap;
  }

  /** 取某顶点当前世界坐标 */
  getWorldPosition(part: PartId, vertex: number, out: THREE.Vector3): THREE.Vector3 {
    const mesh = part === 'wall' ? this.wall : this.lid;
    const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
    return out.fromBufferAttribute(pos, vertex);
  }

  /**
   * 取某顶点未变形时的世界坐标(rest 姿态):
   * 壁顶点即 base; 盖顶点要做与当前开合角相同的刚体变换,
   * 保证“变形前/后”在同一坐标系下可比。
   */
  getRestWorldPosition(part: PartId, vertex: number, hingeDeg: number, out: THREE.Vector3): THREE.Vector3 {
    const mesh = part === 'wall' ? this.wall : this.lid;
    const lx = mesh.base[vertex * 3];
    const ly = mesh.base[vertex * 3 + 1];
    const lz = mesh.base[vertex * 3 + 2];
    if (part === 'wall') return out.set(lx, ly, lz);
    const angle = THREE.MathUtils.degToRad(hingeDeg);
    const rx = lx - this.hingePivot.x;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return out.set(
      this.hingePivot.x + rx * cos - ly * sin,
      this.wallHeight + rx * sin + ly * cos,
      lz,
    );
  }

  /** 取某顶点在某目标上的局部位移贡献(未加权)与当前加权贡献 */
  getTargetContribution(part: PartId, vertex: number, target: TargetId, weight: number): THREE.Vector3 {
    const mesh = part === 'wall' ? this.wall : this.lid;
    const d = mesh.deltas[target];
    return new THREE.Vector3(
      weight * d[vertex * 3],
      weight * d[vertex * 3 + 1],
      weight * d[vertex * 3 + 2],
    );
  }
}
