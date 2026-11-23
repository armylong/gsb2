import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export interface ViewportOptions {
  container: HTMLElement;
  onResize?: (width: number, height: number) => void;
}

/**
 * 基础三维视口: 相机、光照、网格地面与轨道控制。
 * 所有几何内容由 SolidView / 其它层挂到 scene 上。
 */
export class Viewport {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;
  readonly content = new THREE.Group();
  readonly helpers = new THREE.Group();

  private readonly container: HTMLElement;
  private readonly resizeObserver: ResizeObserver;
  private readonly clock = new THREE.Clock();
  private frameHandle = 0;
  private disposed = false;

  constructor(options: ViewportOptions) {
    this.container = options.container;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height, false);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = false;
    this.renderer.domElement.classList.add('viewport-canvas');
    this.container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x0c1118);
    this.scene.fog = new THREE.Fog(0x0c1118, 6, 16);

    this.camera = new THREE.PerspectiveCamera(42, width / height, 0.01, 100);
    this.camera.position.set(1.9, -2.2, 1.7);
    this.camera.up.set(0, 0, 1);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 0.25;
    this.controls.maxDistance = 12;
    this.controls.target.set(0, 0, 0);

    const hemisphere = new THREE.HemisphereLight(0xd7e4ff, 0x1a2028, 1.15);
    this.scene.add(hemisphere);

    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(2.4, -2.8, 3.6);
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0x7fb0ff, 0.7);
    fill.position.set(-3, 2.4, 1.2);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xffd7a8, 0.45);
    rim.position.set(-1.2, -3.4, -1.6);
    this.scene.add(rim);

    const grid = new THREE.GridHelper(6, 30, 0x2a3646, 0x1b2431);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = -0.001;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.65;
    this.helpers.add(grid);

    this.scene.add(this.content);
    this.scene.add(this.helpers);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.resize();
    this.animate();
  }

  resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.controls.update();
  }

  private animate = (): void => {
    if (this.disposed) return;
    this.frameHandle = requestAnimationFrame(this.animate);
    const delta = this.clock.getDelta();
    void delta;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameHandle);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
