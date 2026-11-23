import * as THREE from 'three';
import type {
  FoldIssue,
  IntersectionIssue,
  ObjSceneData,
  RegionInspection,
  SurfaceModel,
  Vec3,
} from '../core/types';
import { COLORS, dotTexture, lineMaterial } from './palette';
import { makeCylinderAlong } from './highlight';
import { boundaryEdgeTrace, type BoundaryEdgeTrace } from '../core/diagnostics';
import type { ThickenedSolid } from '../core/types';
import { readVec3, scale, add } from '../core/vec';

/** 选区和诊断标记的渲染层: 区域高亮、实测间隙、反折点、穿插点、边界边高亮 */
export class OverlayView {
  readonly root = new THREE.Group();

  private regionMesh: THREE.Object3D | null = null;
  private gapLines: THREE.LineSegments | null = null;
  private samplePoints: THREE.Points | null = null;
  private foldPoints: THREE.Points | null = null;
  private intersectionPoints: THREE.Points | null = null;
  private traceLines: THREE.Group | null = null;
  private objGhost: THREE.Group | null = null;

  /**
   * 区域高亮直接贴在加厚后的偏移面上 (沿法线外移 4mm), 否则会被实体遮住看不见。
   * 实测间隙线保留深度关闭, 让实体内部的测量线也能读出来。
   */
  setRegion(
    model: SurfaceModel | null,
    solid: ThickenedSolid | null,
    inspection: RegionInspection | null,
  ): void {
    this.disposeNode(this.regionMesh);
    this.regionMesh = null;
    this.disposeNode(this.gapLines);
    this.gapLines = null;
    this.disposeNode(this.samplePoints);
    this.samplePoints = null;
    if (!model || !inspection || inspection.triangleIds.length === 0) return;

    const lift = solid ? solid.thickness * solid.side : 0;
    const positions = new Float32Array(inspection.triangleIds.length * 9);
    const indices = new Uint32Array(inspection.triangleIds.length * 3);
    inspection.triangleIds.forEach((triangle, i) => {
      for (let k = 0; k < 3; k++) {
        const v = model.indices[triangle * 3 + k];
        const normal = readVec3(model.normals, v);
        const base = readVec3(model.positions, v);
        const lifted = add(base, scale(normal, lift + 0.004));
        positions[i * 9 + k * 3] = lifted[0];
        positions[i * 9 + k * 3 + 1] = lifted[1];
        positions[i * 9 + k * 3 + 2] = lifted[2];
        indices[i * 3 + k] = i * 3 + k;
      }
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(Array.from(indices));
    geometry.computeVertexNormals();
    const material = new THREE.MeshBasicMaterial({
      color: COLORS.region,
      transparent: true,
      opacity: 0.62,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: false,
    });
    const regionGroup = new THREE.Group();
    const regionMesh = new THREE.Mesh(geometry, material);
    regionMesh.renderOrder = 12;
    regionGroup.add(regionMesh);

    // 选区轮廓: 只保留被一个选中三角形使用的边, 形成区域边界
    const edgeUse = new Map<string, number>();
    inspection.triangleIds.forEach((_, i) => {
      for (let k = 0; k < 3; k++) {
        const a = i * 3 + k;
        const b = i * 3 + ((k + 1) % 3);
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
      }
    });
    const outline: number[] = [];
    inspection.triangleIds.forEach((_, i) => {
      for (let k = 0; k < 3; k++) {
        const a = i * 3 + k;
        const b = i * 3 + ((k + 1) % 3);
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        if ((edgeUse.get(key) ?? 0) > 1) continue;
        outline.push(
          positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2],
          positions[b * 3], positions[b * 3 + 1], positions[b * 3 + 2],
        );
      }
    });
    if (outline.length > 0) {
      const outlineGeometry = new THREE.BufferGeometry();
      outlineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(outline, 3));
      const outlineLines = new THREE.LineSegments(
        outlineGeometry,
        new THREE.LineBasicMaterial({ color: COLORS.region, depthTest: false, transparent: true, opacity: 1 }),
      );
      outlineLines.renderOrder = 13;
      regionGroup.add(outlineLines);
    }
    this.regionMesh = regionGroup;
    this.root.add(regionGroup);

    // 实测间隙线段 + 端点: 只画明显短于名义厚度的那些, 避免在正常区域堆满线条
    const nominal = inspection.nominalThickness;
    const interesting = inspection.sampleGaps.filter(
      (gap) => nominal <= 0 || gap.distance < nominal * 0.9,
    );
    if (interesting.length > 0) {
      const linePositions: number[] = [];
      const points: number[] = [];
      for (const gap of interesting) {
        linePositions.push(...gap.from, ...gap.to);
        points.push(...gap.from, ...gap.to);
      }
      const lineGeometry = new THREE.BufferGeometry();
      lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
      this.gapLines = new THREE.LineSegments(
        lineGeometry,
        new THREE.LineBasicMaterial({ color: COLORS.gap, transparent: true, opacity: 0.9, depthTest: false }),
      );
      this.gapLines.renderOrder = 13;
      this.root.add(this.gapLines);

      const pointGeometry = new THREE.BufferGeometry();
      pointGeometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
      this.samplePoints = new THREE.Points(
        pointGeometry,
        new THREE.PointsMaterial({
          color: COLORS.gap,
          size: 7,
          sizeAttenuation: false,
          map: dotTexture(),
          alphaTest: 0.15,
          transparent: true,
          opacity: 0.95,
          depthWrite: false,
          depthTest: false,
        }),
      );
      this.samplePoints.renderOrder = 14;
      this.root.add(this.samplePoints);
    }
  }

