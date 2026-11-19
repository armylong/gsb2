// 网格数据结构与检查器测试：退化面、反向面、方向不连续、非流形、边界、重复顶点。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectMesh, ISSUE_TYPES } from '../src/core/inspect.js';
import {
  makeCube, makeTetraWithReversedFace, makeCubeWithDegenerateFace,
  makeOrientationDiscontinuity, makeNonManifold, makeOpenPatch,
  makeDuplicateVertexCube, makeAllDegenerate,
} from '../src/samples/generators.js';

const typesOf = (report) => report.issues.map((i) => i.type);

test('规则立方体：闭合、外向、无错误级问题', () => {
  const report = inspectMesh(makeCube());
  assert.equal(report.componentCount, 1);
  assert.equal(report.counts.boundaryEdgeCount, 0);
  assert.equal(report.counts.discontinuityEdgeCount, 0);
  assert.ok(!typesOf(report).includes(ISSUE_TYPES.REVERSED));
  assert.ok(!typesOf(report).includes(ISSUE_TYPES.DEGENERATE));
  assert.equal(report.unreliableFaces.length, 0);
});

test('反向面四面体：报告 reversed 且精确定位到被反转的面', () => {
  const report = inspectMesh(makeTetraWithReversedFace());
  const issue = report.issues.find((i) => i.type === ISSUE_TYPES.REVERSED);
  assert.ok(issue, '应报告反向面');
  assert.deepEqual(issue.faces, [0], '必须精确定位到第 0 号面，不波及其他面');
  assert.equal(issue.severity, 'error');
  // 反转一个面必然同时在其 3 条邻接边上产生方向不连续，这是真实几何现象
  assert.ok(typesOf(report).includes(ISSUE_TYPES.ORIENTATION_DISCONTINUITY));
});

test('退化面：重复索引与三点共线都被识别', () => {
  const mesh = makeCubeWithDegenerateFace();
  const report = inspectMesh(mesh);
  const issue = report.issues.find((i) => i.type === ISSUE_TYPES.DEGENERATE);
  assert.ok(issue);
  assert.ok(issue.faces.length >= 2, '至少两个退化面（共线 + 重复索引）');
  assert.ok(issue.faces.includes(mesh.faceCount - 1));
  assert.ok(issue.faces.includes(mesh.faceCount - 2));
});

test('全退化模型：全部面进入退化清单', () => {
  const report = inspectMesh(makeAllDegenerate());
  const issue = report.issues.find((i) => i.type === ISSUE_TYPES.DEGENERATE);
  assert.ok(issue);
  assert.equal(issue.faces.length, 2);
});

test('相邻面方向不连续：共享边同向被定位', () => {
  const report = inspectMesh(makeOrientationDiscontinuity());
  const issue = report.issues.find(
    (i) => i.type === ISSUE_TYPES.ORIENTATION_DISCONTINUITY);
  assert.ok(issue, '必须报告方向不连续');
  assert.ok(issue.faces.length >= 2, '共享边两侧的面都应列出');
  assert.ok(report.counts.discontinuityEdgeCount >= 1);
});

test('非流形边：三个面共享一条边', () => {
  const report = inspectMesh(makeNonManifold());
  const issue = report.issues.find((i) => i.type === ISSUE_TYPES.NON_MANIFOLD);
  assert.ok(issue);
  assert.equal(report.counts.nonManifoldEdgeCount, 1);
  assert.deepEqual([...new Set(issue.faces)].sort(), [0, 1, 2]);
  assert.ok(report.unreliableFaces.length === 3);
});

test('开放曲面：报告边界边与开放分量，且不做整体朝向误判', () => {
  const report = inspectMesh(makeOpenPatch());
  assert.ok(report.counts.boundaryEdgeCount > 0);
  assert.ok(typesOf(report).includes(ISSUE_TYPES.BOUNDARY));
  assert.ok(typesOf(report).includes(ISSUE_TYPES.OPEN_COMPONENT));
  // 开放分量无法可靠判定反向面，不应误报
  assert.ok(!typesOf(report).includes(ISSUE_TYPES.REVERSED));
});

test('重复坐标顶点：报告 duplicate-vertex 并触达相关面', () => {
  const report = inspectMesh(makeDuplicateVertexCube());
  const issue = report.issues.find((i) => i.type === ISSUE_TYPES.DUPLICATE_VERTEX);
  assert.ok(issue);
  assert.ok(issue.faces.length >= 2);
});
