// 单组阴影诊断场景台：three.js 渲染 + 可视化辅助 + 诊断数据采集
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { createMesh, createGround, createGrid } from './geometry.js';
import { convexHullXZ } from '../diag/engine.js';
import { GROUND_SIZE, OBJECT_DEFS, objectRadius, lightDirection } from '../diag/scene-config.js';

const STATE_COLORS = {
  inside: 0x3ddc84,
  'outside-h': 0xff4d4d,
  'outside-far': 0xff8a3d,
  'outside-near': 0xffd23d,
};

export class ShadowBench {
  constructor(container, params) {
    this.container = container;
    this.params = { ...params };
    this.objectDefs = OBJECT_DEFS.map((d) => ({ ...d, position: [...d.position] }));
    this._listeners = new Set();

    this._initRenderer();
    this._initScene();
    this._initControls();
    this._initOverlays();
    this.applyParams(this.params, true);
    this._onResize = () => this.resize();
    this.resizeObserver = new ResizeObserver(this._onResize);
    this.resizeObserver.observe(container);
    this._loop = this._loop.bind(this);
    this._dirty = true;
    this._raf = requestAnimationFrame(this._loop);
  }

  // ------------------------------------------------------------ 初始化

  _initRenderer() {
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 600;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 500);
    this.camera.position.set(16, 12, 20);
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x14171f);
    this.scene.fog = new THREE.Fog(0x14171f, 70, 160);

    const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x3a3f4d, 0.55);
    this.scene.add(hemi);

    this.dirLight = new THREE.DirectionalLight(0xffffff, 2.2);
    this.dirLight.castShadow = true;
    this.dirLight.shadow.mapSize.set(2048, 2048);
    const cam = this.dirLight.shadow.camera;
    cam.near = 0.5;
    cam.far = 100;
    cam.left = -20;
    cam.right = 20;
    cam.top = 20;
    cam.bottom = -20;
    cam.updateProjectionMatrix();
    this.dirLight.shadow.bias = -0.0008;
    this.dirLight.shadow.normalBias = 0.03;
    this.scene.add(this.dirLight);
    this.scene.add(this.dirLight.target);

    this.scene.add(createGround(GROUND_SIZE));
    this.scene.add(createGrid(GROUND_SIZE));

    this.meshes = new Map();
    for (const def of this.objectDefs) {
      const mesh = createMesh(def);
      this.meshes.set(def.id, mesh);
      this.scene.add(mesh);
    }
  }

  _initControls() {
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.target.set(0, 1.5, -3);
    this.orbit.maxPolarAngle = Math.PI / 2 - 0.02;
    this.orbit.addEventListener('change', () => this._markDirty());

    this.transform = new TransformControls(this.camera, this.renderer.domElement);
    this.transform.addEventListener('dragging-changed', (e) => {
      this.orbit.enabled = !e.value;
    });
    this.transform.addEventListener('objectChange', () => {
      const mesh = this.transform.object;
      if (!mesh) return;
      const def = this.objectDefs.find((d) => d.id === mesh.userData.id);
      def.position = mesh.position.toArray();
      this._markDirty();
      this._emit('objects');
    });
    this.scene.add(this.transform.getHelper ? this.transform.getHelper() : this.transform);
  }

  _initOverlays() {
    // 阴影截锥线框（盒体几何，每帧按光空间参数定位）
    this.frustumBox = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: 0xffd23d, transparent: true, opacity: 0.9 }),
    );
    this.scene.add(this.frustumBox);

    // 阴影在地面的覆盖区填充 + 描边
    this.footprintMesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({
        color: 0xffd23d,
        transparent: true,
        opacity: 0.16,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    this.footprintMesh.renderOrder = 2;
    this.scene.add(this.footprintMesh);
    this.footprintLine = new THREE.LineLoop(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xffd23d, transparent: true, opacity: 0.95 }),
    );
    this.footprintLine.renderOrder = 3;
    this.scene.add(this.footprintLine);

    // 相机视野在地面的多边形（填充 + 描边）
    this.viewMesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({
        color: 0x4da6ff,
        transparent: true,
        opacity: 0.14,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    this.viewMesh.renderOrder = 1;
    this.scene.add(this.viewMesh);
    this.viewLine = new THREE.LineLoop(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0x4da6ff, transparent: true, opacity: 0.9 }),
    );
    this.viewLine.renderOrder = 3;
    this.scene.add(this.viewLine);

    // 物体状态描边（用稍大的线框球表示包围球与状态颜色）
    this.statusRings = new Map();
    for (const def of this.objectDefs) {
      const r = objectRadius(def);
      const ring = new THREE.Mesh(
        new THREE.SphereGeometry(r, 16, 12),
        new THREE.MeshBasicMaterial({ color: STATE_COLORS.inside, wireframe: true, transparent: true, opacity: 0.35 }),
      );
      ring.position.fromArray(def.position);
      ring.visible = false;
      this.scene.add(ring);
      this.statusRings.set(def.id, ring);
    }
  }

  // ------------------------------------------------------------ 参数应用

  applyParams(params, forceLightMove = false) {
    const prev = this.params;
    this.params = { ...this.params, ...params };
    const p = this.params;
    const lightMoved =
      forceLightMove ||
      prev.azimuth !== p.azimuth ||
      prev.elevation !== p.elevation;

    if (lightMoved) {
      const dir = lightDirection(p.azimuth, p.elevation);
      // 光源放在目标点沿 -dir 足够远处，保证 near/far 区间包住场景
      const dist = p.near + 40;
      this.dirLight.position.set(
        -dir[0] * dist,
        -dir[1] * dist,
        -dir[2] * dist,
      );
      this.dirLight.target.position.set(0, 0, 0);
    }

    const cam = this.dirLight.shadow.camera;
    const h = p.orthoSize / 2;
    cam.left = -h;
    cam.right = h;
    cam.top = h;
    cam.bottom = -h;
    cam.near = p.near;
    cam.far = p.far;
    cam.updateProjectionMatrix();

    if (prev.mapSize !== p.mapSize || forceLightMove) {
      this.dirLight.shadow.mapSize.set(p.mapSize, p.mapSize);
      if (this.dirLight.shadow.map) {
        this.dirLight.shadow.map.dispose();
        this.dirLight.shadow.map = null;
      }
    }
    this.dirLight.shadow.bias = p.bias;
    this.dirLight.shadow.normalBias = p.normalBias;
    this._markDirty();
  }

  // ------------------------------------------------------------ 诊断数据

  /** 构造引擎所需的场景描述符 */
  getDescriptor() {
    return {
      scene: { groundSize: GROUND_SIZE },
      params: {
        ...this.params,
        lightDir: lightDirection(this.params.azimuth, this.params.elevation),
        lightTarget: [0, 0, 0],
      },
      camera: {
        position: this.camera.position.toArray(),
        target: this.orbit.target.toArray(),
        fov: this.camera.fov,
        aspect: this.camera.aspect,
      },
      objects: this.objectDefs.map((d) => ({
        id: d.id,
        label: d.label,
        position: [...d.position],
        radius: objectRadius(d),
      })),
    };
  }

  // ------------------------------------------------------------ 可视化更新

  updateOverlays(report) {
    const p = this.params;
    const frame = report.frame;
    const half = report.half;
    const depth = report.depth;

    // 1) 截锥盒：光空间中近平面 z=-near、远平面 z=depth-near，盒中心 z=depth/2-near
    const centerLS = [0, 0, depth / 2 - p.near];
    const basis = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(...frame.xAxis),
      new THREE.Vector3(...frame.yAxis),
      new THREE.Vector3(...frame.zAxis),
    );
    const center = new THREE.Vector3()
      .addScaledVector(new THREE.Vector3(...frame.xAxis), centerLS[0])
      .addScaledVector(new THREE.Vector3(...frame.yAxis), centerLS[1])
      .addScaledVector(new THREE.Vector3(...frame.zAxis), centerLS[2])
      .add(new THREE.Vector3(...frame.origin));
    this.frustumBox.position.copy(center);
    this.frustumBox.quaternion.setFromRotationMatrix(basis);
    this.frustumBox.scale.set(p.orthoSize, p.orthoSize, depth);

    // 2) 地面覆盖区：截锥盒 12 条边与 y=0 求交，取凸包
    const footprint = this._frustumGroundPolygon(frame, half, p.near, depth);
    this._fillPolygon(this.footprintMesh, footprint);
    this._fillLine(this.footprintLine, footprint);

    // 3) 相机视野地面多边形
    this._fillPolygon(this.viewMesh, report.viewPoly || []);
    this._fillLine(this.viewLine, report.viewPoly || []);

    // 4) 物体状态描边
    for (const r of report.objectReports) {
      const ring = this.statusRings.get(r.id);
      const def = this.objectDefs.find((d) => d.id === r.id);
      ring.position.fromArray(def.position);
      if (r.state === 'inside') {
        ring.visible = false;
      } else {
        ring.visible = true;
        ring.material.color.setHex(STATE_COLORS[r.state]);
        ring.material.opacity = r.inView ? 0.55 : 0.25;
      }
    }
  }

  /** 截锥盒边与地面交点 -> 凸包多边形 */
  _frustumGroundPolygon(frame, half, near, depth) {
    const corners = [];
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        for (const sz of [0, 1]) {
          const ls = [sx * half, sy * half, -near + sz * depth];
          corners.push(
            new THREE.Vector3()
              .addScaledVector(new THREE.Vector3(...frame.xAxis), ls[0])
              .addScaledVector(new THREE.Vector3(...frame.yAxis), ls[1])
              .addScaledVector(new THREE.Vector3(...frame.zAxis), ls[2])
              .add(new THREE.Vector3(...frame.origin)),
          );
        }
      }
    }
    // 立方体 12 条边（按角点索引）
    const edges = [
      [0, 1], [1, 3], [3, 2], [2, 0],
      [4, 5], [5, 7], [7, 6], [6, 4],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ];
    const pts = [];
    for (const [i, j] of edges) {
      const a = corners[i];
      const b = corners[j];
      if ((a.y <= 0 && b.y >= 0) || (a.y >= 0 && b.y <= 0)) {
        const t = a.y / (a.y - b.y);
        pts.push([a.x + (b.x - a.x) * t, 0, a.z + (b.z - a.z) * t]);
      }
      if (Math.abs(a.y) < 1e-6) pts.push([a.x, 0, a.z]);
    }
    if (pts.length < 3) return [];
    return convexHullXZ(pts);
  }

  _fillPolygon(mesh, worldPoints) {
    mesh.geometry.dispose();
    if (!worldPoints || worldPoints.length < 3) {
      mesh.geometry = new THREE.BufferGeometry();
      return;
    }
    const n = worldPoints.length;
    const positions = new Float32Array(n * 3);
    worldPoints.forEach((p, i) => positions.set(p, i * 3));
    const indices = [];
    for (let i = 1; i < n - 1; i++) indices.push(0, i, i + 1);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    mesh.geometry = geo;
  }

  _fillLine(line, worldPoints) {
    line.geometry.dispose();
    if (!worldPoints || worldPoints.length < 3) {
      line.geometry = new THREE.BufferGeometry();
      return;
    }
    const positions = new Float32Array(worldPoints.length * 3);
    worldPoints.forEach((p, i) => positions.set(p, i * 3));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    line.geometry = geo;
  }

  // ------------------------------------------------------------ 物体交互

  selectObject(id) {
    if (!id) {
      this.transform.detach();
      return;
    }
    const mesh = this.meshes.get(id);
    if (mesh) this.transform.attach(mesh);
  }

  setMoveEnabled(on) {
    if (!on) this.transform.detach();
    this._moveEnabled = on;
  }

  isMoveEnabled() {
    return this._moveEnabled !== false;
  }

  setView(position, target) {
    this.camera.position.fromArray(position);
    this.orbit.target.fromArray(target);
    this.orbit.update();
    this._markDirty();
  }

  getView() {
    return {
      position: this.camera.position.toArray(),
      target: this.orbit.target.toArray(),
    };
  }

  /** 把相机对齐到另一台 bench（对比模式同步视角） */
  syncCameraFrom(other) {
    const v = other.getView();
    this.camera.position.fromArray(v.position);
    this.orbit.target.fromArray(v.target);
    this.orbit.update();
    this._markDirty();
  }

  syncObjectsFrom(other) {
    for (const def of this.objectDefs) {
      const src = other.objectDefs.find((d) => d.id === def.id);
      def.position = [...src.position];
      const mesh = this.meshes.get(def.id);
      mesh.position.fromArray(def.position);
      const ring = this.statusRings.get(def.id);
      ring.position.fromArray(def.position);
    }
    this._markDirty();
  }

  resetObjects() {
    OBJECT_DEFS.forEach((orig, i) => {
      this.objectDefs[i].position = [...orig.position];
      const mesh = this.meshes.get(orig.id);
      mesh.position.fromArray(orig.position);
      this.statusRings.get(orig.id).position.fromArray(orig.position);
    });
    this.transform.detach();
    this._markDirty();
  }

  // ------------------------------------------------------------ 尺寸与循环

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this._markDirty();
  }

  on(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit(type) {
    for (const fn of this._listeners) fn(type);
  }

  _markDirty() {
    this._dirty = true;
  }

  _loop() {
    this._raf = requestAnimationFrame(this._loop);
    this.orbit.update();
    this.renderer.render(this.scene, this.camera);
    if (this._dirty) {
      this._dirty = false;
      this._emit('update');
    }
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    this.resizeObserver.disconnect();
    this.transform.dispose();
    this.orbit.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
