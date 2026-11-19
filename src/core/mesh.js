// 三角网格核心数据结构与拓扑构建。
// 不依赖 Three.js，浏览器与 Node 测试共用同一份实现。

import {
  sub,
  cross,
  normalize,
  triangleArea,
  angleBetweenUnit,
  radToDeg,
  triDot,
} from './math3d.js';

// 有向边（小端点在前，保证同一条边 key 相同）
export function edgeKey(a, b) {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

export class TriangleMesh {
  // positions: Float64/32 风格的扁平数组或 [x,y,z][]；faces: [[a,b,c], ...]
  constructor(positions, faces, meta = {}) {
    this.positions = positions; // 扁平 number[]，长度 = 顶点数 * 3
    this.faces = faces; // number[][]，每个面 3 个顶点索引
    this.meta = meta; // { fileName, format, warnings: [] }
    this._edges = null;
    this._faceNormals = null;
  }

  get vertexCount() {
    return Math.floor(this.positions.length / 3);
  }

  get faceCount() {
    return this.faces.length;
  }

  vertex(i) {
    const o = i * 3;
    return [this.positions[o], this.positions[o + 1], this.positions[o + 2]];
  }

  // 每个面的三个顶点坐标
  facePoints(fi) {
    const [a, b, c] = this.faces[fi];
    return [this.vertex(a), this.vertex(b), this.vertex(c)];
  }

  faceNormal(fi) {
    const [p0, p1, p2] = this.facePoints(fi);
    return normalize(cross(sub(p1, p0), sub(p2, p0)));
  }

  faceArea(fi) {
    const [p0, p1, p2] = this.facePoints(fi);
    return triangleArea(p0, p1, p2);
  }

  // 面是否退化：索引重复，或几何面积接近 0
  isDegenerate(fi, eps = 1e-10) {
    const [a, b, c] = this.faces[fi];
    if (a === b || b === c || a === c) return true;
    return this.faceArea(fi) <= eps;
  }

  allFaceNormals() {
    if (!this._faceNormals) {
      this._faceNormals = this.faces.map((_, fi) => this.faceNormal(fi));
    }
    return this._faceNormals;
  }

  // 构建边拓扑：
  //   edgeMap:  key -> { a, b, faces: [{face, dir}] }  dir=true 表示面内为 (a->b)
  //   adjacency: 每个面的三条邻接面（按边 ab、bc、ca 顺序；无邻接为 null）
  buildEdges() {
    if (this._edges) return this._edges;
    const edgeMap = new Map();
    const adjacency = this.faces.map(() => [null, null, null]);

    const add = (u, v, fi, slot) => {
      const key = edgeKey(u, v);
      let rec = edgeMap.get(key);
      if (!rec) {
        rec = { a: Math.min(u, v), b: Math.max(u, v), faces: [] };
        edgeMap.set(key, rec);
      }
      rec.faces.push({ face: fi, dir: u === rec.a });
    };

    this.faces.forEach(([a, b, c], fi) => {
      add(a, b, fi, 0);
      add(b, c, fi, 1);
      add(c, a, fi, 2);
    });

    for (const rec of edgeMap.values()) {
      if (rec.faces.length === 2) {
        const [x, y] = rec.faces;
        adjacency[x.face][this._edgeSlot(x.face, rec)] = y.face;
        adjacency[y.face][this._edgeSlot(y.face, rec)] = x.face;
      }
    }

    this._edges = { edgeMap, adjacency };
    return this._edges;
  }

  _edgeSlot(fi, rec) {
    const [a, b, c] = this.faces[fi];
    if (edgeKey(a, b) === edgeKey(rec.a, rec.b)) return 0;
    if (edgeKey(b, c) === edgeKey(rec.a, rec.b)) return 1;
    return 2;
  }

  // 两个相邻面在共享边上的环绕方向是否一致（流形边才有意义）。
  // 一致（一正一反）=> 方向连续；同向 => 方向不连续。
  static edgeOrientedConsistent(rec) {
    if (rec.faces.length !== 2) return null;
    return rec.faces[0].dir !== rec.faces[1].dir;
  }

  // 两面法线夹角（度），用于棱边判定
  dihedralAngleDeg(fi, fj) {
    const n = this.allFaceNormals();
    return radToDeg(angleBetweenUnit(n[fi], n[fj]));
  }

  // 连通分量（按共享边），返回每个面的分量 id
  faceComponents() {
    const { adjacency } = this.buildEdges();
    const comp = new Array(this.faceCount).fill(-1);
    let id = 0;
    for (let start = 0; start < this.faceCount; start++) {
      if (comp[start] !== -1) continue;
      const stack = [start];
      comp[start] = id;
      while (stack.length) {
        const fi = stack.pop();
        for (const nj of adjacency[fi]) {
          if (nj !== null && comp[nj] === -1) {
            comp[nj] = id;
            stack.push(nj);
          }
        }
      }
      id++;
    }
    return comp;
  }

  // 有向体积的 1/6（闭合且方向一致时等于体积），用于判断整体朝外方向
  signedVolume() {
    let v = 0;
    for (let fi = 0; fi < this.faceCount; fi++) {
      const [p0, p1, p2] = this.facePoints(fi);
      v += triDot(p0, p1, p2);
    }
    return v / 6;
  }
}
