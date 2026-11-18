import * as THREE from 'three';
import { buildChunkGeometryData } from '../voxel/mesher.js';
import { MATERIALS, TRANSPARENT_MATERIAL_IDS } from '../voxel/materials.js';
import { sortIndicesBackToFront } from './transparentSort.js';

/**
 * 管理世界里每个块的网格。
 *
 * 不变量：
 * - 每个块始终根据“当前世界数据 + 世界坐标邻居”重建；
 * - 重建前释放旧 geometry，避免旧面残留（缓冲区不会自动缩小）；
 * - 透明网格独立于不透明网格，使用更晚的 renderOrder。
 */
export class ChunkRenderer {
  constructor(world, scene) {
    this.world = world;
    this.scene = scene;
    this.root = new THREE.Group();
    this.root.name = 'voxel-chunks';
    scene.add(this.root);

    this.records = new Map();
    this.visibleFaceCount = 0;
    this.showWireframe = false;

    this.opaqueMaterial = new THREE.MeshLambertMaterial({
      vertexColors: true,
    });

    this.transparentMaterials = new Map();
    for (const id of TRANSPARENT_MATERIAL_IDS) {
      this.transparentMaterials.set(
        id,
        new THREE.MeshLambertMaterial({
          vertexColors: true,
          transparent: true,
          opacity: MATERIALS[id].opacity,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
    }

    this.boundaryGroup = new THREE.Group();
    this.boundaryGroup.name = 'chunk-boundaries';
    this.boundaryGroup.visible = false;
    scene.add(this.boundaryGroup);
    this.buildBoundaries();
  }

  buildBoundaries() {
    const lineMaterial = new THREE.LineBasicMaterial({
      color: 0x38e8c0,
      transparent: true,
      opacity: 0.65,
      depthTest: false,
    });
    this.boundaryGroup.clear();

    for (const chunk of this.world.chunks) {
      const geometry = new THREE.EdgesGeometry(
        new THREE.BoxGeometry(chunk.sizeX, chunk.sizeY, chunk.sizeZ),
      );
      const lines = new THREE.LineSegments(geometry, lineMaterial);
      lines.position.set(...chunk.center);
      lines.renderOrder = 10;
      lines.userData.chunkKey = chunk.key;
      this.boundaryGroup.add(lines);
    }
  }

  setBoundariesVisible(visible) {
    this.boundaryGroup.visible = visible;
  }

  setWireframe(enabled) {
    this.showWireframe = enabled;
    this.opaqueMaterial.wireframe = enabled;
    for (const material of this.transparentMaterials.values()) {
      material.wireframe = enabled;
    }
  }

  rebuildAll() {
    this.world.markAllDirty();
    this.rebuildDirty();
  }

  /** 只重建脏块，返回重建的块数。 */
  rebuildDirty() {
    const dirty = this.world.consumeDirtyChunks();
    for (const chunk of dirty) {
      this.rebuildChunk(chunk);
    }
    if (dirty.length > 0) {
      // 新几何的索引尚未按当前相机排序，下一帧必须重排。
      this.lastSortCamera = null;
    }
    this.updateFaceCount();
    return dirty.length;
  }

  /**
   * 每帧按相机位置对透明网格重排三角形索引。
   *
   * three.js 按对象距离排序，但同一块内的透明三角形顺序是固定的；
   * 相机移动后必须重新排序，否则透明交界会出现错误的遮挡观感。
   * 只在相机移动超过阈值时才重排，避免每帧分配。
   */
  updateTransparentSort(cameraPosition) {
    const last = this.lastSortCamera;
    const moved =
      !last ||
      (cameraPosition.x - last.x) ** 2 +
        (cameraPosition.y - last.y) ** 2 +
        (cameraPosition.z - last.z) ** 2 >
        0.04;

    if (!moved) return false;
    this.lastSortCamera = {
      x: cameraPosition.x,
      y: cameraPosition.y,
      z: cameraPosition.z,
    };

    for (const record of this.records.values()) {
      // 几何已烘焙为块局部坐标，排序时用相对块中心的相机位置。
      const center = record.center;
      const localCamera = {
        x: cameraPosition.x - center[0],
        y: cameraPosition.y - center[1],
        z: cameraPosition.z - center[2],
      };
      for (const [material, mesh] of record.transparentMeshes) {
        const geometry = mesh.geometry;
        const position = geometry.getAttribute('position').array;
        const source = record.transparentSources.get(material);
        if (!source) continue;
        const sorted = sortIndicesBackToFront(
          position,
          source,
          localCamera,
          record.transparentOrders.get(material),
        );
        const indexAttr = geometry.getIndex();
        indexAttr.array.set(sorted);
        indexAttr.needsUpdate = true;
      }
    }
    return true;
  }

  rebuildChunk(chunk) {
    this.disposeRecord(chunk.key);

    const group = new THREE.Group();
    group.name = `chunk:${chunk.key}`;
    group.userData.chunkKey = chunk.key;
    // 网格几何使用“以块中心为原点”的局部坐标，
    // 这样 three.js 的透明物体排序能拿到每块真实的相机距离。
    group.position.set(...chunk.center);

    const data = buildChunkGeometryData(this.world, chunk);
    const record = {
      group,
      center: chunk.center,
      opaqueMesh: null,
      transparentMeshes: new Map(),
      transparentSources: new Map(),
      transparentOrders: new Map(),
      faceCount: data.faceCount,
    };

    if (data.opaque.faceCount > 0) {
      const mesh = new THREE.Mesh(
        createGeometry(data.opaque, chunk.center),
        this.opaqueMaterial,
      );
      mesh.name = `opaque:${chunk.key}`;
      mesh.userData.chunkKey = chunk.key;
      mesh.userData.layer = 'opaque';
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      group.add(mesh);
      record.opaqueMesh = mesh;
    }

    for (const { material, data: geometryData } of data.transparent) {
      const materialDef = this.transparentMaterials.get(material);
      if (!materialDef || geometryData.faceCount === 0) continue;
      const mesh = new THREE.Mesh(
        createGeometry(geometryData, chunk.center),
        materialDef,
      );
      mesh.name = `transparent:${material}:${chunk.key}`;
      mesh.userData.chunkKey = chunk.key;
      mesh.userData.layer = 'transparent';
      mesh.userData.material = material;
      // 不透明物体先画；透明物体之间由 three.js 按相机距离排序。
      mesh.renderOrder = 2;
      group.add(mesh);
      record.transparentMeshes.set(material, mesh);
      // 记录原始索引；每帧排序都基于它，避免累积重排。
      record.transparentSources.set(
        material,
        Uint32Array.from(geometryData.indices),
      );
      record.transparentOrders.set(
        material,
        new Float64Array(geometryData.indices.length / 3),
      );
    }

    this.root.add(group);
    this.records.set(chunk.key, record);
  }

  disposeRecord(key) {
    const record = this.records.get(key);
    if (!record) return;
    this.root.remove(record.group);
    record.group.traverse((object) => {
      if (object.isMesh && object.geometry) object.geometry.dispose();
    });
    this.records.delete(key);
  }

  updateFaceCount() {
    let count = 0;
    for (const record of this.records.values()) count += record.faceCount;
    this.visibleFaceCount = count;
  }

  /** 射线拾取目标：只包含有几何数据的块网格。 */
  getPickMeshes() {
    const meshes = [];
    for (const record of this.records.values()) {
      if (record.opaqueMesh) meshes.push(record.opaqueMesh);
      for (const mesh of record.transparentMeshes.values()) meshes.push(mesh);
    }
    return meshes;
  }

  setSelectedChunkHighlight() {
    // 预留给“只查看某块”的扩展；当前不需要额外状态。
  }

  dispose() {
    for (const key of [...this.records.keys()]) this.disposeRecord(key);
    this.opaqueMaterial.dispose();
    for (const material of this.transparentMaterials.values()) {
      material.dispose();
    }
    this.boundaryGroup.traverse((object) => {
      if (object.geometry) object.geometry.dispose();
    });
    this.scene.remove(this.root);
    this.scene.remove(this.boundaryGroup);
  }
}

function createGeometry(data, origin) {
  const geometry = new THREE.BufferGeometry();
  // 把世界坐标烘焙成块局部坐标，供 group.position 平移回去。
  if (origin) {
    const [ox, oy, oz] = origin;
    for (let i = 0; i < data.positions.length; i += 3) {
      data.positions[i] -= ox;
      data.positions[i + 1] -= oy;
      data.positions[i + 2] -= oz;
    }
  }
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(data.positions, 3),
  );
  geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}
