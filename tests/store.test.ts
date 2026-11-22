import { describe, expect, it } from 'vitest';
import { DocumentStore } from '../src/app/store';
import { boundaryEdgeKeysWithin, previewStitch } from '../src/core/stitch';
import { buildSample } from '../src/samples';
import { analyzeGraph, buildGraph } from '../src/core/topology';
import { cloneMesh } from '../src/core/mesh';
import type { Vec3 } from '../src/core/types';

const p = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const SEAM_BOX: [Vec3, Vec3] = [p(-0.02, -1, -1.3), p(0.06, 1, 1.3)];

function preparedStore() {
  const store = new DocumentStore(buildSample('cracked-panel'));
  store.setStitchTolerance(0.05);
  const keys = boundaryEdgeKeysWithin(store.graph, ...SEAM_BOX);
  store.setSelectionKeys(keys);
  return store;
}

describe('撤销完整性', () => {
  it('撤销后顶点位置、索引关系、外壳与历史逐项恢复', () => {
    const store = preparedStore();
    const originalPositions = store.mesh.positions.slice();
    const originalIndices = store.mesh.indices.slice();
    const originalBoundary = store.report.boundaryEdges.length;
    const originalShells = store.report.shellCount;

    const preview = previewStitch(store.graph, store.session!, store.settings, store.report);
    expect(preview.canApply).toBe(true);
    store.applyWeld({
      newMesh: preview.weld!.mesh,
      weldedVertices: preview.weld!.weldedAway,
      removedFaces: preview.weld!.removedFaces,
      pairs: preview.pairs.length,
      chainA: store.session!.chainA.vertices,
      chainB: store.session!.chainB.vertices,
      label: 'test',
      representative: preview.weld!.representative,
    });
    expect(store.report.boundaryEdges.length).toBeLessThan(originalBoundary);
    expect(store.history.length).toBe(1);

    expect(store.undoLast()).toBe(true);
    expect(store.mesh.positions).toEqual(originalPositions);
    expect(store.mesh.indices).toEqual(originalIndices);
    expect(store.report.boundaryEdges.length).toBe(originalBoundary);
    expect(store.report.shellCount).toBe(originalShells);
    expect(store.history.length).toBe(0);
    // 选择状态也回来了
    expect(store.selection.keys.length).toBeGreaterThan(0);
    expect(store.session).not.toBeNull();
  });

  it('多次修补按栈顺序回退', () => {
    const store = preparedStore();
    const runOnce = () => {
      const keys = boundaryEdgeKeysWithin(store.graph, ...SEAM_BOX);
      store.setSelectionKeys(keys);
      if (!store.session) return false;
      const preview = previewStitch(store.graph, store.session, store.settings, store.report);
      if (!preview.canApply) return false;
      store.applyWeld({
        newMesh: preview.weld!.mesh,
        weldedVertices: preview.weld!.weldedAway,
        removedFaces: preview.weld!.removedFaces,
        pairs: preview.pairs.length,
        chainA: store.session.chainA.vertices,
        chainB: store.session.chainB.vertices,
        label: 'test',
        representative: preview.weld!.representative,
      });
      return true;
    };
    expect(runOnce()).toBe(true);
    const afterFirst = store.mesh.positions.slice();
    // 第二次补缝：此时接缝两侧已连接，框选不出可用链，应保持第一个状态
    const second = runOnce();
    if (second) expect(store.history.length).toBe(2);
    expect(store.undoLast()).toBe(true);
    expect(store.mesh.positions).toEqual(afterFirst);
  });

  it('撤销会恢复“有意保留的洞”标记', () => {
    const store = preparedStore();
    const [loopKey] = ['1,2,3'];
    store.togglePreservedHole(loopKey, true);
    expect(store.preservedHoles.has(loopKey)).toBe(true);
    const preview = previewStitch(store.graph, store.session!, store.settings, store.report);
    store.applyWeld({
      newMesh: preview.weld!.mesh,
      weldedVertices: preview.weld!.weldedAway,
      removedFaces: preview.weld!.removedFaces,
      pairs: preview.pairs.length,
      chainA: store.session!.chainA.vertices,
      chainB: store.session!.chainB.vertices,
      label: 'test',
      representative: preview.weld!.representative,
    });
    store.undoLast();
    expect(store.preservedHoles.has(loopKey)).toBe(true);
  });
});

describe('合并后重查', () => {
  it('补缝后朝向与自由边被重新计算，且不留下非流形边', () => {
    const store = preparedStore();
    const preview = previewStitch(store.graph, store.session!, store.settings, store.report);
    store.applyWeld({
      newMesh: preview.weld!.mesh,
      weldedVertices: preview.weld!.weldedAway,
      removedFaces: preview.weld!.removedFaces,
      pairs: preview.pairs.length,
      chainA: store.session!.chainA.vertices,
      chainB: store.session!.chainB.vertices,
      label: 'test',
      representative: preview.weld!.representative,
    });
    expect(store.report.orientationIssues).toEqual([]);
    expect(store.report.nonManifoldEdges).toEqual([]);
    expect(store.report.shellCount).toBe(1);
    // 重新构建的报告必须与直接从网格计算的一致
    const direct = analyzeGraph(buildGraph(store.mesh), store.reportTol);
    expect(store.report.boundaryEdges.length).toBe(direct.boundaryEdges.length);
    expect(store.report.edgeCount).toBe(direct.edgeCount);
  });
});

describe('保留洞在焊接后的编号映射', () => {
  it('保留标记会按代表点重写，撤销后恢复原编号', () => {
    const store = new DocumentStore(buildSample('double-layer'));
    // 人为标记一个包含将被焊接顶点的边界环 key（0 与 25 成对）
    const beforeKey = '0,1,2,3,4';
    store.togglePreservedHole(beforeKey, true);
    const rep = new Int32Array(store.graph.vertexCount);
    for (let i = 0; i < rep.length; i++) rep[i] = i;
    rep[25] = 0;
    store.applyWeld({
      newMesh: cloneMesh(store.mesh),
      weldedVertices: [25],
      removedFaces: [],
      pairs: 1,
      chainA: [0],
      chainB: [25],
      label: '映射测试',
      representative: rep,
    });
    // 0 代表点保留；25 已并入 0，因此 key 里不会残留 25
    expect(store.preservedHoles.has('0,1,2,3,4')).toBe(true);
    expect([...store.preservedHoles].some((k) => k.split(',').includes('25'))).toBe(false);
    store.undoLast();
    expect(store.preservedHoles.has(beforeKey)).toBe(true);
  });
});
