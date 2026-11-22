import type { MeshData, Vec3 } from '../core/types';

export type SampleId = 'cracked-panel' | 'double-layer' | 'open-box' | 'torn-sheet' | 'bad-topology';

export interface SampleInfo {
  id: SampleId;
  name: string;
  description: string;
  expectation: string;
}

export const SAMPLES: SampleInfo[] = [
  {
    id: 'cracked-panel',
    name: '开裂平板 · 可补接缝',
    description:
      '左右两块平板沿锯齿接缝靠近，缝隙宽 0.03；两块使用完全独立的顶点编号，缝隙两侧顶点一一对应。',
    expectation: '框选两条接缝 → 预览 → 写入后自由边减少，接缝两侧的面共享顶点。',
  },
  {
    id: 'double-layer',
    name: '双层片 · 禁止合并',
    description:
      '上下两块平板间距 0.004，边界顶点在容差内一一对应，但两块底面朝向相反（这是两层，不是裂口）。',
    expectation: '候选点会全部“匹配上”，但写入前检查必须以“会把两层焊死”为由禁止写入。',
  },
  {
    id: 'open-box',
    name: '开口盒 · 有意保留的洞',
    description: '完整闭合的盒体，只缺顶盖；顶部一圈自由边是设计上要保留的开口。',
    expectation: '验证合并后重查，以及把顶洞标记为“有意保留”。',
  },
  {
    id: 'bad-topology',
    name: '缺陷网格 · 非流形与朝向',
    description:
      '一块中间面被翻转的平板，还在共享边上粘了一片“鳍”。用来检查共享边超过两面、面朝向不一致，以及点击边查看真实邻面。',
    expectation: '自由边 / 邻面>2 / 朝向 三个页签都应有内容；这类问题不是补缝能解决的。',
  },
  {
    id: 'torn-sheet',
    name: '撕裂薄片 · 错位/缺点/多候选',
    description:
      '右片接缝整体错开半行，造成一个顶点有多个候选；右片顶部还短了一截，造成左片顶部顶点没有对应点。',
    expectation: '冲突必须先保留出来，由人工剔除候选或跳过顶点，不能自动静默决定。',
  },
];

export function buildSample(id: SampleId): MeshData {
  switch (id) {
    case 'cracked-panel':
      return crackedPanel();
    case 'double-layer':
      return doubleLayer();
    case 'open-box':
      return openBox();
    case 'torn-sheet':
      return tornSheet();
    case 'bad-topology':
      return badTopology();
    default:
      throw new Error(`未知样例: ${id as string}`);
  }
}

/* ---------------------------------------------------------------- *
 * 开裂平板
 * 左块 x ∈ [-1, 0]，右块 x ∈ [0.03, 1.03]。
 * 接缝列在 z 方向做锯齿偏移，两个块使用独立的顶点编号。
 * ---------------------------------------------------------------- */
function crackedPanel(): MeshData {
  const positions: number[] = [];
  const indices: number[] = [];
  const rows = 8;
  const gap = 0.03;
  const zBottom = -1;
  const zTop = 1;
  const seamZ = (i: number) => (i % 2 === 0 ? 0.16 : -0.16);

  const grid = (x0: number, x1: number, seamOnRight: boolean, seamOffset: (i: number) => number): number[][] => {
    const ids: number[][] = [];
    for (let r = 0; r <= rows; r++) {
      const z = zBottom + ((zTop - zBottom) * r) / rows;
      const row: number[] = [];
      for (let c = 0; c < 2; c++) {
        const x = c === 0 ? x0 : x1;
        const onSeam = seamOnRight ? c === 1 : c === 0;
        row.push(positions.length / 3);
        positions.push(x, 0, onSeam ? z + seamOffset(r) : z);
      }
      ids.push(row);
    }
    return ids;
  };

  const left = grid(-1, 0, true, seamZ);
  for (let r = 0; r < rows; r++) {
    const a = left[r][0];
    const b = left[r][1];
    const d = left[r + 1][0];
    const e = left[r + 1][1];
    indices.push(a, d, b, b, d, e);
  }

  const right = grid(gap, 1.03, false, seamZ);
  for (let r = 0; r < rows; r++) {
    const a = right[r][0];
    const b = right[r][1];
    const d = right[r + 1][0];
    const e = right[r + 1][1];
    // 与左块相同的绕向，保证两块的 +y 法线一致
    indices.push(a, d, b, b, d, e);
  }

  return { positions, indices };
}

/* ---------------------------------------------------------------- *
 * 双层片：两块间距 0.004 的平板，法线相反。
 * ---------------------------------------------------------------- */
