// 单个 Three.js 视口 + 双视口相机同步。

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { frameParams } from './scene-builder.js';

export class Viewport {
  constructor(container, label) {
    this.container = container;
    this.label = label;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x10151d);

    const w = container.clientWidth || 400;
    const h = container.clientHeight || 400;
    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.01, 5000);
    this.camera.position.set(2.2, 1.6, 2.6);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;

    // 光照：平行光 + 弱环境光 + 半球光，明暗差异足够明显
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(3, 4, 2);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xbfd8ff, 0.5);
    fill.position.set(-3, -1, -2);
    this.scene.add(fill);

    this.modelRoot = new THREE.Group();
    this.overlayRoot = new THREE.Group();
    this.scene.add(this.modelRoot, this.overlayRoot);

    this._grid = null;
    this.onPick = null;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.renderer.domElement.addEventListener('click', (e) => this._handleClick(e));
  }

  showGrid(scale) {
    if (this._grid) this.scene.remove(this._grid);
    const size = Math.max(2, scale * 2.4);
    this._grid = new THREE.GridHelper(size, 20, 0x3b4a63, 0x222c3c);
    this._grid.position.y = -scale * 0.62;
    this.scene.add(this._grid);
  }

  frameModel(positions) {
    const { center, dist } = frameParams(positions, 45);
    this.controls.target.set(center[0], center[1], center[2]);
    const dir = new THREE.Vector3(0.7, 0.5, 0.9).normalize();
    this.camera.position.copy(
      new THREE.Vector3(center[0], center[1], center[2]).add(dir.multiplyScalar(dist)));
    this.controls.update();
  }

  clearModel() {
    for (const root of [this.modelRoot, this.overlayRoot]) {
      for (const child of [...root.children]) {
        child.traverse?.((o) => {
          o.geometry?.dispose?.();
          if (o.material) {
            (Array.isArray(o.material) ? o.material : [o.material])
              .forEach((m) => m.dispose?.());
          }
        });
        root.remove(child);
      }
    }
  }

  addModelObject(obj) {
    this.modelRoot.add(obj);
  }

  addOverlay(obj) {
    this.overlayRoot.add(obj);
  }

  setPickable(mesh) {
    this.pickMesh = mesh;
  }

  _handleClick(event) {
    if (!this.onPick || !this.pickMesh) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.pickMesh, false);
    if (hits.length) this.onPick(hits[0], this.label);
  }

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  render() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  // 从另一个视口同步相机（OrbitControls 同步循环由 syncPair 防重入）
  syncFrom(other) {
    this.camera.position.copy(other.camera.position);
    this.controls.target.copy(other.controls.target);
    this.camera.up.copy(other.camera.up);
    this.controls.update();
  }
}

// 双向同步一对视口：任一方交互，另一方跟随；程序触发的同步不再回传
export function syncPair(vpA, vpB) {
  let syncing = false;
  const link = (src, dst) => {
    src.controls.addEventListener('change', () => {
      if (syncing) return;
      syncing = true;
      dst.syncFrom(src);
      dst.render();
      syncing = false;
    });
  };
  link(vpA, vpB);
  link(vpB, vpA);
}
