/**
 * 单个地形块的 three.js 视图:填充网格 + 可选线框覆盖,
 * 并负责几何资源的释放,避免层级切换后旧 BufferGeometry 累积。
 */
import * as THREE from 'three';
import type { ChunkMeshData } from '../terrain/chunkMesher';

export type DisplayMode = 'fill' | 'wire' | 'both';

export class ChunkView {
  readonly group = new THREE.Group();
  private fillMesh: THREE.Mesh | null = null;
  private wireMesh: THREE.LineSegments | null = null;
  private geometry: THREE.BufferGeometry | null = null;
  private lod = -1;

  constructor(
    private readonly fillMaterial: THREE.Material,
    private readonly wireMaterial: THREE.LineBasicMaterial,
  ) {}

  get currentLod(): number {
    return this.lod;
  }

  get hasGeometry(): boolean {
    return this.geometry !== null;
  }

  setMesh(data: ChunkMeshData): void {
    this.disposeGeometry();

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
    geo.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geo.computeBoundingSphere();
    this.geometry = geo;

    this.fillMesh = new THREE.Mesh(geo, this.fillMaterial);
    this.fillMesh.matrixAutoUpdate = false;
    this.group.add(this.fillMesh);

    const wireGeo = new THREE.WireframeGeometry(geo);
    this.wireMesh = new THREE.LineSegments(wireGeo, this.wireMaterial);
    // 线框略微抬升,避免与填充面共面闪烁
    this.wireMesh.position.y = 0.04;
    this.group.add(this.wireMesh);

    this.lod = data.lod;
    this.applyMode(this.lastMode);
  }

  private lastMode: DisplayMode = 'fill';

  applyMode(mode: DisplayMode): void {
    this.lastMode = mode;
    if (this.fillMesh) this.fillMesh.visible = mode === 'fill' || mode === 'both';
    if (this.wireMesh) this.wireMesh.visible = mode === 'wire' || mode === 'both';
  }

  disposeGeometry(): void {
    if (this.fillMesh) {
      this.group.remove(this.fillMesh);
      this.fillMesh = null;
    }
    if (this.wireMesh) {
      this.group.remove(this.wireMesh);
      this.wireMesh.geometry.dispose(); // WireframeGeometry 是独立资源
      this.wireMesh = null;
    }
    if (this.geometry) {
      this.geometry.dispose();
      this.geometry = null;
    }
    this.lod = -1;
  }
}
