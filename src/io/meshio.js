// 网格导入导出。
// 支持：OBJ（顶点/面/法线，多边形扇形三角化并告警）、ASCII STL、二进制 STL。
// 损坏、不支持或没有三角面的输入抛出带 code 的 MeshLoadError，绝不静默返回空模型。

import { TriangleMesh } from '../core/mesh.js';

export class MeshLoadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MeshLoadError';
    this.code = code; // 'unsupported' | 'corrupt' | 'empty' | 'no-triangles'
  }
}

// ---------------- OBJ ----------------

export function parseOBJ(text, fileName = 'model.obj') {
  const warnings = [];
  const positions = [];
  const normalsInFile = [];
  const faces = [];
  const faceNormalIndices = []; // 与 faces 平行：每个角点的 vn 索引（无 vn 时为 null）
  let lineNo = 0;
  let polygonFaceCount = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    lineNo++;
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const tokens = line.split(/\s+/);
    const tag = tokens[0];

    if (tag === 'v') {
      if (tokens.length < 4) {
        throw new MeshLoadError('corrupt', `OBJ 第 ${lineNo} 行顶点数据不足（需要 v x y z）`);
      }
      const xyz = tokens.slice(1, 4).map(Number);
      if (xyz.some((n) => !Number.isFinite(n))) {
        throw new MeshLoadError('corrupt', `OBJ 第 ${lineNo} 行顶点坐标不是有限数值`);
      }
      positions.push(...xyz);
    } else if (tag === 'vn') {
      if (tokens.length < 4) {
        throw new MeshLoadError('corrupt', `OBJ 第 ${lineNo} 行法线数据不足`);
      }
      normalsInFile.push(tokens.slice(1, 4).map(Number));
    } else if (tag === 'f') {
      const verts = [];
      const vnIdx = [];
      for (const tok of tokens.slice(1)) {
        // 只取顶点索引部分：v、v/vt、v//vn、v/vt/vn
        const parts = tok.split('/');
        const viText = parts[0];
        const vi = Number(viText);
        if (!Number.isInteger(vi)) {
          throw new MeshLoadError('corrupt', `OBJ 第 ${lineNo} 行面索引无法解析："${tok}"`);
        }
        verts.push(vi > 0 ? vi - 1 : positions.length / 3 + vi);
        const rawN = parts[2];
        if (rawN === undefined || rawN === '') {
          vnIdx.push(null);
        } else {
          const ni = Number(rawN);
          vnIdx.push(ni > 0 ? ni - 1 : normalsInFile.length + ni);
        }
      }
      if (verts.length < 3) {
        warnings.push(`第 ${lineNo} 行不足 3 个顶点，已跳过`);
        continue;
      }
      if (verts.some((i) => i < 0 || i >= positions.length / 3)) {
        throw new MeshLoadError('corrupt', `OBJ 第 ${lineNo} 行面索引越界`);
      }
      if (vnIdx.some((n) => n !== null && n >= normalsInFile.length)) {
        throw new MeshLoadError('corrupt', `OBJ 第 ${lineNo} 行法线索引越界`);
      }
      if (verts.length > 3) {
        polygonFaceCount++;
        warnings.push(`第 ${lineNo} 行是 ${verts.length} 边形，已按扇形三角化为 ${verts.length - 2} 个三角形（不做拓扑重建）`);
        for (let k = 1; k < verts.length - 1; k++) {
          faces.push([verts[0], verts[k], verts[k + 1]]);
          faceNormalIndices.push([vnIdx[0], vnIdx[k], vnIdx[k + 1]]);
        }
      } else {
        faces.push(verts);
        faceNormalIndices.push(vnIdx);
      }
    }
    // vt、g、o、s、usemtl、mtllib 等标签安全忽略
  }

  if (positions.length === 0) {
    throw new MeshLoadError('empty', '文件中没有任何顶点（v）数据，可能不是有效的 OBJ 网格文件');
  }
  if (faces.length === 0) {
    throw new MeshLoadError('no-triangles', `文件包含 ${positions.length / 3} 个顶点但没有任何三角面，无法进行表面分析`);
  }
  if (polygonFaceCount) {
    warnings.push(`共 ${polygonFaceCount} 个多边形面被扇形三角化`);
  }
  return new TriangleMesh(positions, faces, {
    fileName, format: 'OBJ', warnings, normalsInFile, faceNormalIndices,
  });
}

