import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { createSampleMesh, defaultAnchors } from '../src/core/samples';
import { SurfaceMesh } from '../src/core/SurfaceMesh';
import { RouteModel } from '../src/core/RouteModel';
import type { HoleCircle } from '../src/core/SurfaceMesh';

/** 沿折线等距取 n 个点 */
function samplePolyline(points: Vector3[], n: number): Vector3[] {
  const out: Vector3[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    for (let k = 0; k <= n; k++) out.push(new Vector3().lerpVectors(points[i], points[i + 1], k / n));
  }
  return out;
}

/**
 * 孔洞“核心区”：半径收缩到 90%，避开修整孔沿时贴边生成的三角形。
 * 只关心路线有没有真的穿过洞，而不是有没有擦到孔沿。
 */
function insideHoleInterior(x: number, z: number, hole: HoleCircle): boolean {
  const dx = (x - hole.center[0]) / (hole.radius * 0.9);
  const dz = (z - hole.center[1]) / (hole.radius * 0.74 * 0.9);
  return dx * dx + dz * dz < 1;
}

describe('SurfaceMesh 基础', () => {
  it('样例网格有合法的三角形邻接与连通分量', () => {
    const mesh = createSampleMesh('curved-holey');
    expect(mesh.triangleCount).toBeGreaterThan(1000);
    expect(mesh.componentCount).toBe(1);
    for (let t = 0; t < mesh.triangleCount; t += 37) {
      expect(mesh.componentOf(t)).toBe(0);
    }
  });

  it('双岛样例是两个互不连通的分量', () => {
    const mesh = createSampleMesh('twin-islands');
    expect(mesh.componentCount).toBe(2);
  });

  it('最近点查询会把任意点吸附到表面上', () => {
    const mesh = createSampleMesh('curved-holey');
    const hit = mesh.closestPoint(new Vector3(1.0, 5.0, 1.0));
    expect(hit).not.toBeNull();
    expect(hit!.distance).toBeGreaterThan(0);
    const known = mesh.anchorPosition({ tri: hit!.tri, bary: hit!.bary });
    expect(known.distanceTo(hit!.point)).toBeLessThan(1e-6);
  });
});

describe('贴面路径', () => {
  it('同一条路线中每一段都落在单个三角形内，且不跨越孔洞', () => {
    const mesh = createSampleMesh('curved-holey');
    const anchors = defaultAnchors('curved-holey', mesh);
    expect(anchors.length).toBeGreaterThanOrEqual(4);

    for (let i = 0; i < anchors.length - 1; i++) {
      const path = mesh.findPath(anchors[i], anchors[i + 1]);
      expect(path.ok, `第 ${i} 段应连通`).toBe(true);
      if (!path.ok) continue;

      expect(path.points.length).toBeGreaterThan(1);
      expect(path.length).toBeGreaterThan(0);
      expect(mesh.validatePath(path)).toEqual([]);

      // 不穿入孔洞内部：沿路径密集采样，没有任何一点落在孔的核心区域
      for (const p of samplePolyline(path.points, 24)) {
        expect(insideHoleInterior(p.x, p.z, mesh.holes[0])).toBe(false);
      }
      // 路径长度应优于“穿越孔洞的直线”
      const straight = mesh.anchorPosition(anchors[i]).distanceTo(mesh.anchorPosition(anchors[i + 1]));
      expect(path.length).toBeGreaterThanOrEqual(straight - 1e-6);
    }
  });

  it('断开表面上跨岛路线返回 disconnected，而不是画穿空气的直线', () => {
    const mesh = createSampleMesh('twin-islands');
    const anchors = defaultAnchors('twin-islands', mesh);
    const path = mesh.findPath(anchors[0], anchors[3]);
    expect(path.ok).toBe(false);
    if (!path.ok) {
      expect(path.reason).toBe('disconnected');
      expect(path.points).toHaveLength(0);
    }
    // 同岛内仍然可以连通
    const sameIsland = mesh.findPath(anchors[0], anchors[1]);
    expect(sameIsland.ok).toBe(true);
  });

  it('绕孔路径确实比直线更长（说明没有被孔洞穿透）', () => {
    const mesh = createSampleMesh('curved-holey');
    // 手工挑孔洞左右两侧的点
    const left = mesh.closestPoint(new Vector3(-0.9, 0, 0.05))!;
    const right = mesh.closestPoint(new Vector3(1.6, 0, 0.05))!;
    const path = mesh.findPath(
      { tri: left.tri, bary: left.bary },
      { tri: right.tri, bary: right.bary },
    );
    expect(path.ok).toBe(true);
    if (!path.ok) return;
    const straight = left.point.distanceTo(right.point);
    expect(path.length).toBeGreaterThan(straight * 1.2);
    for (const p of samplePolyline(path.points, 32)) {
      expect(insideHoleInterior(p.x, p.z, mesh.holes[0])).toBe(false);
    }
  });
});

