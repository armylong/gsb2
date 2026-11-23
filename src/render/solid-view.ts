import * as THREE from 'three';
import type { SolidTriangle, ThickenedSolid } from '../core/types';
import { COLORS, doubleSided, lineMaterial } from './palette';

export type LayerId = 'original' | 'offset' | 'sideNormal' | 'sideProblem';

export interface SolidViewOptions {
  showOriginal: boolean;
  showOffset: boolean;
  showSideWalls: boolean;
  showSourceOverlay: boolean;
  /** 只显示问题侧壁 (隔离显示, 用于定位穿插/反折) */
  isolateProblemWalls: boolean;
  /** 把反折/穿插涉及的偏移层三角形和侧壁单独标色 */
  showProblemMarkers: boolean;
  /** 侧壁外移量, 让侧壁与主体分开看 */
  explodeSideWalls: number;
  opacity: number;
  wireframe: boolean;
}

export const DEFAULT_VIEW_OPTIONS: SolidViewOptions = {
  showOriginal: true,
  showOffset: true,
  showSideWalls: true,
  showSourceOverlay: false,
  isolateProblemWalls: false,
  showProblemMarkers: true,
  explodeSideWalls: 0,
  opacity: 1,
  wireframe: false,
};

interface WallMeshInfo {
  mesh: THREE.Mesh;
  /** 面序号 -> sideIndices 中的三角形序号 */
  faceToSide: Int32Array;
  kind: 'normal' | 'problem';
}

