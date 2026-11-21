import { Vector3 } from 'three';
import { SurfaceMesh } from './SurfaceMesh';
import type { SegmentPath, SurfaceAnchor } from './types';

export interface RouteWaypoint {
  id: string;
  name: string;
  anchor: SurfaceAnchor;
}

export interface RouteSegment {
  id: string;
  fromId: string;
  toId: string;
  path: SegmentPath;
  /** 每次重算递增，方便 UI / 测试确认“旧路径被替换而不是叠加” */
  revision: number;
}

export interface RouteSnapshot {
  waypoints: RouteWaypoint[];
  segments: RouteSegment[];
}

export interface RouteChange {
  kind: 'insert' | 'move' | 'delete' | 'recompute';
  updatedSegments: string[];
  removedSegments: string[];
  updatedWaypoints: string[];
}

export interface RouteSummary {
  totalLength: number;
  segmentCount: number;
  connectedCount: number;
  failedCount: number;
  triangleCount: number;
  triangles: number[];
}

export type RouteListener = (snapshot: RouteSnapshot, change: RouteChange) => void;

function id(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;
}

/**
 * 路线模型：负责点的增删改，以及“只重算受影响线段”。
 *
 * 不变式：
 * - segments 只覆盖相邻 waypoints，一旦 waypoint 变化，相邻 segment 要么更新要么被移除；
 * - 每次更新都会把旧 segment 的 path 整体替换，不保留任何旧点数组引用。
 */
export class RouteModel {
  readonly mesh: SurfaceMesh;
  private waypoints: RouteWaypoint[] = [];
  private segments: RouteSegment[] = [];
  private revisionCounter = 0;
  private listeners = new Set<RouteListener>();

  constructor(mesh: SurfaceMesh) {
    this.mesh = mesh;
  }