function doubleLayer(): MeshData {
  const positions: number[] = [];
  const indices: number[] = [];
  const n = 4;
  const gap = 0.004;
  const half = 1;

  const sheet = (y: number, flip: boolean): number[][] => {
    const ids: number[][] = [];
    for (let i = 0; i <= n; i++) {
      const row: number[] = [];
      for (let j = 0; j <= n; j++) {
        row.push(positions.length / 3);
        positions.push(-half + (2 * half * i) / n, y, -half + (2 * half * j) / n);
      }
      ids.push(row);
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const a = ids[i][j];
        const b = ids[i + 1][j];
        const c = ids[i][j + 1];
        const d = ids[i + 1][j + 1];
        if (flip) indices.push(a, c, b, b, c, d);
        else indices.push(a, b, c, b, d, c);
      }
    }
    return ids;
  };

  sheet(gap, true); // 顶面朝 +y
  sheet(0, false); // 底面朝 -y
  return { positions, indices };
}

/* ---------------------------------------------------------------- *
 * 开口盒：8 个角点共享，缺顶盖。
 * ---------------------------------------------------------------- */
function openBox(): MeshData {
  const s = 1;
  const positions: number[] = [];
  const indices: number[] = [];
  const p = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
  const corners: Vec3[] = [
    p(-s, -s, -s), // b0
    p(s, -s, -s), // b1
    p(s, -s, s), // b2
    p(-s, -s, s), // b3
    p(-s, s, -s), // t4
    p(s, s, -s), // t5
    p(s, s, s), // t6
    p(-s, s, s), // t7
  ];
  for (const c of corners) positions.push(c.x, c.y, c.z);
  const quad = (a: number, b: number, c: number, d: number) => {
    indices.push(a, b, c, a, c, d);
  };
  quad(0, 1, 2, 3); // 底，-y
  quad(3, 2, 6, 7); // 前，+z
  quad(1, 0, 4, 5); // 后，-z
  quad(0, 3, 7, 4); // 左，-x
  quad(2, 1, 5, 6); // 右，+x
  return { positions, indices };
}

/* ---------------------------------------------------------------- *
 * 撕裂薄片：左片接缝 9 个点（z 均匀），右片接缝 8 个点且整体偏移半行。
 *  - 左片 z=-0.25 处没有对应点（缺一个点）
 *  - 左片 z=0.25 / 0.5 处各有 2 个候选（多候选）
 * 建议容差 0.14。
 * ---------------------------------------------------------------- */
function tornSheet(): MeshData {
  const positions: number[] = [];
  const indices: number[] = [];
  const gap = 0.02;
  const leftSeamZ = [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1];
  const rightSeamZ = [-0.95, -0.7, -0.45, 0.05, 0.3, 0.375, 0.55, 0.8];

  const left: number[][] = [];
  for (const z of leftSeamZ) {
    const row: number[] = [];
    for (let c = 0; c < 2; c++) {
      row.push(positions.length / 3);
      positions.push(c === 0 ? -1 : 0, 0, z);
    }
    left.push(row);
  }
  for (let r = 0; r + 1 < left.length; r++) {
    const a = left[r][0];
    const b = left[r][1];
    const d = left[r + 1][0];
    const e = left[r + 1][1];
    indices.push(a, d, b, b, d, e);
  }

  const right: number[][] = [];
  for (const z of rightSeamZ) {
    const row: number[] = [];
    for (let c = 0; c < 2; c++) {
      row.push(positions.length / 3);
      positions.push(c === 0 ? gap : 1.02, 0, z);
    }
    right.push(row);
  }
  for (let r = 0; r + 1 < right.length; r++) {
    const a = right[r][0];
    const b = right[r][1];
    const d = right[r + 1][0];
    const e = right[r + 1][1];
    indices.push(a, d, b, b, d, e);
  }

  return { positions, indices };
}

/* ---------------------------------------------------------------- *
 * 缺陷网格：中间三角形翻转 + 共享边上粘一片鳍（3 个面共用该边）
 * ---------------------------------------------------------------- */
function badTopology(): MeshData {
  const positions = [
    -1, 0, -1, // 0
    0, 0, -1, // 1
    0, 0, 1, // 2
    -1, 0, 1, // 3
    0, 1.2, 0.3, // 4 鳍尖
  ];
  const indices = [
    0, 1, 2, // A：面内沿 2 -> 0 使用边 0-2
    0, 3, 2, // B：与 A 同向使用边 0-2（朝向冲突），且几何上叠在同一侧
    0, 2, 4, // C：鳍，沿 0 -> 2 使用边 0-2（该边共 3 个面）
  ];
  return { positions, indices };
}

/** 内置样例转成 OBJ 文本（用于演示“导出后重新打开”）。 */
export function sampleObjText(id: SampleId): string {
  const mesh = buildSample(id);
  const lines: string[] = [`# sample: ${id}`];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    lines.push(`v ${mesh.positions[i]} ${mesh.positions[i + 1]} ${mesh.positions[i + 2]}`);
  }
  for (let i = 0; i < mesh.indices.length; i += 3) {
    lines.push(`f ${mesh.indices[i] + 1} ${mesh.indices[i + 1] + 1} ${mesh.indices[i + 2] + 1}`);
  }
  return lines.join('\n') + '\n';
}