function geometryFrom(
  positions: Float32Array,
  triangles: SolidTriangle[],
): THREE.BufferGeometry {
  const indices = new Uint32Array(triangles.length * 3);
  triangles.forEach((tri, i) => {
    indices[i * 3] = tri.a;
    indices[i * 3 + 1] = tri.b;
    indices[i * 3 + 2] = tri.c;
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(Array.from(indices));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * 实体视图:
 *  - 原始层 (深灰)、偏移层 (浅色)、侧壁 (青绿) 分开建网格
 *  - 问题侧壁单独一个网格 (橙红), 支持隔离显示和沿外法线外移
 *  - 侧壁按面记录 sideIndices 序号, 供 raycast 反查原始边
 */
export class SolidView {
  readonly root = new THREE.Group();
  /** 侧壁拾取目标 (raycast) */
  readonly wallPickables: THREE.Mesh[] = [];
  /** 曲面拾取目标, 用于选择检查区域; faceIndex 直接对应源三角形序号 */
  readonly surfacePickables: THREE.Mesh[] = [];

  private solid: ThickenedSolid | null = null;
  private options: SolidViewOptions = { ...DEFAULT_VIEW_OPTIONS };
  private originalMesh: THREE.Mesh | null = null;
  private offsetMesh: THREE.Mesh | null = null;
  private normalWall: WallMeshInfo | null = null;
  private problemWall: WallMeshInfo | null = null;
  private problemOffsetMesh: THREE.Mesh | null = null;
  private sourceGhost: THREE.Mesh | null = null;
  private sourceEdges: THREE.LineSegments | null = null;
  private boundaryLines: THREE.LineSegments | null = null;
  private selectionOutline: THREE.Mesh | null = null;

  private readonly originalGroup = new THREE.Group();
  private readonly offsetGroup = new THREE.Group();
  private readonly wallGroup = new THREE.Group();
  private readonly problemGroup = new THREE.Group();
  private readonly overlayGroup = new THREE.Group();

  constructor() {
    this.root.add(this.originalGroup, this.offsetGroup, this.wallGroup, this.problemGroup, this.overlayGroup);
  }

  setSolid(solid: ThickenedSolid | null): void {
    this.clear();
    this.solid = solid;
    if (!solid) return;
    this.build(solid);
    this.applyOptions();
  }

  getSolid(): ThickenedSolid | null {
    return this.solid;
  }

  setOptions(partial: Partial<SolidViewOptions>): void {
    this.options = { ...this.options, ...partial };
    this.applyOptions();
  }

  getOptions(): SolidViewOptions {
    return { ...this.options };
  }

  /** 曲面点选 -> 源三角形序号 */
  surfaceTriangleAt(hit: THREE.Intersection): number | null {
    if (!this.surfacePickables.includes(hit.object as THREE.Mesh)) return null;
    if (hit.faceIndex === undefined || hit.faceIndex === null) return null;
    return hit.faceIndex;
  }

  /** 点选的侧壁三角形在 sideIndices 中的序号 */
  sideTriangleAt(hit: THREE.Intersection): number | null {
    const info = [this.normalWall, this.problemWall].find((item) => item && item.mesh === hit.object);
    if (!info || hit.faceIndex === undefined || hit.faceIndex === null) return null;
    const mapped = info.faceToSide[hit.faceIndex];
    return mapped === undefined || mapped < 0 ? null : mapped;
  }

  setSelectedSideTriangle(index: number | null): void {
    if (this.selectionOutline) {
      this.selectionOutline.geometry.dispose();
      (this.selectionOutline.material as THREE.Material).dispose();
      this.selectionOutline.removeFromParent();
      this.selectionOutline = null;
    }
    if (index === null || !this.solid) return;
    const t = index * 3;
    if (t + 2 >= this.solid.sideIndices.length) return;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(9);
    for (let k = 0; k < 3; k++) {
      const v = this.solid.sideIndices[t + k];
      positions[k * 3] = this.solid.positions[v * 3];
      positions[k * 3 + 1] = this.solid.positions[v * 3 + 1];
      positions[k * 3 + 2] = this.solid.positions[v * 3 + 2];
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex([0, 1, 2]);
    geometry.computeVertexNormals();
    const material = new THREE.MeshBasicMaterial({
      color: COLORS.selection,
      transparent: true,
      opacity: 0.28,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    });
    this.selectionOutline = new THREE.Mesh(geometry, material);
    this.selectionOutline.renderOrder = 20;
    this.overlayGroup.add(this.selectionOutline);

    // 三角形轮廓线, 让选中的侧壁在厚壁里也能看清形状
    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicMaterial({ color: COLORS.selection, depthTest: false, transparent: true, opacity: 1 }),
    );
    outline.renderOrder = 21;
    this.selectionOutline.add(outline);
  }

  private build(solid: ThickenedSolid): void {
    const original = solid.triangles.filter((tri) => tri.kind === 'original');
    const offset = solid.triangles.filter((tri) => tri.kind === 'offset');
    const sides = solid.triangles.filter((tri) => tri.kind === 'side');

    this.originalMesh = new THREE.Mesh(
      geometryFrom(solid.positions, original),
      doubleSided(COLORS.original, { wireframe: this.options.wireframe }),
    );
    this.offsetMesh = new THREE.Mesh(
      geometryFrom(solid.positions, offset),
      doubleSided(COLORS.offset, { wireframe: this.options.wireframe }),
    );
    // 反折/穿插涉及的偏移层三角形单独覆盖一层红色, 直观显示"另一面网格插出来"
    const problemOffset = solid.triangles.filter(
      (tri) => tri.kind === 'offset' && solid.validation.problemSourceTriangles.has(tri.sourceTriangle),
    );
    if (problemOffset.length > 0) {
      this.problemOffsetMesh = new THREE.Mesh(
        geometryFrom(solid.positions, problemOffset),
        new THREE.MeshStandardMaterial({
          color: COLORS.fold,
          emissive: new THREE.Color(COLORS.fold),
          emissiveIntensity: 0.32,
          metalness: 0.05,
          roughness: 0.5,
          side: THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        }),
      );
      this.problemOffsetMesh.name = 'offset-layer-problem';
      this.offsetGroup.add(this.problemOffsetMesh);
    }

    this.originalGroup.add(this.originalMesh);
    this.offsetGroup.add(this.offsetMesh);
    // 原始层/偏移层三角形序号都与源三角形一一对应 (绕序可能翻转, 但顺序不变)
    this.surfacePickables.push(this.originalMesh, this.offsetMesh);

    const normalFaces: SolidTriangle[] = [];
    const normalFaceToSide: number[] = [];
    const problemFaces: SolidTriangle[] = [];
    const problemFaceToSide: number[] = [];
    // 侧壁三角形 id 连续紧跟 original/offset 层之后, 用首条侧壁的 id 即可换算 sideIndices 序号
    const sideStartId = sides[0]?.id ?? 0;
    for (const tri of sides) {
      const index = tri.id - sideStartId;
      if (solid.validation.problemSideEdges.has(tri.edgeId)) {
        problemFaces.push(tri);
        problemFaceToSide.push(index);
      } else {
        normalFaces.push(tri);
        normalFaceToSide.push(index);
      }
    }
    for (let i = 0; i < normalFaces.length; i++) normalFaceToSide[i] = normalFaces[i].id - sideStartId;
    for (let i = 0; i < problemFaces.length; i++) problemFaceToSide[i] = problemFaces[i].id - sideStartId;

    if (normalFaces.length > 0) {
      const mesh = new THREE.Mesh(
        geometryFrom(solid.positions, normalFaces),
        doubleSided(COLORS.sideNormal, {
          metalness: 0.12,
          roughness: 0.45,
          wireframe: this.options.wireframe,
        }),
      );
      mesh.name = 'side-walls-normal';
      this.wallGroup.add(mesh);
      this.normalWall = { mesh, faceToSide: Int32Array.from(normalFaceToSide), kind: 'normal' };
      this.wallPickables.push(mesh);
    }

    if (problemFaces.length > 0) {
      const mesh = new THREE.Mesh(
        geometryFrom(solid.positions, problemFaces),
        doubleSided(COLORS.sideProblem, {
          emissive: new THREE.Color(COLORS.sideProblem),
          emissiveIntensity: 0.22,
          metalness: 0.12,
          roughness: 0.4,
          wireframe: this.options.wireframe,
        }),
      );
      mesh.name = 'side-walls-problem';
      this.problemGroup.add(mesh);
      this.problemWall = { mesh, faceToSide: Int32Array.from(problemFaceToSide), kind: 'problem' };
      this.wallPickables.push(mesh);
    }

    // 原始曲面叠图 + 线框
    const model = solid.model;
    const ghostGeometry = new THREE.BufferGeometry();
    ghostGeometry.setAttribute('position', new THREE.BufferAttribute(model.positions.slice(), 3));
    ghostGeometry.setIndex(Array.from(model.indices));
    ghostGeometry.computeVertexNormals();
    this.sourceGhost = new THREE.Mesh(
      ghostGeometry,
      new THREE.MeshBasicMaterial({
        color: COLORS.ghost,
        transparent: true,
        opacity: 0.16,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    this.sourceGhost.renderOrder = 6;
    this.overlayGroup.add(this.sourceGhost);

    const sourceEdgesGeometry = new THREE.BufferGeometry();
    sourceEdgesGeometry.setAttribute('position', new THREE.BufferAttribute(model.positions.slice(), 3));
    sourceEdgesGeometry.setIndex(Array.from(model.indices));
    const edges = new THREE.EdgesGeometry(sourceEdgesGeometry, 24);
    this.sourceEdges = new THREE.LineSegments(edges, lineMaterial(COLORS.sourceWire, 0.7));
    this.sourceEdges.renderOrder = 7;
    this.overlayGroup.add(this.sourceEdges);

    // 边界高亮: 原始层与偏移层的边界环
    const base = model.positions.length / 3;
    const linePositions: number[] = [];
    for (const edge of model.boundaryEdges) {
      linePositions.push(
        model.positions[edge.a * 3], model.positions[edge.a * 3 + 1], model.positions[edge.a * 3 + 2],
        model.positions[edge.b * 3], model.positions[edge.b * 3 + 1], model.positions[edge.b * 3 + 2],
      );
      linePositions.push(
        solid.positions[(edge.a + base) * 3], solid.positions[(edge.a + base) * 3 + 1], solid.positions[(edge.a + base) * 3 + 2],
        solid.positions[(edge.b + base) * 3], solid.positions[(edge.b + base) * 3 + 1], solid.positions[(edge.b + base) * 3 + 2],
      );
    }
    const boundaryGeometry = new THREE.BufferGeometry();
    boundaryGeometry.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
    this.boundaryLines = new THREE.LineSegments(boundaryGeometry, lineMaterial(COLORS.holeEdge, 0.9));
    this.boundaryLines.renderOrder = 8;
    this.overlayGroup.add(this.boundaryLines);

    sourceEdgesGeometry.dispose();
  }

  private applyOptions(): void {
    const o = this.options;
    const showNormalWalls = o.showSideWalls && !o.isolateProblemWalls;
    // 隔离模式只看问题侧壁: 保证即使"显示侧壁"未勾选也能看到结果
    const showProblemWalls = o.isolateProblemWalls || o.showSideWalls;
    const showBody = !o.isolateProblemWalls;

    if (this.originalGroup) this.originalGroup.visible = o.showOriginal && showBody;
    if (this.offsetGroup) this.offsetGroup.visible = o.showOffset && showBody;
    if (this.wallGroup) this.wallGroup.visible = showNormalWalls;
    if (this.problemOffsetMesh) {
      this.problemOffsetMesh.visible = o.showOffset && showBody && o.showProblemMarkers;
    }
    if (this.problemGroup) this.problemGroup.visible = showProblemWalls;
    if (this.sourceGhost) this.sourceGhost.visible = o.showSourceOverlay;
    if (this.sourceEdges) this.sourceEdges.visible = o.showSourceOverlay;
    if (this.boundaryLines) this.boundaryLines.visible = o.showSourceOverlay;

    for (const mesh of [this.originalMesh, this.offsetMesh, this.normalWall?.mesh, this.problemWall?.mesh, this.problemOffsetMesh]) {
      if (!mesh) continue;
      const material = mesh.material as THREE.MeshStandardMaterial;
      const isWall = mesh === this.normalWall?.mesh || mesh === this.problemWall?.mesh;
      const opacity = mesh === this.problemOffsetMesh ? 0.72 : isWall ? o.opacity : o.opacity * 0.96;
      material.opacity = opacity;
      material.transparent = opacity < 0.999;
      material.depthWrite = opacity >= 0.999;
      material.wireframe = mesh === this.problemOffsetMesh ? false : o.wireframe;
      material.needsUpdate = true;
    }

    // 侧壁隔离/外移: 沿各自法线方向整体平移
    const explode = o.explodeSideWalls;
    this.wallGroup.position.set(0, 0, 0);
    this.problemGroup.position.set(0, 0, 0);
    if (explode > 0 && this.solid) {
      const normalPush = this.meanOutward(this.solid, 'normal').multiplyScalar(explode);
      this.wallGroup.position.copy(normalPush);
      const problemPush = this.meanOutward(this.solid, 'problem').multiplyScalar(explode * 1.8);
      this.problemGroup.position.copy(problemPush);
    }
  }

  private meanOutward(solid: ThickenedSolid, kind: 'normal' | 'problem'): THREE.Vector3 {
    const normal = new THREE.Vector3();
    let count = 0;
    for (const wall of solid.sideWalls) {
      const isProblem = wall.problem;
      if ((kind === 'problem') !== isProblem) continue;
      normal.add(new THREE.Vector3(...wall.outwardNormal));
      count++;
    }
    if (count > 0) normal.divideScalar(count);
    if (normal.lengthSq() < 1e-8) normal.set(0, 0, 1);
    return normal.normalize();
  }

  private clear(): void {
    for (const group of [this.originalGroup, this.offsetGroup, this.wallGroup, this.problemGroup, this.overlayGroup]) {
      for (const child of [...group.children]) {
        group.remove(child);
        disposeObject(child);
      }
      group.position.set(0, 0, 0);
    }
    this.wallPickables.length = 0;
    this.surfacePickables.length = 0;
    this.originalMesh = null;
    this.offsetMesh = null;
    this.normalWall = null;
    this.problemWall = null;
    this.problemOffsetMesh = null;
    this.sourceGhost = null;
    this.sourceEdges = null;
    this.boundaryLines = null;
    this.selectionOutline = null;
  }

  dispose(): void {
    this.clear();
    this.root.clear();
  }
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else if (material) (material as THREE.Material).dispose();
  });
}
