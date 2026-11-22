import type { MeshData } from './types';

export interface ObjParseResult {
  mesh: MeshData;
  errors: string[];
  warnings: string[];
  /** 源文件里出现过的对象/组名，用于显示 */
  objects: string[];
  /** 原始面中非三角面的数量（已扇形三角化） */
  nontriFaceCount: number;
  /** 解析到的 vn/vt 数量（本工具不使用，仅提示） */
  normalCount: number;
  texcoordCount: number;
}

/**
 * 解析 OBJ 文本。
 * - 只提取 v 与 f；vn/vt/材质等忽略。
 * - 面支持多边形（扇形三角化）与负索引。
 * - 顶点位置按出现顺序保存，索引从 0 开始。
 * 注意：OBJ 里同一个几何位置可以被多个 `v` 行重复声明；本工具保留这些重复顶点，
 * 不做自动焊接，因为“几何重合”和“共享顶点”必须区分开。
 */
export function parseObj(text: string): ObjParseResult {
  const positions: number[] = [];
  const indices: number[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const objects: string[] = [];
  let nontriFaceCount = 0;
  let normalCount = 0;
  let texcoordCount = 0;
  let lineNo = 0;

  const lines = text.split(/\r?\n/);
  for (let li = 0; li < lines.length; li++) {
    lineNo = li + 1;
    let line = lines[li];
    const hash = line.indexOf('#');
    if (hash >= 0) line = line.slice(0, hash);
    line = line.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const tag = parts[0];
    if (tag === 'v') {
      if (parts.length < 4) {
        errors.push(`第 ${lineNo} 行: v 需要 3 个坐标`);
        continue;
      }
      const x = Number(parts[1]);
      const y = Number(parts[2]);
      const z = Number(parts[3]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        errors.push(`第 ${lineNo} 行: 顶点坐标不是有效数字`);
        continue;
      }
      positions.push(x, y, z);
    } else if (tag === 'f') {
      if (parts.length < 4) {
        errors.push(`第 ${lineNo} 行: 面至少需要 3 个顶点`);
        continue;
      }
      const vertexCount = positions.length / 3;
      const faceVerts: number[] = [];
      let bad = false;
      for (let i = 1; i < parts.length; i++) {
        const token = parts[i];
        if (!token) continue;
        const rawIndex = Number(token.split('/')[0]);
        if (!Number.isInteger(rawIndex) || rawIndex === 0) {
          errors.push(`第 ${lineNo} 行: 无效的面索引 "${token}"`);
          bad = true;
          break;
        }
        const idx = rawIndex > 0 ? rawIndex - 1 : vertexCount + rawIndex;
        if (idx < 0 || idx >= vertexCount) {
          errors.push(`第 ${lineNo} 行: 面索引 ${rawIndex} 超出顶点范围（当前 ${vertexCount} 个顶点）`);
          bad = true;
          break;
        }
        faceVerts.push(idx);
      }
      if (bad) continue;
      if (faceVerts.length > 3) nontriFaceCount++;
      for (let i = 1; i + 1 < faceVerts.length; i++) {
        indices.push(faceVerts[0], faceVerts[i], faceVerts[i + 1]);
      }
    } else if (tag === 'vn') {
      normalCount++;
    } else if (tag === 'vt') {
      texcoordCount++;
    } else if (tag === 'o' || tag === 'g') {
      const name = parts.slice(1).join(' ');
      if (name && !objects.includes(name)) objects.push(name);
    }
  }

  if (positions.length === 0) warnings.push('OBJ 中没有顶点 (v)');
  if (indices.length === 0) warnings.push('OBJ 中没有面 (f)');
  if (normalCount > 0) warnings.push(`忽略了 ${normalCount} 条法线 (vn)；工具会按面拓扑重算法线`);
  if (texcoordCount > 0) warnings.push(`忽略了 ${texcoordCount} 条纹理坐标 (vt)`);

  return {
    mesh: { positions, indices },
    errors,
    warnings,
    objects,
    nontriFaceCount,
    normalCount,
    texcoordCount,
  };
}

export interface ObjWriteOptions {
  /** 每行的注释头，可写来源/说明 */
  header?: string[];
  /** 小数位数，默认 6 */
  precision?: number;
  /** 顶点位置是否保留原始编号顺序（本工具始终保留，不做重排） */
  objectName?: string;
}

/**
 * 写出 OBJ。顶点顺序与索引关系原样保留，便于重新打开时编号可对照。
 * 同时写出顶点法线与面法线注释，便于在其它软件中查看朝向。
 */
export function writeObj(mesh: MeshData, options: ObjWriteOptions = {}): string {
  const precision = options.precision ?? 9;
  const fmt = (x: number): string => {
    if (Object.is(x, -0)) x = 0;
    const s = x.toFixed(precision);
    // 去掉多余的 0，但保留至少一位小数
    return s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '.0');
  };
  const out: string[] = [];
  out.push('# mesh-seam-inspector OBJ export');
  out.push(`# vertices: ${Math.floor(mesh.positions.length / 3)}  triangles: ${Math.floor(mesh.indices.length / 3)}`);
  for (const line of options.header ?? []) out.push(`# ${line}`);
  if (options.objectName) out.push(`o ${options.objectName}`);
  const n = Math.floor(mesh.positions.length / 3);
  for (let i = 0; i < n; i++) {
    out.push(`v ${fmt(mesh.positions[i * 3])} ${fmt(mesh.positions[i * 3 + 1])} ${fmt(mesh.positions[i * 3 + 2])}`);
  }
  const faces = Math.floor(mesh.indices.length / 3);
  for (let f = 0; f < faces; f++) {
    const a = mesh.indices[f * 3] + 1;
    const b = mesh.indices[f * 3 + 1] + 1;
    const c = mesh.indices[f * 3 + 2] + 1;
    out.push(`f ${a} ${b} ${c}`);
  }
  return out.join('\n') + '\n';
}