describe('RouteModel 增量更新', () => {
  it('移动一个点只重算与它相邻的线段', () => {
    const mesh = createSampleMesh('curved-holey');
    const anchors = defaultAnchors('curved-holey', mesh);
    const route = new RouteModel(mesh);
    const wps = anchors.slice(0, 4).map((a) => route.addWaypoint(a));
    expect(route.getSegments()).toHaveLength(3);

    const before = new Map(route.getSegments().map((s) => [s.id, s.revision]));
    const farWaypoint = route.getWaypoint(wps[3].id)!;
    void farWaypoint;

    route.moveWaypoint(wps[1].id, { tri: anchors[1].tri, bary: anchors[1].bary });

    const changed = route
      .getSegments()
      .filter((s) => before.get(s.id) !== s.revision)
      .map((s) => s.id);
    expect(changed.sort()).toEqual(
      route
        .getSegments()
        .filter((s) => s.fromId === wps[1].id || s.toId === wps[1].id)
        .map((s) => s.id)
        .sort(),
    );
    expect(changed).toHaveLength(2);
  });

  it('编辑网格顶点只更新经过受影响三角形的线段，且旧路径被替换', () => {
    const mesh = createSampleMesh('curved-holey');
    const anchors = defaultAnchors('curved-holey', mesh);
    const route = new RouteModel(mesh);
    const wps = anchors.slice(0, 4).map((a) => route.addWaypoint(a));

    const farSegment = route.getSegments()[2];
    const farPathBefore = farSegment.path.ok ? farSegment.path.points.map((p) => p.clone()) : [];

    // 找一个属于第一段路径、但不属于第三段路径的顶点
    const firstSeg = route.getSegments()[0];
    expect(firstSeg.path.ok).toBe(true);
    if (!firstSeg.path.ok) return;
    const thirdTriangles = new Set(route.getSegments()[2].path.ok ? route.getSegments()[2].path.triangles : []);
    let vertexIndex = -1;
    let affectedTri: number[] = [];
    outer: for (const tri of firstSeg.path.triangles) {
      if (thirdTriangles.has(tri)) continue;
      for (const vi of mesh.getTriangleVertexIndices(tri)) {
        const hit = mesh.trianglesAdjacentToVertex(vi);
        if (hit.length > 0) {
          vertexIndex = vi;
          affectedTri = hit;
          break outer;
        }
      }
    }
    expect(vertexIndex).toBeGreaterThanOrEqual(0);

    const v = mesh.getVertexPosition(vertexIndex);
    const affected = mesh.moveVertex(vertexIndex, v.x, v.y + 0.55, v.z);
    expect(affected.length).toBeGreaterThan(0);
    const change = route.updateAfterVertexEdit(affected);

    const updatedIds = change.updatedSegments;
    expect(updatedIds).toContain(route.getSegments()[0].id);
    expect(updatedIds).not.toContain(route.getSegments()[2].id);

    // 第三段未受影响的路径保持原样
    const farSegmentAfter = route.getSegments()[2];
    expect(farSegmentAfter.revision).toBe(farSegment.revision);
    if (farSegmentAfter.path.ok) {
      const farPathAfter = farSegmentAfter.path.points.map((p) => p.clone());
      expect(farPathAfter).toHaveLength(farPathBefore.length);
      farPathAfter.forEach((p, i) => expect(p.distanceTo(farPathBefore[i])).toBeLessThan(1e-9));
    }

    // 第一段重算后依旧合法，并且路径点已经跟着抬高的顶点移动
    const firstAfter = route.getSegments()[0];
    expect(firstAfter.path.ok).toBe(true);
    if (firstAfter.path.ok) {
      expect(mesh.validatePath(firstAfter.path)).toEqual([]);
      expect(firstAfter.path.length).toBeGreaterThan(0);
    }

    // 无残留：每一段只对应一条记录
    const ids = route.getSegments().map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(route.getSegments()).toHaveLength(3);
    void wps;
    void affectedTri;
  });

  it('删除中间点后由一段新线替换两段，旧段不会残留', () => {
    const mesh = createSampleMesh('curved-holey');
    const anchors = defaultAnchors('curved-holey', mesh);
    const route = new RouteModel(mesh);
    const wps = anchors.slice(0, 4).map((a) => route.addWaypoint(a));
    const oldIds = route.getSegments().map((s) => s.id);

    route.deleteWaypoint(wps[1].id);

    const segments = route.getSegments();
    expect(segments).toHaveLength(2);
    expect(route.getWaypoints()).toHaveLength(3);
    // 被删掉的两段一定消失；接替位置的新段一定是新 id
    expect(segments.map((s) => s.id)).not.toContain(oldIds[0]);
    expect(segments.map((s) => s.id)).not.toContain(oldIds[1]);
    expect(segments[0].id).not.toBe(oldIds[0]);
    // 与删除点无关的第三段可以保留
    expect(segments[1].id).toBe(oldIds[2]);
    // 顺序正确：P0 -> P2 -> P3
    expect(segments[0].fromId).toBe(wps[0].id);
    expect(segments[0].toId).toBe(wps[2].id);
    expect(segments[1].fromId).toBe(wps[2].id);
    expect(segments[1].toId).toBe(wps[3].id);
    for (const seg of segments) {
      expect(seg.path.ok).toBe(true);
      expect(mesh.validatePath(seg.path)).toEqual([]);
    }
  });

  it('restore 会整体替换路线，不留下旧段', () => {
    const mesh = createSampleMesh('curved-holey');
    const anchors = defaultAnchors('curved-holey', mesh);
    const route = new RouteModel(mesh);
    for (const a of anchors.slice(0, 4)) route.addWaypoint(a);

    const newWaypoints = [
      { id: 'saved-a', name: 'A', anchor: anchors[0] },
      { id: 'saved-b', name: 'B', anchor: anchors[3] },
    ];
    route.restore(newWaypoints);

    expect(route.getWaypoints().map((w) => w.id)).toEqual(['saved-a', 'saved-b']);
    expect(route.getSegments()).toHaveLength(1);
    expect(route.getSegments()[0].fromId).toBe('saved-a');
    expect(route.getSegments()[0].toId).toBe('saved-b');
    for (const seg of route.getSegments()) {
      expect(mesh.validatePath(seg.path)).toEqual([]);
    }
  });

  it('删光点后总长度为 0，且不报错', () => {
    const mesh = new SurfaceMesh(createSampleMesh('curved-holey'));
    const anchors = defaultAnchors('curved-holey', mesh);
    const route = new RouteModel(mesh);
    const a = route.addWaypoint(anchors[0]);
    route.addWaypoint(anchors[1]);
    route.deleteWaypoint(a.id);
    expect(route.getWaypoints()).toHaveLength(1);
    expect(route.getSegments()).toHaveLength(0);
    expect(route.summary().totalLength).toBe(0);
  });
});
