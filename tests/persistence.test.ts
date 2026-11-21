import { describe, expect, it } from 'vitest';
import { createSampleMesh, defaultAnchors } from '../src/core/samples';
import { RouteModel } from '../src/core/RouteModel';
import {
  createSave,
  deserializeSave,
  parseSave,
  SCHEMA_VERSION,
  serializeSave,
} from '../src/core/persistence';
import type { CameraState } from '../src/core/persistence';

const camera: CameraState = {
  position: [6, 5, 7],
  target: [0.3, 0, 0],
  up: [0, 1, 0],
  fov: 45,
};

describe('存档 / 恢复', () => {
  it('保存后重新读入，相机、点与顶点偏移完全一致', () => {
    const mesh = createSampleMesh('curved-holey');
    const anchors = defaultAnchors('curved-holey', mesh);
    const route = new RouteModel(mesh);
    const wps = anchors.slice(0, 3).map((a) => route.addWaypoint(a));

    // 改一个网格顶点，验证偏移能恢复
    const vi = mesh.getTriangleVertexIndices(wps[0].anchor.tri)[0];
    const base = mesh.getVertexPosition(vi).clone();
    mesh.moveVertex(vi, base.x, base.y + 0.3, base.z);
    route.updateAfterVertexEdit(mesh.trianglesAdjacentToVertex(vi));

    const save = createSave({
      sampleId: 'curved-holey',
      camera,
      waypoints: route.getWaypoints().map((w) => ({ id: w.id, name: w.name, anchor: w.anchor })),
      vertexOffsets: mesh.collectVertexOffsets(),
      selectedWaypointId: wps[1].id,
    });
    const roundTrip = deserializeSave(serializeSave(save));
    expect(roundTrip.ok).toBe(true);
    expect(roundTrip.value!.camera).toEqual(camera);
    expect(roundTrip.value!.waypoints).toEqual(save.waypoints);
    expect(roundTrip.value!.vertexOffsets[String(vi)][1]).toBeCloseTo(0.3, 6);
    expect(roundTrip.value!.selectedWaypointId).toBe(wps[1].id);
  });

  it('恢复到一个新网格后，路线与保存时一致（用新 id 也不会残留旧段）', () => {
    const source = createSampleMesh('curved-holey');
    const anchors = defaultAnchors('curved-holey', source);
    const route = new RouteModel(source);
    anchors.slice(0, 4).forEach((a) => route.addWaypoint(a));
    const save = createSave({
      sampleId: 'curved-holey',
      camera,
      waypoints: route.getWaypoints().map((w) => ({ id: w.id, name: w.name, anchor: w.anchor })),
      vertexOffsets: source.collectVertexOffsets(),
      selectedWaypointId: null,
    });

    const restoredMesh = createSampleMesh('curved-holey');
    restoredMesh.applyVertexOffsets(
      new Map(
        Object.entries(save.vertexOffsets).map(([k, v]) => [Number(k), v as [number, number, number]]),
      ),
    );
    const restoredRoute = new RouteModel(restoredMesh);
    restoredRoute.restore(save.waypoints);

    expect(restoredRoute.getWaypoints()).toHaveLength(4);
    expect(restoredRoute.getSegments()).toHaveLength(3);
    const originalSummary = route.summary();
    const restoredSummary = restoredRoute.summary();
    expect(restoredSummary.totalLength).toBeCloseTo(originalSummary.totalLength, 5);
    expect(restoredSummary.triangleCount).toBe(originalSummary.triangleCount);
  });

  it('模型自身的旋转也能被保存 / 恢复（与相机分开记录）', () => {
    const source = createSampleMesh('curved-holey');
    const route = new RouteModel(source);
    const anchors = defaultAnchors('curved-holey', source);
    route.addWaypoint(anchors[0]);
    const save = createSave({
      sampleId: 'curved-holey',
      camera,
      waypoints: route.getWaypoints().map((w) => ({ id: w.id, name: w.name, anchor: w.anchor })),
      vertexOffsets: {},
      modelRotation: [0, Math.PI / 3, 0],
      selectedWaypointId: null,
    });
    const roundTrip = deserializeSave(serializeSave(save));
    expect(roundTrip.ok).toBe(true);
    expect(roundTrip.value!.modelRotation[1]).toBeCloseTo(Math.PI / 3, 12);
    // 缺省时补 0，兼容旧存档
    const legacy = parseSave({
      schemaVersion: SCHEMA_VERSION,
      sampleId: 'curved-holey',
      camera,
      waypoints: [],
    });
    expect(legacy.ok).toBe(true);
    expect(legacy.value!.modelRotation).toEqual([0, 0, 0]);
  });

  it('非法存档被拒绝，坏点被计数丢弃', () => {
    expect(parseSave(null).ok).toBe(false);
    expect(parseSave({ schemaVersion: 99 }).ok).toBe(false);
    expect(
      parseSave({
        schemaVersion: SCHEMA_VERSION,
        sampleId: 'unknown',
        camera,
        waypoints: [],
      }).ok,
    ).toBe(false);

    const result = parseSave({
      schemaVersion: SCHEMA_VERSION,
      sampleId: 'curved-holey',
      camera,
      waypoints: [
        { id: 'a', name: 'A', anchor: { tri: 3, bary: [0.2, 0.3, 0.5] } },
        { id: 'b', name: 'B', anchor: { tri: 'x', bary: [0.2, 0.3, 0.5] } },
        { id: 'c', name: 'C', anchor: { tri: 4, bary: [0.5, 0.5] } },
      ],
      vertexOffsets: { '3': [0, 0.2, 0], bad: [1, 2, 3] },
      selectedWaypointId: null,
    });
    expect(result.ok).toBe(true);
    expect(result.droppedWaypoints).toBe(2);
    expect(result.value!.waypoints).toHaveLength(1);
    expect(Object.keys(result.value!.vertexOffsets)).toEqual(['3']);
  });

  it('JSON 损坏时给出可读错误而不是抛异常', () => {
    const result = deserializeSave('{ not json');
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('JSON 解析失败');
  });

  it('相机数据缺失会被判定为非法存档', () => {
    const result = parseSave({
      schemaVersion: SCHEMA_VERSION,
      sampleId: 'curved-holey',
      camera: { position: [0, 0, 0] },
      waypoints: [],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('相机');
  });
});
