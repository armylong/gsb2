// 三维场景：听者/声源的可视化与拖拽交互。
// 场景本身不持有业务状态，每帧从 Store 读取最新状态同步位置，保证画面与声音共用同一数据源。
import * as THREE from '../vendor/three/three.module.js';
import { OrbitControls } from '../vendor/three/OrbitControls.js';
import { BOUNDS } from './spatial.js';

const UP = new THREE.Vector3(0, 1, 0);

export class SceneView {
  constructor(container, store) {
    this.container = container;
    this.store = store;
    this._dragging = null;

    const width = container.clientWidth;
    const height = container.clientHeight;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x10151f);

    this.camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 200);
    this.camera.position.set(10, 9, 13);

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.maxPolarAngle = Math.PI * 0.49;
    this.orbit.minDistance = 4;
    this.orbit.maxDistance = 40;

    this._buildEnvironment();
    this._buildEntities();
    this._buildLabels();

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this._bindPointerEvents();

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
  }

  _buildEnvironment() {
    const grid = new THREE.GridHelper(BOUNDS.x * 2, 24, 0x3a4a63, 0x232d3d);
    grid.position.y = -BOUNDS.y;
    this.scene.add(grid);

    // 边界框
    const boxGeo = new THREE.BoxGeometry(BOUNDS.x * 2, BOUNDS.y * 2, BOUNDS.z * 2);
    const edges = new THREE.EdgesGeometry(boxGeo);
    const frame = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: 0x4a5d7a, transparent: true, opacity: 0.6 }),
    );
    this.scene.add(frame);

    const axes = new THREE.AxesHelper(2);
    axes.position.set(-BOUNDS.x + 0.2, -BOUNDS.y + 0.05, -BOUNDS.z + 0.2);
    this.scene.add(axes);

    // 半球光 + 平行光，避免纯色模型缺乏立体感
    this.scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x202838, 1.1));
    const dir = new THREE.DirectionalLight(0xffffff, 1.4);
    dir.position.set(8, 14, 6);
    this.scene.add(dir);
  }

  _buildEntities() {
    const state = this.store.state;

    // 听者：椎体（指向朝向）+ 基座球
    this.listenerGroup = new THREE.Group();
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.32, 24, 18),
      new THREE.MeshStandardMaterial({ color: 0x7be0c9, emissive: 0x1d5f54, roughness: 0.4 }),
    );
    const nose = new THREE.Mesh(
      new THREE.ConeGeometry(0.18, 0.7, 18),
      new THREE.MeshStandardMaterial({ color: 0xd6fff6, emissive: 0x2a7d6e }),
    );
    nose.rotation.x = -Math.PI / 2; // 锥体默认朝 +y，转到 -z（yaw=0 的前方）
    nose.position.set(0, 0, -0.42);
    this.listenerGroup.add(head, nose);
    this.listenerGroup.userData = { kind: 'listener' };
    this.scene.add(this.listenerGroup);

    // 声源：带颜色的发光球 + 地面投影环
    this.sourceMeshes = new Map();
    state.sources.forEach((src) => {
      const group = new THREE.Group();
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.35, 24, 18),
        new THREE.MeshStandardMaterial({
          color: src.color,
          emissive: src.color,
          emissiveIntensity: 0.45,
          roughness: 0.35,
        }),
      );
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.5, 0.03, 10, 32),
        new THREE.MeshBasicMaterial({ color: src.color, transparent: true, opacity: 0.7 }),
      );
      ring.rotation.x = Math.PI / 2;
      group.add(sphere, ring);
      group.userData = { kind: 'source', id: src.id, ring };
      this.scene.add(group);
      this.sourceMeshes.set(src.id, group);
    });
  }

  _buildLabels() {
    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'label-layer';
    this.container.appendChild(this.labelLayer);

    this.listenerLabel = this._makeLabel('听者');
    this.sourceLabels = new Map();
    this.store.state.sources.forEach((src) => {
      this.sourceLabels.set(src.id, this._makeLabel(src.name));
    });
  }

  _makeLabel(text) {
    const el = document.createElement('div');
    el.className = 'scene-label';
    el.textContent = text;
    this.labelLayer.appendChild(el);
    return el;
  }

  _bindPointerEvents() {
    const dom = this.renderer.domElement;
    dom.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    window.addEventListener('pointermove', (e) => this._onPointerMove(e));
    window.addEventListener('pointerup', () => {
      if (this._dragging) {
        this._dragging = null;
        this.orbit.enabled = true;
        this.renderer.domElement.style.cursor = '';
      }
    });
  }

  _updatePointer(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  _onPointerDown(e) {
    if (e.button !== 0) return;
    this._updatePointer(e);
    const pickables = [this.listenerGroup, ...this.sourceMeshes.values()];
    const hits = this.raycaster.intersectObjects(pickables, true);
    if (hits.length === 0) return;

    let obj = hits[0].object;
    while (obj && !obj.userData.kind) obj = obj.parent;
    if (!obj) return;

    e.stopPropagation();
    this.orbit.enabled = false;
    this.renderer.domElement.style.cursor = 'grabbing';

    const kind = obj.userData.kind;
    const plane = new THREE.Plane();
    if (kind === 'listener') {
      // 听者沿水平面（y 固定）拖动
      plane.setFromNormalAndCoplanarPoint(UP, this.listenerGroup.position);
    } else if (e.shiftKey) {
      // Shift + 拖动声源：沿过声源且平行于相机视线的竖直平面移动，用来调高度
      const normal = new THREE.Vector3();
      this.camera.getWorldDirection(normal);
      const p = this.sourceMeshes.get(obj.userData.id).position.clone();
      plane.setFromNormalAndCoplanarPoint(normal, p);
    } else {
      plane.setFromNormalAndCoplanarPoint(UP, this.sourceMeshes.get(obj.userData.id).position.clone());
    }
    this._dragging = { kind, id: obj.userData.id, plane };
  }

  _onPointerMove(e) {
    if (!this._dragging) {
      this._updatePointer(e);
      const pickables = [this.listenerGroup, ...this.sourceMeshes.values()];
      const hits = this.raycaster.intersectObjects(pickables, true);
      this.renderer.domElement.style.cursor = hits.length ? 'grab' : '';
      return;
    }
    this._updatePointer(e);
    const point = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this._dragging.plane, point)) return;

    const { kind, id } = this._dragging;
    if (kind === 'listener') {
      this.store.setListenerPosition(point.x, this.store.state.listener.y, point.z);
    } else {
      this.store.setSourcePosition(id, point.x, point.y, point.z);
    }
  }

  // 外部（面板/快捷键）旋转听者朝向
  rotateListener(deltaDeg) {
    this.store.setListenerYaw(this.store.state.listener.yaw + deltaDeg);
  }

  _projectLabel(el, worldPos) {
    const v = worldPos.clone().project(this.camera);
    const visible = v.z < 1;
    el.style.display = visible ? 'block' : 'none';
    const rect = this.renderer.domElement.getBoundingClientRect();
    el.style.left = `${(v.x * 0.5 + 0.5) * rect.width}px`;
    el.style.top = `${(-v.y * 0.5 + 0.5) * rect.height}px`;
  }

  resize() {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  render() {
    const state = this.store.state;
    const { listener, sources } = state;

    this.listenerGroup.position.set(listener.x, listener.y, listener.z);
    this.listenerGroup.rotation.y = (listener.yaw * Math.PI) / 180;

    sources.forEach((src) => {
      const group = this.sourceMeshes.get(src.id);
      group.position.set(src.x, src.y, src.z);
      const ring = group.userData.ring;
      ring.rotation.z += 0.02;
      const mat = group.children[0].material;
      // 播放中加亮，被独奏静音时压暗
      mat.emissiveIntensity = src.playing
        ? state.soloId && state.soloId !== src.id ? 0.15 : 0.9
        : 0.3;
    });

    this.orbit.update();
    this.renderer.render(this.scene, this.camera);

    this._projectLabel(this.listenerLabel, this.listenerGroup.position.clone().add(new THREE.Vector3(0, 0.7, 0)));
    sources.forEach((src) => {
      const group = this.sourceMeshes.get(src.id);
      this._projectLabel(this.sourceLabels.get(src.id), group.position.clone().add(new THREE.Vector3(0, 0.75, 0)));
    });
  }
}