  setFolds(folds: FoldIssue[], limit = 600): void {
    this.disposeNode(this.foldPoints);
    this.foldPoints = null;
    if (folds.length === 0) return;
    const selected = folds.slice(0, limit);
    const positions = new Float32Array(selected.length * 3);
    selected.forEach((fold, i) => {
      positions[i * 3] = fold.centroid[0];
      positions[i * 3 + 1] = fold.centroid[1];
      positions[i * 3 + 2] = fold.centroid[2];
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    // 屏幕空间定长点: 不论缩放多大都保持可读, 且被遮挡处会正常隐藏
    this.foldPoints = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        color: COLORS.fold,
        size: 5,
        sizeAttenuation: false,
        map: dotTexture(),
        alphaTest: 0.15,
        transparent: true,
        opacity: 0.75,
        depthWrite: false,
      }),
    );
    this.foldPoints.renderOrder = 16;
    this.root.add(this.foldPoints);
  }

  setIntersections(issues: IntersectionIssue[], limit = 800): void {
    this.disposeNode(this.intersectionPoints);
    this.intersectionPoints = null;
    if (issues.length === 0) return;
    const selected = issues.slice(0, limit);
    const positions = new Float32Array(selected.length * 3);
    selected.forEach((issue, i) => {
      positions[i * 3] = issue.point[0];
      positions[i * 3 + 1] = issue.point[1];
      positions[i * 3 + 2] = issue.point[2];
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.intersectionPoints = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        color: COLORS.intersection,
        size: 6,
        sizeAttenuation: false,
        map: dotTexture(),
        alphaTest: 0.15,
        transparent: true,
        opacity: 0.8,
        depthWrite: false,
      }),
    );
    this.intersectionPoints.renderOrder = 17;
    this.root.add(this.intersectionPoints);
  }

  /** 侧壁点选: 高亮它对应的原始边界边 (在源网格上), 以及偏移后的同一条边 */
  setBoundaryTrace(solid: ThickenedSolid | null, sideTriangleIndex: number | null): BoundaryEdgeTrace | null {
    this.disposeNode(this.traceLines);
    this.traceLines = null;
    if (!solid || sideTriangleIndex === null) return null;
    const trace = boundaryEdgeTrace(solid, sideTriangleIndex);
    if (!trace) return null;

    const group = new THREE.Group();
    const material = new THREE.MeshBasicMaterial({
      color: COLORS.selection,
      depthTest: false,
      transparent: true,
      opacity: 1,
    });
    // 管径随边长缩放; 用圆柱而不是 Line, 因为 linewidth 在多数平台被忽略
    const radius = Math.min(0.014, Math.max(0.007, trace.edgeLength * 0.22));
    const sourceEdge = makeCylinderAlong(trace.endpoints[0], trace.endpoints[1], radius, material);
    const offsetEdge = makeCylinderAlong(trace.offsetEndpoints[0], trace.offsetEndpoints[1], radius * 0.75, material);
    sourceEdge.renderOrder = 22;
    offsetEdge.renderOrder = 22;
    group.add(sourceEdge, offsetEdge);

    // 两端点 + 连接线, 显示加厚方向
    const connectors: Vec3[] = [
      trace.endpoints[0], trace.offsetEndpoints[0],
      trace.endpoints[1], trace.offsetEndpoints[1],
    ];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(connectors.flat(), 3));
    const connectorsLine = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ color: COLORS.selection, depthTest: false, transparent: true, opacity: 0.8 }),
    );
    connectorsLine.renderOrder = 21;
    group.add(connectorsLine);

    const markerGeometry = new THREE.SphereGeometry(radius * 1.7, 12, 8);
    const markerMaterial = new THREE.MeshBasicMaterial({ color: COLORS.selection, depthTest: false });
    for (const point of [trace.endpoints[0], trace.endpoints[1]]) {
      const marker = new THREE.Mesh(markerGeometry, markerMaterial);
      marker.position.set(point[0], point[1], point[2]);
      marker.renderOrder = 23;
      group.add(marker);
    }

    this.traceLines = group;
    this.root.add(group);
    return trace;
  }

  /**
   * OBJ 读回的几何。
   * isolated=true: 主体已隐藏, 用半透明实体直接看读回结果;
   * isolated=false: 与主体叠加, 只留线框, 用于核对坐标与边界是否吻合。
   */
  setObjGhost(scene: ObjSceneData | null, isolated = true): void {
    this.disposeNode(this.objGhost);
    this.objGhost = null;
    if (!scene) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(scene.positions, 3));
    geometry.setIndex(Array.from(scene.indices));
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({
        color: 0xb9a8ff,
        metalness: 0.08,
        roughness: 0.55,
        transparent: true,
        opacity: isolated ? 0.62 : 0.08,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    mesh.renderOrder = 9;
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry, isolated ? 30 : 18),
      lineMaterial(isolated ? 0xe0d6ff : 0xffd166, isolated ? 0.32 : 0.85),
    );
    edges.renderOrder = 10;
    const group = new THREE.Group();
    group.add(mesh, edges);
    group.position.set(0, 0, 0);
    this.objGhost = group;
    this.root.add(group);
  }

  clearAll(): void {
    for (const group of [this.root]) {
      for (const child of [...group.children]) {
        group.remove(child);
        child.traverse((node) => {
          const mesh = node as THREE.Mesh;
          mesh.geometry?.dispose();
          const material = mesh.material;
          if (Array.isArray(material)) material.forEach((m) => m.dispose());
          else (material as THREE.Material | undefined)?.dispose();
        });
      }
    }
    this.regionMesh = null;
    this.gapLines = null;
    this.samplePoints = null;
    this.foldPoints = null;
    this.intersectionPoints = null;
    this.traceLines = null;
    this.objGhost = null;
  }

  dispose(): void {
    this.clearAll();
    this.root.clear();
  }

  private disposeNode(node: THREE.Object3D | null): void {
    if (!node) return;
    node.removeFromParent();
    node.traverse((child) => {
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else (material as THREE.Material | undefined)?.dispose();
    });
  }
}
