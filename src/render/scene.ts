/**
 * three.js 渲染层: 低多边形布面 + 线框/顶点覆盖层 + 固定点标记 + 碰撞球.
 * 拓扑只构建一次, 每帧从 ClothSimulation 的位置数组同步坐标.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { ClothSimulation } from '../sim/cloth';
import type { Scenario } from '../sim/scenarios';

const CLOTH_COLOR = 0x4f9de8;
const WIRE_COLOR = 0x0f2540;
const PIN_COLOR = 0xff3b30;
const SPHERE_COLOR = 0xf2a541;

export class ClothRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;

  private sim: ClothSimulation;
  private clothMesh!: THREE.Mesh;
  private clothGeometry!: THREE.BufferGeometry;
  /** 非索引几何体每个顶点对应的粒子索引 */
  private particleRef!: Uint16Array;
  private positionAttr!: THREE.BufferAttribute;

  private wireLines!: THREE.LineSegments;
  private vertexPoints!: THREE.Points;
  private sphereMesh!: THREE.Mesh;
  private sphereGeometry!: THREE.IcosahedronGeometry;
  private pinGroup = new THREE.Group();
  private pinMarkers = new Map<number, THREE.Mesh>();
  private pinMarkerGeo = new THREE.OctahedronGeometry(0.1, 0);

  private resizeObserver: ResizeObserver;

  constructor(private container: HTMLElement, sim: ClothSimulation) {
    this.sim = sim;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x10151d);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    this.camera.position.set(5, 3.5, 7);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(0, 1.2, 0);

    this.setupLights();
    this.setupGround();
    this.buildCloth(sim);
    this.buildSphere(sim);
    this.scene.add(this.pinGroup);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  private setupLights(): void {
    const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x2a2f38, 1.1);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.6);
    dir.position.set(5, 9, 6);
    dir.castShadow = true;
    dir.shadow.mapSize.set(1024, 1024);
    dir.shadow.camera.left = -7;
    dir.shadow.camera.right = 7;
    dir.shadow.camera.top = 7;
    dir.shadow.camera.bottom = -7;
    this.scene.add(dir);
  }

  private setupGround(): void {
    const grid = new THREE.GridHelper(14, 28, 0x3a4657, 0x232b36);
    grid.position.y = -3.2;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.6;
    this.scene.add(grid);
  }

  private buildCloth(sim: ClothSimulation): void {
    const { cols, rows } = sim;

    // 非索引三角形: 每个单元格两个三角形, 平面着色呈现低多边形面片
    const refs: number[] = [];
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = sim.index(r, c);
        const b = sim.index(r, c + 1);
        const d = sim.index(r + 1, c);
        const e = sim.index(r + 1, c + 1);
        refs.push(a, d, b, b, d, e);
      }
    }
    this.particleRef = Uint16Array.from(refs);
    const positions = new Float32Array(this.particleRef.length * 3);

    this.clothGeometry = new THREE.BufferGeometry();
    this.positionAttr = new THREE.BufferAttribute(positions, 3);
    this.clothGeometry.setAttribute('position', this.positionAttr);
    this.clothGeometry.computeVertexNormals();

    const material = new THREE.MeshStandardMaterial({
      color: CLOTH_COLOR,
      side: THREE.DoubleSide,
      flatShading: true,
      roughness: 0.85,
      metalness: 0.05,
    });
    this.clothMesh = new THREE.Mesh(this.clothGeometry, material);
    this.clothMesh.castShadow = true;
    this.scene.add(this.clothMesh);

    // 线框覆盖层: 直接由网格边 (sim 的结构/剪切约束) 生成, 每帧同步
    const lineVerts: number[] = [];
    for (let n = 0; n < sim.constraintA.length; n++) {
      if (!sim.constraintIsEdge[n]) continue;
      lineVerts.push(sim.constraintA[n], sim.constraintB[n]);
    }
    const linePositions = new Float32Array(lineVerts.length * 3);
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));
    const lineMat = new THREE.LineBasicMaterial({
      color: WIRE_COLOR,
      transparent: true,
      opacity: 0.55,
    });
    this.wireLines = new THREE.LineSegments(lineGeo, lineMat);
    this.wireLines.visible = false;
    this.scene.add(this.wireLines);
    this.lineParticlePairs = Uint16Array.from(lineVerts);

    // 顶点覆盖层
    const pointPositions = new Float32Array(sim.particleCount * 3);
    const pointGeo = new THREE.BufferGeometry();
    pointGeo.setAttribute('position', new THREE.BufferAttribute(pointPositions, 3));
    const pointMat = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.06,
      sizeAttenuation: true,
    });
    this.vertexPoints = new THREE.Points(pointGeo, pointMat);
    this.vertexPoints.visible = false;
    this.scene.add(this.vertexPoints);
  }

  private lineParticlePairs = new Uint16Array(0);

  private buildSphere(sim: ClothSimulation): void {
    this.sphereGeometry = new THREE.IcosahedronGeometry(sim.sphere.radius, 2);
    const mat = new THREE.MeshStandardMaterial({
      color: SPHERE_COLOR,
      flatShading: true,
      roughness: 0.6,
      metalness: 0.1,
      transparent: true,
      opacity: 0.9,
    });
    this.sphereMesh = new THREE.Mesh(this.sphereGeometry, mat);
    this.sphereMesh.castShadow = true;
    this.scene.add(this.sphereMesh);
  }

  setSphereActive(active: boolean): void {
    const mat = this.sphereMesh.material as THREE.MeshStandardMaterial;
    mat.opacity = active ? 0.9 : 0.18;
    mat.wireframe = !active;
  }

  setWireframe(on: boolean): void {
    this.wireLines.visible = on;
    this.vertexPoints.visible = on;
  }

  setScenario(scenario: Scenario, sim: ClothSimulation): void {
    this.sim = sim;
    // 相机按预设就位
    const { azimuth, polar, distance } = scenario.camera;
    const target = new THREE.Vector3(0, 1.2, 0);
    this.camera.position.setFromSphericalCoords(distance, polar, azimuth).add(target);
    this.controls.target.copy(target);
    this.controls.update();
    this.setSphereActive(scenario.sphereActive);
  }

  /** 球半径变化需要重建低多边形几何体 */
  setSphereRadius(radius: number): void {
    this.sphereMesh.geometry.dispose();
    this.sphereMesh.geometry = new THREE.IcosahedronGeometry(radius, 2);
  }

  /** 每帧: 把模拟位置写入 GPU 缓冲, 更新固定点标记与球 */
  sync(): void {
    const sim = this.sim;
    const pos = sim.pos;

    // 布面 (非索引, 按 particleRef 展开)
    const clothArr = this.positionAttr.array as Float32Array;
    for (let v = 0; v < this.particleRef.length; v++) {
      const p = this.particleRef[v] * 3;
      const o = v * 3;
      clothArr[o] = pos[p];
      clothArr[o + 1] = pos[p + 1];
      clothArr[o + 2] = pos[p + 2];
    }
    this.positionAttr.needsUpdate = true;
    this.clothGeometry.computeVertexNormals();

    // 线框边
    const lineAttr = this.wireLines.geometry.getAttribute('position') as THREE.BufferAttribute;
    const lineArr = lineAttr.array as Float32Array;
    for (let i = 0; i < this.lineParticlePairs.length; i += 2) {
      const pa = this.lineParticlePairs[i] * 3;
      const pb = this.lineParticlePairs[i + 1] * 3;
      const o = i * 3;
      lineArr[o] = pos[pa];
      lineArr[o + 1] = pos[pa + 1];
      lineArr[o + 2] = pos[pa + 2];
      lineArr[o + 3] = pos[pb];
      lineArr[o + 4] = pos[pb + 1];
      lineArr[o + 5] = pos[pb + 2];
    }
    lineAttr.needsUpdate = true;

    // 顶点 (Float32Array.set 可直接接受 Float64Array)
    const pointAttr = this.vertexPoints.geometry.getAttribute('position') as THREE.BufferAttribute;
    (pointAttr.array as Float32Array).set(pos);
    pointAttr.needsUpdate = true;

    // 固定点标记: 与 sim.pinned 同步增删
    const pinnedNow = new Set<number>();
    for (let i = 0; i < sim.particleCount; i++) {
      if (!sim.pinned[i]) continue;
      pinnedNow.add(i);
      let marker = this.pinMarkers.get(i);
      if (!marker) {
        marker = new THREE.Mesh(
          this.pinMarkerGeo,
          new THREE.MeshBasicMaterial({ color: PIN_COLOR }),
        );
        this.pinMarkers.set(i, marker);
        this.pinGroup.add(marker);
      }
      marker.position.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    }
    for (const [idx, marker] of this.pinMarkers) {
      if (!pinnedNow.has(idx)) {
        this.pinGroup.remove(marker);
        (marker.material as THREE.Material).dispose();
        this.pinMarkers.delete(idx);
      }
    }

    // 球
    this.sphereMesh.position.set(sim.sphere.x, sim.sphere.y, sim.sphere.z);
  }

  resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  render(): void {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.clothGeometry.dispose();
    this.sphereGeometry.dispose();
    this.pinMarkerGeo.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
