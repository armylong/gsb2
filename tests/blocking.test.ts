import { describe, expect, it } from 'vitest';
import { analyzeGraph, buildGraph, edgeKey } from '../src/core/topology';
import {
  DEFAULT_SETTINGS,
  previewStitch,
  resolvePairing,
  type BoundaryChain,
  type Candidate,
  type StitchSession,
} from '../src/core/stitch';
import type { MeshData } from '../src/core/types';

/** 手工构造一条链，模拟“框选只取到一部分边界”的情况。 */
function fakeChain(id: string, vertices: number[], closed = false): BoundaryChain {
  const edgeKeys: string[] = [];
  for (let i = 0; i + 1 < vertices.length; i++) edgeKeys.push(edgeKey(vertices[i], vertices[i + 1]));
  if (closed && vertices.length >= 3) edgeKeys.push(edgeKey(vertices[vertices.length - 1], vertices[0]));
  return { id, vertices, edgeKeys, closed, length: vertices.length };
}

function fakeSession(
  chainA: BoundaryChain,
  chainB: BoundaryChain,
  candidates: Candidate[],
  tol = 0.01,
): StitchSession {
  return {
    chainA,
    chainB,
    tol,
    candidates,
    excluded: new Set(),
    skipped: new Set(),
    issues: [],
  };
}

function mesh(positions: number[], indices: number[]): MeshData {
  return { positions, indices };
}

describe('写入前阻断：压扁', () => {
  it('焊接会把三角形两角并到同一顶点时，禁止写入', () => {
    // 面 F2=(0,3,6) 同时含有 v0 和 v3；把 0 与 3 焊在一起会让 F2 退化
    const m = mesh(
      [
        0, 0, 0, // 0
        1, 0, 0, // 1
        0, 1, 0, // 2
        0.001, 0, 0, // 3
        1.001, 0, 0, // 4
        0.001, 1, 0, // 5
        0.5, 1, 0.5, // 6
      ],
      [0, 1, 2, 3, 4, 5, 0, 3, 6],
    );
    const g = buildGraph(m);
    const report = analyzeGraph(g, 0.01);
    const session = fakeSession(fakeChain('A', [0]), fakeChain('B', [3]), [
      { a: 0, b: 3, distance: 0.001 },
    ]);
    const preview = previewStitch(g, session, { ...DEFAULT_SETTINGS, tol: 0.01 }, report);
    expect(preview.canApply).toBe(false);
    const collapse = preview.checks.find((c) => c.id === 'collapse')!;
    expect(collapse.status).toBe('fail');
    expect(preview.weld!.removedFaces.length).toBeGreaterThan(0);
  });
});

describe('写入前阻断：邻面过多', () => {
  it('焊接后一条边会被 3 个面使用，禁止写入', () => {
    // 面 F0=(0,1,2)、F1=(1,0,3) 共享边 0-1；F2=(4,5,6) 焊接后变成 (0,1,6)
    const m = mesh(
      [
        0, 0, 0, // 0
        1, 0, 0, // 1
        0.5, 1, 0, // 2
        0.5, -1, 0, // 3
        0.001, 0.001, 0.001, // 4
        1.001, 0.001, 0.001, // 5
        0.5, 0, 1, // 6
      ],
      [0, 1, 2, 1, 0, 3, 4, 5, 6],
    );
    const g = buildGraph(m);
    const report = analyzeGraph(g, 0.01);
    const session = fakeSession(fakeChain('A', [4, 5]), fakeChain('B', [0, 1]), [
      { a: 4, b: 0, distance: 0.0017 },
      { a: 5, b: 1, distance: 0.0017 },
    ]);
    const preview = previewStitch(g, session, { ...DEFAULT_SETTINGS, tol: 0.01 }, report);
    expect(preview.canApply).toBe(false);
    const manifold = preview.checks.find((c) => c.id === 'manifold')!;
    expect(manifold.status).toBe('fail');
  });
});

describe('写入前阻断：配对交叉', () => {
  it('配对顺序在链上交叉时保留为冲突，不产生配对', () => {
    const chainA = fakeChain('A', [0, 1, 2]);
    const chainB = fakeChain('B', [3, 4, 5]);
    const session = fakeSession(chainA, chainB, [
      { a: 0, b: 4, distance: 1 },
      { a: 1, b: 3, distance: 1 },
      { a: 2, b: 5, distance: 1 },
    ]);
    const pairing = resolvePairing(session);
    expect(pairing.ready).toBe(false);
    expect(pairing.conflicts.some((c) => c.kind === 'crossing')).toBe(true);
    expect(pairing.pairs).toEqual([]);
  });

  it('顺序单调（反向）的配对不算交叉', () => {
    const session = fakeSession(fakeChain('A', [0, 1, 2]), fakeChain('B', [3, 4, 5]), [
      { a: 0, b: 5, distance: 1 },
      { a: 1, b: 4, distance: 1 },
      { a: 2, b: 3, distance: 1 },
    ]);
    const pairing = resolvePairing(session);
    expect(pairing.ready).toBe(true);
    expect(pairing.pairs.length).toBe(3);
  });
});

describe('贴合双层片', () => {
  it('几何完全重合、法线相反的边界对会触发布局阻断', () => {
    // 两片三角形在同一个平面上，相距 0.002，法线相反
    const m = mesh(
      [
        0, 0, 0, 1, 0, 0, 0, 1, 0, // 上层
        0, 0.002, 0, 1, 0.002, 0, 0, 1, 0.002, // 下层
      ],
      [0, 1, 2, 3, 5, 4],
    );
    const g = buildGraph(m);
    const report = analyzeGraph(g, 0.01);
    const session = fakeSession(fakeChain('A', [0, 1]), fakeChain('B', [3, 4]), [
      { a: 0, b: 3, distance: 0.002 },
      { a: 1, b: 4, distance: 0.002 },
    ]);
    const preview = previewStitch(g, session, { ...DEFAULT_SETTINGS, tol: 0.01 }, report);
    expect(preview.canApply).toBe(false);
    expect(preview.checks.find((c) => c.id === 'layers')!.status).toBe('fail');
  });
});