// ---------------- STL ----------------

export function parseSTL(buffer, fileName = 'model.stl') {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  // ASCII STL 以 solid 开头且包含 facet；二进制 STL 也可能以 solid 开头，需用长度校验
  const head = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.length, 512)));
  const looksAscii = /^\s*solid/i.test(head) && /facet\s+normal/i.test(head);

  if (looksAscii) {
    return parseAsciiSTL(new TextDecoder().decode(bytes), fileName);
  }
  return parseBinarySTL(bytes, fileName);
}

function parseBinarySTL(bytes, fileName) {
  if (bytes.length < 84) {
    throw new MeshLoadError('corrupt', '二进制 STL 长度不足 84 字节，文件已损坏或不是 STL');
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triCount = dv.getUint32(80, true);
  const expected = 84 + triCount * 50;
  if (expected !== bytes.length) {
    throw new MeshLoadError('corrupt',
      `二进制 STL 声明 ${triCount} 个三角形，应有 ${expected} 字节，实际 ${bytes.length} 字节（文件损坏或为 ASCII STL）`);
  }
  const positions = [];
  const faces = [];
  let offset = 84;
  for (let t = 0; t < triCount; t++) {
    offset += 12; // 跳过文件内法线，以几何重新计算
    const base = positions.length / 3;
    for (let k = 0; k < 3; k++) {
      const x = dv.getFloat32(offset, true);
      const y = dv.getFloat32(offset + 4, true);
      const z = dv.getFloat32(offset + 8, true);
      if (![x, y, z].every(Number.isFinite)) {
        throw new MeshLoadError('corrupt', `二进制 STL 第 ${t + 1} 个三角形含非有限坐标`);
      }
      positions.push(x, y, z);
      offset += 12;
    }
    offset += 2; // attribute byte count
    faces.push([base, base + 1, base + 2]);
  }
  if (!faces.length) {
    throw new MeshLoadError('no-triangles', '二进制 STL 声明 0 个三角形，没有可分析的面');
  }
  return new TriangleMesh(positions, faces, {
    fileName, format: 'STL (binary)', warnings: [],
  });
}

function parseAsciiSTL(text, fileName) {
  const positions = [];
  const faces = [];
  const tokens = text.split(/\s+/).filter(Boolean);
  let i = 0;
  let solidSeen = false;
  let triCount = 0;

  while (i < tokens.length) {
    const t = tokens[i].toLowerCase();
    if (t === 'solid') { solidSeen = true; i += 1; continue; }
    if (t === 'endsolid' || t === 'endfacet' || t === 'endloop') { i += 1; continue; }
    if (t === 'facet') {
      // facet normal nx ny nz
      if (tokens[i + 1]?.toLowerCase() !== 'normal') {
        throw new MeshLoadError('corrupt', `ASCII STL 第 ${triCount + 1} 个 facet 缺少 normal 声明`);
      }
      i += 5; // facet normal n n n
      if (tokens[i]?.toLowerCase() !== 'outer') {
        throw new MeshLoadError('corrupt', `ASCII STL 第 ${triCount + 1} 个 facet 缺少 outer loop`);
      }
      i += 2; // outer loop
      const base = positions.length / 3;
      for (let k = 0; k < 3; k++) {
        if (tokens[i]?.toLowerCase() !== 'vertex') {
          throw new MeshLoadError('corrupt', `ASCII STL 第 ${triCount + 1} 个 facet 顶点数据不完整`);
        }
        const xyz = tokens.slice(i + 1, i + 4).map(Number);
        if (xyz.length < 3 || xyz.some((n) => !Number.isFinite(n))) {
          throw new MeshLoadError('corrupt', `ASCII STL 第 ${triCount + 1} 个 facet 顶点坐标损坏`);
        }
        positions.push(...xyz);
        i += 4;
      }
      faces.push([base, base + 1, base + 2]);
      triCount++;
      continue;
    }
    i += 1;
  }

  if (!solidSeen) {
    throw new MeshLoadError('corrupt', 'ASCII STL 缺少 solid 声明，文件已损坏或格式不受支持');
  }
  if (!faces.length) {
    throw new MeshLoadError('no-triangles', 'ASCII STL 中没有任何 facet 三角面');
  }
  return new TriangleMesh(positions, faces, {
    fileName, format: 'STL (ascii)', warnings: [],
  });
}

// ---------------- 统一入口 ----------------

export async function loadMeshFile(file) {
  const name = file.name.toLowerCase();
  const buf = await file.arrayBuffer();
  if (name.endsWith('.obj')) {
    return parseOBJ(new TextDecoder().decode(buf), file.name);
  }
  if (name.endsWith('.stl')) {
    return parseSTL(new Uint8Array(buf), file.name);
  }
  const head = new TextDecoder().decode(new Uint8Array(buf).slice(0, 64));
  if (/^\s*solid/i.test(head) || /^[#\s]*v\s/.test(head)) {
    throw new MeshLoadError('unsupported',
      `扩展名 "${file.name}" 不受支持：仅支持 .obj / .stl，请修改扩展名后重试`);
  }
  throw new MeshLoadError('unsupported',
    `不支持的文件类型 "${file.name}"：本工具只导入 OBJ 与 STL 三角网格`);
}

// ---------------- 导出 ----------------

function formatNum(n) {
  // 足够精度且去掉 -0
  const r = Math.abs(n) < 1e-12 ? 0 : n;
  return r.toFixed(7).replace(/0+$/, '').replace(/\.$/, '');
}

// 导出拆分+法线后的网格为 OBJ；显式 vn 保证其他软件打开时明暗与本工具一致
export function exportOBJ(shaded, sourceName = 'model') {
  const lines = [
    '# 由表面平滑与法线检查工具导出',
    `# 来源: ${sourceName}`,
    `# 显示方式: ${shaded.mode === 'flat' ? '平面 (flat)' : `平滑 (smooth), 棱边临界角 ${shaded.creaseAngleDeg}°`}`,
    `# 顶点: ${shaded.positions.length / 3}  三角面: ${shaded.faces.length}`
      + (shaded.skippedDegenerate.length
        ? `  已剔除退化面: ${shaded.skippedDegenerate.length}` : ''),
  ];
  const { positions, normals, faces } = shaded;
  for (let i = 0; i < positions.length; i += 3) {
    lines.push(`v ${formatNum(positions[i])} ${formatNum(positions[i + 1])} ${formatNum(positions[i + 2])}`);
  }
  for (let i = 0; i < normals.length; i += 3) {
    lines.push(`vn ${formatNum(normals[i])} ${formatNum(normals[i + 1])} ${formatNum(normals[i + 2])}`);
  }
  // 每个新顶点恰好对应一条 vn（索引相同）
  for (const [a, b, c] of faces) {
    lines.push(`f ${a + 1}//${a + 1} ${b + 1}//${b + 1} ${c + 1}//${c + 1}`);
  }
  return lines.join('\n') + '\n';
}

// 导出 ASCII STL（每个三角形独立顶点，法线来自 shaded normals）
export function exportAsciiSTL(shaded, sourceName = 'model') {
  const { positions, normals, faces } = shaded;
  const lines = [`solid ${sourceName.replace(/[^A-Za-z0-9_.-]/g, '_')}`];
  const p = (i) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
  for (const [a, b, c] of faces) {
    const n = [normals[a * 3], normals[a * 3 + 1], normals[a * 3 + 2]];
    lines.push(`  facet normal ${formatNum(n[0])} ${formatNum(n[1])} ${formatNum(n[2])}`);
    lines.push('    outer loop');
    for (const vi of [a, b, c]) {
      const q = p(vi);
      lines.push(`      vertex ${formatNum(q[0])} ${formatNum(q[1])} ${formatNum(q[2])}`);
    }
    lines.push('    endloop');
    lines.push('  endfacet');
  }
  lines.push('endsolid');
  return lines.join('\n') + '\n';
}
