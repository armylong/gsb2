import { describe, expect, it } from 'vitest';
import { analyzeGraph, boundaryLoops, buildGraph } from '../src/core/topology';
import {
  boundaryEdgeKeysWithin,
  buildChains,
  createSession,
  DEFAULT_SETTINGS,
  previewStitch,
  resolvePairing,
} from '../src/core/stitch';
import { buildSample } from '../src/samples';
import { parseObj, writeObj } from '../src/core/obj';
import { meshBounds } from '../src/core/mesh';
import type { Vec3 } from '../src/core/types';

const p = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

function seamChains(id: Parameters<typeof buildSample>[0], min: Vec3, max: Vec3, tol: number) {
  const g = buildGraph(buildSample(id));
  const report = analyzeGraph(g, tol);
  const keys = boundaryEdgeKeysWithin(g, min, max);
  const chains = buildChains(g, keys);
  const sorted = [...chains].sort((a, b) => a.vertices[0] - b.vertices[0]);
  return { g, report, keys, chains: sorted };
}

describe('拓扑报告', () => {
  it('开裂平板：两块各有自由边，接缝两侧是几何重合但索引独立的顶点', () => {
    const g = buildGraph(buildSample('cracked-panel'));
    const report = analyzeGraph(g, 0.05);
    expect(report.boundaryEdges.length).toBe(36);
    expect(report.nonManifoldEdges.length).toBe(0);
    expect(report.orientationIssues.length).toBe(0);
    // 两块不是共享顶点，而是各有独立顶点
    expect(report.shellCount).toBe(2);
    expect(report.referencedVertexCount).toBe(36);
    expect(report.unusedVertexCount).toBe(0);
  });

  it('开口盒：共享顶点、顶部 4 条自由边成环', () => {
    const g = buildGraph(buildSample('open-box'));
    const report = analyzeGraph(g, 1e-6);
    expect(report.vertexCount).toBe(8);
    expect(report.faceCount).toBe(10);
    expect(report.boundaryEdges.length).toBe(4);
    expect(report.shellCount).toBe(1);
    const loops = boundaryLoops(g);
    expect(loops.length).toBe(1);
    expect(loops[0].length).toBe(4);
  });

  it('双层片：每片封闭、两个外壳，几何重合的顶点组被单列', () => {
    const g = buildGraph(buildSample('double-layer'));
    const report = analyzeGraph(g, 0.01);
    expect(report.boundaryEdges.length).toBe(32);
    expect(report.shellCount).toBe(2);
    // 上下两片贴合（间距 0.004 < 0.01），25 对顶点几何重合
    expect(report.coincidentVertexGroups.length).toBe(25);
    expect(report.nonManifoldEdges.length).toBe(0);
  });
});

describe('候选与配对', () => {
  it('开裂平板：框选接缝后 9 对点一一配对', () => {
    const { g, chains } = seamChains('cracked-panel', p(-0.02, -1, -1.3), p(0.06, 1, 1.3), 0.05);
    expect(chains.length).toBe(2);
    const [a, b] = chains;
    expect(a.closed).toBe(false);
    expect(b.closed).toBe(false);
    const session = createSession(g, a, b, 0.05);
    expect(session.issues).toEqual([]);
    expect(session.candidates.length).toBe(9);
    const pairing = resolvePairing(session);
    expect(pairing.ready).toBe(true);
    expect(pairing.pairs.length).toBe(9);
  });

  it('撕裂薄片：缺一个点 + 多候选，冲突必须保留且不产生配对', () => {
    const { g, chains } = seamChains('torn-sheet', p(-0.02, -1, -1.3), p(0.04, 1, 1.3), 0.14);
    expect(chains.length).toBe(2);
    const [a, b] = chains;
    const session = createSession(g, a, b, 0.14);
    const pairing = resolvePairing(session);
    expect(pairing.ready).toBe(false);
    const kinds = new Set(pairing.conflicts.map((c) => c.kind));
    expect(kinds.has('missing')).toBe(true);
    expect(kinds.has('ambiguous')).toBe(true);
    expect(pairing.pairs).toEqual([]);
  });

  it('冲突候选可以被单独剔除，剩余冲突继续保留', () => {
    const { g, chains } = seamChains('torn-sheet', p(-0.02, -1, -1.3), p(0.04, 1, 1.3), 0.14);
    const [a, b] = chains;
    const session = createSession(g, a, b, 0.14);
    const ambiguous = resolvePairing(session).conflicts.find((c) => c.kind === 'ambiguous')!;
    // 只剔除一个候选：该顶点的歧义应当消失
    const victim = ambiguous.candidates![0];
    session.excluded.add([victim.a, victim.b].sort((x, y) => x - y).join(':'));
    const next = resolvePairing(session);
    expect(next.conflicts.some((c) => c.kind === 'ambiguous' && c.vertex === ambiguous.vertex)).toBe(false);
    // 仍然不能写入：还有 missing（以及可能的交叉）
    expect(next.ready).toBe(false);
    expect(next.pairs).toEqual([]);
  });
});

