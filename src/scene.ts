import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createCurvedPanel, createGrainSphere } from './geometry';
import { createGrainMaterial, setGrainUniforms } from './material';
import { buildFieldArrows, DirectionInspector, type GrainMesh } from './inspect';
import type { GrainMode } from './grain';

export type StageId = 'iso' | 'aniso';

export interface Stage {
  id: StageId;
  root: THREE.Group;
  panel: THREE.Mesh;
  sphere: THREE.Mesh;
  material: THREE.MeshPhysicalMaterial;
  grainCenter: THREE.Vector3;
  fieldArrows: THREE.Group;
  label: string;
}

const STAGE_DX = 2.7;
const LIGHT_DISTANCE = 9;
const LIGHT_INTENSITY = 90; // 物理单位 candela，r155+ 默认衰减

/** 某舞台样板正面中心的世界坐标（灯位镜像的锚点） */
function anchorsOf(stage: Stage): THREE.Vector3 {
  return new THREE.Vector3(stage.root.position.x + stage.panel.position.x, stage.panel.position.y, 0);
}

export class CompareScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly inspector: DirectionInspector;

  private readonly stages: Record<StageId, Stage>;
  private readonly lights: THREE.SpotLight[] = [];
  readonly lightHandle: THREE.Mesh;
  private lightHelper: THREE.SpotLightHelper;
  private raycaster = new THREE.Raycaster();
  private draggingLight = false;
  private objectYaw = 0;
  private mode: GrainMode = 'linear';
  private angle = 0;
  private anisoAngleOffset = 0;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x14171c);

    this.camera = new THREE.PerspectiveCamera(
      40,
      container.clientWidth / container.clientHeight,
      0.1,
      100,
    );
    this.camera.position.set(0, 0.9, 9.6);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0, 0);
    this.controls.enableDamping = true;
    this.controls.minDistance = 3.5;
    this.controls.maxDistance = 16;

    this.addEnvironment();
    this.stages = {
      iso: this.buildStage('iso', -STAGE_DX, '均匀粗糙度（对照）'),
      aniso: this.buildStage('aniso', STAGE_DX, '分方向粗糙度（拉丝）'),
    };
    this.inspector = new DirectionInspector(this.scene);

    // 两盏参数完全一致的聚光灯，分别照两块舞台；手柄只代表一盏，另一盏镜像同步
    for (const id of ['iso', 'aniso'] as StageId[]) {
      const light = new THREE.SpotLight(0xffffff, LIGHT_INTENSITY, 0, Math.PI / 4.2, 0.5, 2);
      light.castShadow = id === 'aniso';
      light.shadow.mapSize.set(1024, 1024);
      this.scene.add(light);
      this.scene.add(light.target);
      this.lights.push(light);
    }

    // 可见、可拖动的灯手柄（挂在 aniso 灯上，iso 灯位置镜像）——须先于 setLightOrbit 创建
    this.lightHandle = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 20, 16),
      new THREE.MeshBasicMaterial({ color: 0xfff2a8 }),
    );
    this.lightHandle.userData.isLightHandle = true;
    this.scene.add(this.lightHandle);
    this.lightHelper = new THREE.SpotLightHelper(this.lights[1], 0xffe08a);
    // r160 的 SpotLightHelper 是 LineSegments 容器，材质挂在子对象上
    this.lightHelper.traverse((obj) => {
      const line = obj as THREE.LineSegments;
      if (line.material) {
        const m = line.material as THREE.LineBasicMaterial;
        m.transparent = true;
        m.opacity = 0.35;
        m.depthWrite = false;
      }
    });
    this.scene.add(this.lightHelper);

    this.setLightOrbit(35 * THREE.MathUtils.DEG2RAD, 18 * THREE.MathUtils.DEG2RAD);

    this.bindPointer(container);
    window.addEventListener('resize', () => this.onResize(container));
  }

  private addEnvironment(): void {
    // 无方向的环境补光：半球光 + 弱环境贴图。
    // 金属没有漫反射，必须靠环境反射才有底色；环境贴图整体均匀，不产生方向性高光。
    const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x2a2d33, 0.45);
    this.scene.add(hemi);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    envScene.background = new THREE.Color(0x3a4048);
    // 上下两块弱色板，提供最低限度的环境反射梯度
    const upper = new THREE.Mesh(
      new THREE.SphereGeometry(20, 32, 16),
      new THREE.MeshBasicMaterial({ color: 0x5a626e, side: THREE.BackSide }),
    );
    envScene.add(upper);
    const envTex = pmrem.fromScene(envScene, 0.04).texture;
    this.scene.environment = envTex;
    pmrem.dispose();

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(18, 10),
      new THREE.MeshStandardMaterial({ color: 0x20242b, roughness: 0.85, metalness: 0 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -1.55;
    ground.receiveShadow = true;
    this.scene.add(ground);
  }

  private buildStage(id: StageId, x: number, label: string): Stage {
    const root = new THREE.Group();
    root.position.x = x;
    this.scene.add(root);

    const material = createGrainMaterial({ color: 0xb9bdc4, metalness: 1 });
    const panelGeo = createCurvedPanel();
    const panel = new THREE.Mesh(panelGeo, material);
    panel.castShadow = true;
    panel.receiveShadow = true;
    panel.position.set(-0.35, 0.2, 0);
    panel.userData.stageId = id;
    root.add(panel);

    const sphere = new THREE.Mesh(createGrainSphere(), material);
    sphere.castShadow = true;
    sphere.receiveShadow = true;
    sphere.position.set(1.05, -0.7, 0.45);
    sphere.userData.stageId = id;
    root.add(sphere);

    // 环形纹圆心：样板正面中心（物体局部空间）；球用其最靠近 +Z 的赤道点
    const grainCenter = new THREE.Vector3(-0.35, 0.2, 0);

    const fieldArrows = buildFieldArrows(panelGeo, new THREE.Vector3(0, 0, 0), 'linear', 0);
    fieldArrows.position.copy(panel.position);
    fieldArrows.visible = false;
    root.add(fieldArrows);

    return { id, root, panel, sphere, material, grainCenter, fieldArrows, label };
  }

  /** 灯在以各自样板中心为锚点的球面上移动：azimuth 方位角、elevation 仰角 */
  setLightOrbit(azimuth: number, elevation: number): void {
    const ce = Math.cos(elevation);
    const offset = new THREE.Vector3(
      LIGHT_DISTANCE * ce * Math.sin(azimuth),
      LIGHT_DISTANCE * Math.sin(elevation),
      LIGHT_DISTANCE * ce * Math.cos(azimuth),
    );
    // 锚点取各舞台样板正面中心，两灯相对各自锚点做严格 x 镜像，保证照明几何完全一致
    const anchors = [
      new THREE.Vector3(-STAGE_DX + this.stages.iso.panel.position.x, this.stages.iso.panel.position.y, 0),
      new THREE.Vector3(STAGE_DX + this.stages.aniso.panel.position.x, this.stages.aniso.panel.position.y, 0),
    ];
    this.lights.forEach((light, i) => {
      const mirror = i === 0 ? -1 : 1; // iso 灯在左舞台，x 镜像
      const anchor = anchors[i];
      const target = anchor.clone();
      light.position.set(
        target.x + mirror * offset.x,
        target.y + offset.y,
        target.z + offset.z,
      );
      light.target.position.copy(target);
      light.target.updateMatrixWorld();
    });
    this.lightHandle.position.copy(this.lights[1].position);
    this.lightHelper.update();
  }

  getLightOrbit(): { azimuth: number; elevation: number } {
    const anchor = anchorsOf(this.stages.aniso);
    const p = this.lights[1].position;
    const d = p.clone().sub(anchor);
    const elevation = Math.asin(THREE.MathUtils.clamp(d.y / LIGHT_DISTANCE, -1, 1));
    const azimuth = Math.atan2(d.x, d.z);
    return { azimuth, elevation };
  }

  setRoughness(stage: StageId, roughAlong: number, roughAcross: number): void {
    setGrainUniforms(this.stages[stage].material, { roughAlong, roughAcross });
  }

  setGrainMode(mode: GrainMode): void {
    this.mode = mode;
    this.applyGrain();
  }

  setGrainAngle(angleDeg: number): void {
    this.angle = THREE.MathUtils.degToRad(angleDeg);
    this.applyGrain();
  }

  /** aniso 舞台相对 iso 舞台的纹路转角差（90° 对照用） */
  setAnisoAngleOffset(deg: number): void {
    this.anisoAngleOffset = THREE.MathUtils.degToRad(deg);
    this.applyGrain();
  }

  private applyGrain(): void {
    const modeNum = this.mode === 'linear' ? 0 : 1;
    setGrainUniforms(this.stages.iso.material, {
      mode: modeNum,
      angle: this.angle,
      center: new THREE.Vector3(0, 0, 0),
    });
    setGrainUniforms(this.stages.aniso.material, {
      mode: modeNum,
      angle: this.angle + this.anisoAngleOffset,
      center: new THREE.Vector3(0, 0, 0),
    });
    this.rebuildFieldArrows();
  }

  private rebuildFieldArrows(): void {
    for (const s of [this.stages.iso, this.stages.aniso]) {
      const visible = s.fieldArrows.visible;
      s.root.remove(s.fieldArrows);
      s.fieldArrows.traverse((o) => {
        const seg = o as THREE.LineSegments;
        if (seg.geometry) seg.geometry.dispose();
      });
      const angle = s.id === 'aniso' ? this.angle + this.anisoAngleOffset : this.angle;
      s.fieldArrows = buildFieldArrows(
        s.panel.geometry as THREE.BufferGeometry,
        new THREE.Vector3(0, 0, 0),
        this.mode,
        angle,
      );
      s.fieldArrows.position.copy(s.panel.position);
      s.fieldArrows.visible = visible;
      s.root.add(s.fieldArrows);
    }
  }

  setFieldVisible(v: boolean): void {
    this.stages.iso.fieldArrows.visible = v;
    this.stages.aniso.fieldArrows.visible = v;
  }

  setObjectYaw(deg: number): void {
    this.objectYaw = THREE.MathUtils.degToRad(deg);
    for (const s of [this.stages.iso, this.stages.aniso]) {
      s.panel.rotation.y = this.objectYaw;
      s.sphere.rotation.y = this.objectYaw;
    }
  }

  getGrainMeshes(): GrainMesh[] {
    return [
      { mesh: this.stages.iso.panel, grainCenter: new THREE.Vector3(), label: '左·弯曲样板' },
      { mesh: this.stages.iso.sphere, grainCenter: new THREE.Vector3(0, 0, 0.62), label: '左·球' },
      { mesh: this.stages.aniso.panel, grainCenter: new THREE.Vector3(), label: '右·弯曲样板' },
      { mesh: this.stages.aniso.sphere, grainCenter: new THREE.Vector3(0, 0, 0.62), label: '右·球' },
    ];
  }

  get currentMode(): GrainMode {
    return this.mode;
  }

  get currentAngle(): number {
    return this.angle;
  }

  /** 正视 / 掠视视角预设（相机不动灯，方便单独观察视角影响） */
  setViewPreset(preset: 'front' | 'grazing'): void {
    if (preset === 'front') {
      this.camera.position.set(0, 0.9, 9.6);
    } else {
      // 低角度掠视：相机贴近样板所在平面，但拉远保证两套样板和球完整入镜
      this.camera.position.set(0, 0.25, 8.4);
    }
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  private bindPointer(container: HTMLElement): void {
    const dom = this.renderer.domElement;
    const down = (e: PointerEvent) => {
      const ndc = this.toNDC(e, container);
      this.raycaster.setFromCamera(ndc, this.camera);
      const hitHandle = this.raycaster.intersectObject(this.lightHandle, false).length > 0;
      if (hitHandle) {
        this.draggingLight = true;
        this.controls.enabled = false;
        dom.setPointerCapture(e.pointerId);
      }
    };
    const move = (e: PointerEvent) => {
      if (!this.draggingLight) return;
      // 在以目标为中心的球面上拖动：把屏幕射线投到灯所在的球面
      const ndc = this.toNDC(e, container);
      this.raycaster.setFromCamera(ndc, this.camera);
      // 灯在以右侧样板锚点为球心、LIGHT_DISTANCE 为半径的球面上
      const center = anchorsOf(this.stages.aniso);
      const ray = this.raycaster.ray;
      const oc = ray.origin.clone().sub(center);
      const b = oc.dot(ray.direction);
      const c = oc.lengthSq() - LIGHT_DISTANCE * LIGHT_DISTANCE;
      const disc = b * b - c;
      if (disc >= 0) {
        const t = -b - Math.sqrt(disc);
        const p = ray.origin.clone().addScaledVector(ray.direction, t).sub(center);
        const elevation = Math.asin(THREE.MathUtils.clamp(p.y / LIGHT_DISTANCE, -1, 1));
        const azimuth = Math.atan2(p.x, p.z);
        this.setLightOrbit(azimuth, elevation);
        this.onLightMoved?.(azimuth, elevation);
      }
    };
    const up = (e: PointerEvent) => {
      if (this.draggingLight) {
        this.draggingLight = false;
        this.controls.enabled = true;
        try {
          dom.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      }
    };
    dom.addEventListener('pointerdown', down);
    dom.addEventListener('pointermove', move);
    dom.addEventListener('pointerup', up);
    dom.addEventListener('pointercancel', up);
  }

  /** 点击表面（非拖灯、非轨道旋转的短按）检查纹路方向 */
  handleSurfaceClick(ndcX: number, ndcY: number): string | null {
    const angleOf = (mesh: THREE.Mesh): number =>
      (mesh.userData.stageId as StageId) === 'aniso'
        ? this.angle + this.anisoAngleOffset
        : this.angle;
    return this.inspector.pick(ndcX, ndcY, this.camera, this.getGrainMeshes(), this.mode, angleOf);
  }

  private toNDC(e: PointerEvent, container: HTMLElement): THREE.Vector2 {
    const rect = container.getBoundingClientRect();
    return new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  onLightMoved: ((azimuth: number, elevation: number) => void) | null = null;

  private onResize(container: HTMLElement): void {
    this.camera.aspect = container.clientWidth / container.clientHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(container.clientWidth, container.clientHeight);
  }

  render(): void {
    this.controls.update();
    this.inspector.update();
    this.lightHelper.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