  subscribe(listener: RouteListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: RouteChange): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot, change);
  }

  snapshot(): RouteSnapshot {
    return {
      waypoints: this.waypoints.map((wp) => ({ ...wp, anchor: { tri: wp.anchor.tri, bary: [...wp.anchor.bary] } })),
      segments: this.segments.map((seg) => ({
        ...seg,
        path: {
          ...seg.path,
          points: seg.path.points.map((p) => p.clone()),
          pointTriangles: [...seg.path.pointTriangles],
          triangles: [...seg.path.triangles],
        } as SegmentPath,
      })),
    };
  }

  getWaypoints(): readonly RouteWaypoint[] {
    return this.waypoints;
  }

  getSegments(): readonly RouteSegment[] {
    return this.segments;
  }

  getWaypoint(wpId: string): RouteWaypoint | undefined {
    return this.waypoints.find((w) => w.id === wpId);
  }

  getSegment(segmentId: string): RouteSegment | undefined {
    return this.segments.find((s) => s.id === segmentId);
  }

  /** 线路里所有出现过的表面三角形（去重） */
  usedTriangles(): number[] {
    const set = new Set<number>();
    for (const seg of this.segments) {
      if (!seg.path.ok) continue;
      for (const t of seg.path.triangles) set.add(t);
    }
    return [...set];
  }

  addWaypoint(anchor: SurfaceAnchor, name?: string): RouteWaypoint {
    const sanitized = this.mesh.sanitizeAnchor(anchor);
    if (!sanitized) throw new Error('非法锚点');
    const wp: RouteWaypoint = {
      id: id('wp'),
      name: name ?? `P${this.waypoints.length + 1}`,
      anchor: sanitized,
    };
    this.waypoints.push(wp);
    const updatedSegments: string[] = [];
    if (this.waypoints.length >= 2) {
      const prev = this.waypoints[this.waypoints.length - 2];
      const seg = this.makeSegment(prev.id, wp.id);
      this.segments.push(seg);
      updatedSegments.push(seg.id);
    }
    this.emit({ kind: 'insert', updatedSegments, removedSegments: [], updatedWaypoints: [wp.id] });
    return wp;
  }

  moveWaypoint(wpId: string, anchor: SurfaceAnchor): RouteChange {
    const wp = this.waypoints.find((w) => w.id === wpId);
    if (!wp) throw new Error(`未知路线点: ${wpId}`);
    const sanitized = this.mesh.sanitizeAnchor(anchor);
    if (!sanitized) throw new Error('非法锚点');
    wp.anchor = sanitized;

    const touched = this.segments.filter((s) => s.fromId === wpId || s.toId === wpId);
    const updatedSegments: string[] = [];
    for (const seg of touched) {
      seg.path = this.mesh.findPath(
        this.waypoints.find((w) => w.id === seg.fromId)!.anchor,
        this.waypoints.find((w) => w.id === seg.toId)!.anchor,
      );
      seg.revision = ++this.revisionCounter;
      updatedSegments.push(seg.id);
    }
    const change: RouteChange = {
      kind: 'move',
      updatedSegments,
      removedSegments: [],
      updatedWaypoints: [wpId],
    };
    this.emit(change);
    return change;
  }

  /** 在一个已有线段中间插入新点：旧线段被拆成两段，旧线段被移除 */
  insertWaypointOnSegment(segmentId: string, anchor: SurfaceAnchor, name?: string): RouteWaypoint {
    const segIndex = this.segments.findIndex((s) => s.id === segmentId);
    if (segIndex < 0) throw new Error(`未知线段: ${segmentId}`);
    const seg = this.segments[segIndex];
    const fromIndex = this.waypoints.findIndex((w) => w.id === seg.fromId);
    const sanitized = this.mesh.sanitizeAnchor(anchor);
    if (!sanitized) throw new Error('非法锚点');
    const wp: RouteWaypoint = {
      id: id('wp'),
      name: name ?? `P${this.waypoints.length + 1}`,
      anchor: sanitized,
    };
    this.waypoints.splice(fromIndex + 1, 0, wp);
    this.segments.splice(segIndex, 1);
    const left = this.makeSegment(seg.fromId, wp.id);
    const right = this.makeSegment(wp.id, seg.toId);
    this.segments.splice(segIndex, 0, left, right);
    this.emit({
      kind: 'insert',
      updatedSegments: [left.id, right.id],
      removedSegments: [seg.id],
      updatedWaypoints: [wp.id],
    });
    return wp;
  }

  deleteWaypoint(wpId: string): void {
    const index = this.waypoints.findIndex((w) => w.id === wpId);
    if (index < 0) throw new Error(`未知路线点: ${wpId}`);
    const removedSegments = this.segments
      .filter((s) => s.fromId === wpId || s.toId === wpId)
      .map((s) => s.id);
    this.segments = this.segments.filter((s) => s.fromId !== wpId && s.toId !== wpId);
    this.waypoints.splice(index, 1);

    const updatedSegments: string[] = [];
    // 删除中间点后，补上左右邻居之间的一段
    if (index > 0 && index < this.waypoints.length) {
      const prev = this.waypoints[index - 1];
      const next = this.waypoints[index];
      const seg = this.makeSegment(prev.id, next.id);
      this.segments.splice(Math.min(index - 1, this.segments.length), 0, seg);
      updatedSegments.push(seg.id);
    }

    this.emit({
      kind: 'delete',
      updatedSegments,
      removedSegments,
      updatedWaypoints: [wpId],
    });
  }

  /**
   * 网格顶点变化后，只重算受影响的线段。
   *
   * 受影响判定：
   * - 线段的端点锚定在“含该顶点的三角形”上；或
   * - 线段经过的三角形集合里含有该顶点。
   */
  updateAfterVertexEdit(affectedTriangles: number[]): RouteChange {
    if (affectedTriangles.length === 0) {
      return { kind: 'recompute', updatedSegments: [], removedSegments: [], updatedWaypoints: [] };
    }
    const affectedTri = new Set(affectedTriangles);
    const affectedWaypointIds = new Set<string>();
    for (const wp of this.waypoints) {
      if (affectedTri.has(wp.anchor.tri)) affectedWaypointIds.add(wp.id);
    }

    const updatedSegments: string[] = [];
    for (const seg of this.segments) {
      const endpointAffected = affectedWaypointIds.has(seg.fromId) || affectedWaypointIds.has(seg.toId);
      const pathAffected = seg.path.ok && seg.path.triangles.some((t) => affectedTri.has(t));
      if (!endpointAffected && !pathAffected) continue;
      seg.path = this.mesh.findPath(
        this.waypoints.find((w) => w.id === seg.fromId)!.anchor,
        this.waypoints.find((w) => w.id === seg.toId)!.anchor,
      );
      seg.revision = ++this.revisionCounter;
      updatedSegments.push(seg.id);
    }

    const change: RouteChange = {
      kind: 'recompute',
      updatedSegments,
      removedSegments: [],
      updatedWaypoints: [...affectedWaypointIds],
    };
    this.emit(change);
    return change;
  }

  /** 恢复存档：丢弃所有旧线段，按 waypoints 重新计算，天然不会残留旧路径 */
  restore(waypoints: { id?: string; name?: string; anchor: SurfaceAnchor }[]): void {
    const nextWaypoints: RouteWaypoint[] = [];
    for (const wp of waypoints) {
      const anchor = this.mesh.sanitizeAnchor(wp.anchor);
      if (!anchor) continue;
      nextWaypoints.push({
        id: wp.id ?? id('wp'),
        name: wp.name ?? `P${nextWaypoints.length + 1}`,
        anchor,
      });
    }
    this.waypoints = nextWaypoints;
    this.segments = [];
    for (let i = 0; i < this.waypoints.length - 1; i++) {
      this.segments.push(this.makeSegment(this.waypoints[i].id, this.waypoints[i + 1].id));
    }
    this.emit({
      kind: 'recompute',
      updatedSegments: this.segments.map((s) => s.id),
      removedSegments: [],
      updatedWaypoints: this.waypoints.map((w) => w.id),
    });
  }

  clear(): void {
    const removedSegments = this.segments.map((s) => s.id);
    const removedWaypoints = this.waypoints.map((w) => w.id);
    this.waypoints = [];
    this.segments = [];
    this.emit({
      kind: 'delete',
      updatedSegments: [],
      removedSegments,
      updatedWaypoints: removedWaypoints,
    });
  }

  summary(): RouteSummary {
    let totalLength = 0;
    let connectedCount = 0;
    let failedCount = 0;
    const triSet = new Set<number>();
    for (const seg of this.segments) {
      if (seg.path.ok) {
        totalLength += seg.path.length;
        connectedCount++;
        for (const t of seg.path.triangles) triSet.add(t);
      } else {
        failedCount++;
      }
    }
    return {
      totalLength,
      segmentCount: this.segments.length,
      connectedCount,
      failedCount,
      triangleCount: triSet.size,
      triangles: [...triSet],
    };
  }

  segmentMidpoints(): { segmentId: string; position: Vector3; length: number; ok: boolean }[] {
    const out: { segmentId: string; position: Vector3; length: number; ok: boolean }[] = [];
    for (const seg of this.segments) {
      if (!seg.path.ok || seg.path.points.length < 2) continue;
      const points = seg.path.points;
      // 取弧长中点，而不是点数中点
      let half = seg.path.length / 2;
      let pos = points[points.length - 1];
      for (let i = 0; i < points.length - 1; i++) {
        const d = points[i].distanceTo(points[i + 1]);
        if (half <= d) {
          pos = new Vector3().lerpVectors(points[i], points[i + 1], d === 0 ? 0 : half / d);
          break;
        }
        half -= d;
      }
      out.push({ segmentId: seg.id, position: pos.clone(), length: seg.path.length, ok: true });
    }
    return out;
  }

  private makeSegment(fromId: string, toId: string): RouteSegment {
    const from = this.waypoints.find((w) => w.id === fromId)!;
    const to = this.waypoints.find((w) => w.id === toId)!;
    return {
      id: id('seg'),
      fromId,
      toId,
      path: this.mesh.findPath(from.anchor, to.anchor),
      revision: ++this.revisionCounter,
    };
  }
}