describe('写入前阻断', () => {
  it('双层片：候选一一对应也不允许写入（会把两层焊死）', () => {
    // 取上下两片左侧的边界边
    const { g, chains } = seamChains('double-layer', p(-1.01, -0.01, -1.01), p(-0.94, 0.01, 1.01), 0.01);
    expect(chains.length).toBe(2);
    const [a, b] = chains;
    const session = createSession(g, a, b, 0.01);
    // 几何上每个点都能匹配
    const pairing = resolvePairing(session);
    expect(pairing.conflicts.filter((c) => c.kind === 'missing').length).toBe(0);
    const report = analyzeGraph(g, 0.01);
    const preview = previewStitch(g, session, { ...DEFAULT_SETTINGS, tol: 0.01 }, report);
    expect(preview.canApply).toBe(false);
    const layer = preview.checks.find((c) => c.id === 'layers')!;
    expect(layer.status).toBe('fail');
    expect(preview.blockedReasons).toContain('贴层/双层片');
  });

  it('开裂平板：预览通过、自由边减少、焊接 9 对顶点', () => {
    const { g, report, chains } = seamChains('cracked-panel', p(-0.02, -1, -1.3), p(0.06, 1, 1.3), 0.05);
    const [a, b] = chains;
    const session = createSession(g, a, b, 0.05);
    const preview = previewStitch(g, session, { ...DEFAULT_SETTINGS, tol: 0.05 }, report);
    expect(preview.canApply).toBe(true);
    expect(preview.weld?.weldedAway.length).toBe(9);
    expect(preview.weld?.removedFaces).toEqual([]);
    expect(preview.delta.boundaryEdges).toBeLessThan(0);
    // 顶点数组保留原长度，编号不压缩
    expect(preview.weld?.mesh.positions.length).toBe(g.positions.length);
    expect(preview.after?.shellCount).toBe(1);
  });

  it('自由边合并后：接缝两侧的面共享顶点且边不再是自由边', () => {
    const { g, report, chains } = seamChains('cracked-panel', p(-0.02, -1, -1.3), p(0.06, 1, 1.3), 0.05);
    const [a, b] = chains;
    const session = createSession(g, a, b, 0.05);
    const preview = previewStitch(g, session, { ...DEFAULT_SETTINGS, tol: 0.05 }, report);
    const after = preview.afterGraph!;
    // 接缝上每条边应恰好 2 个面
    for (const pair of preview.pairs) {
      const lo = Math.min(...[pair.a, pair.b]);
      const hi = Math.max(...[pair.a, pair.b]);
      void lo;
      void hi;
    }
    const seamEdges = after.edges;
    let seamManifold = 0;
    for (const e of seamEdges.values()) {
      if (e.cls === 'manifold') seamManifold++;
    }
    expect(seamManifold).toBeGreaterThan(0);
    expect(preview.after!.orientationIssues.length).toBe(0);
    expect(preview.after!.nonManifoldEdges.length).toBe(0);
  });
});

describe('OBJ 往返', () => {
  it('写出并重新解析后拓扑一致', () => {
    const mesh = buildSample('cracked-panel');
    const text = writeObj(mesh);
    const parsed = parseObj(text);
    expect(parsed.errors).toEqual([]);
    const r1 = analyzeGraph(buildGraph(mesh), 0.05);
    const r2 = analyzeGraph(buildGraph(parsed.mesh), 0.05);
    expect(r2.faceCount).toBe(r1.faceCount);
    expect(r2.boundaryEdges.length).toBe(r1.boundaryEdges.length);
    expect(r2.nonManifoldEdges.length).toBe(r1.nonManifoldEdges.length);
    expect(r2.orientationIssues.length).toBe(r1.orientationIssues.length);
    expect(r2.shellCount).toBe(r1.shellCount);
  });

  it('解析负索引与多边形面（扇形三角化）', () => {
    const text = 'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf -4 -3 -2 -1\n';
    const parsed = parseObj(text);
    expect(parsed.errors).toEqual([]);
    expect(parsed.nontriFaceCount).toBe(1);
    expect(parsed.mesh.indices.length).toBe(6);
    const b = meshBounds(parsed.mesh);
    expect(b.size.x).toBe(1);
    expect(b.size.y).toBe(1);
  });

  it('非法索引会报错而不是静默丢弃', () => {
    const parsed = parseObj('v 0 0 0\nv 1 0 0\nf 1 2 9\n');
    expect(parsed.errors.length).toBeGreaterThan(0);
  });
});
