import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import GUI from 'lil-gui';
import { boxesOverlap, boxTargetOverlap, targetsOverlap } from '../sim/geometry';
import { defaultMaterial, MATERIAL_LABELS } from '../sim/materials';
import {
  allPresets,
  cloneDefs,
  defaultScene,
  makeBox,
  makeTarget,
  type Preset,
} from '../sim/presets';
import { directionFromYawPitch, simulateShot } from '../sim/simulator';
import { isBoxDef, type BoxDef, type MaterialKind, type ShotResult, type TargetDef } from '../sim/types';
import { BoxView, TargetView } from './objectView';
import { SidePanel } from './panel';
import { AimLine, TrajectoryView } from './trajectoryView';
import '../styles.css';

interface ShotGuiState {
  originX: number;
  originY: number;
  originZ: number;
  yawDeg: number;
  pitchDeg: number;
  initialEnergy: number;
  maxRange: number;
  minEnergy: number;
  maxInteractions: number;
  showAim: boolean;
  showContacts: boolean;
  showLabels: boolean;
  showGrid: boolean;
}

interface BoxGuiState {
  posX: number;
  posY: number;
  posZ: number;
  rotXdeg: number;
  rotYdeg: number;
  rotZdeg: number;
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  kind: MaterialKind;
  resistance: number;
  reflectLossRatio: number;
  maxReflectAngleDeg: number;
}

interface TargetGuiState {
  posX: number;
  posY: number;
  posZ: number;
  rotXdeg: number;
  rotYdeg: number;
  rotZdeg: number;
  sizeX: number;
  sizeY: number;
}

export class BallisticApp {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly labelRenderer: CSS2DRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();

  private readonly objectGroup = new THREE.Group();
  private readonly aimLine = new AimLine();
  private readonly trajectoryView = new TrajectoryView();
  private readonly sidePanel = new SidePanel();

  private boxes: BoxDef[] = [];
  private targets: TargetDef[] = [];
  private boxViews = new Map<string, BoxView>();
  private targetViews = new Map<string, TargetView>();

  private result: ShotResult | null = null;
  private stale = false;
  private selectedObjectId: string | null = null;

  private gui!: GUI;
  private shotFolder!: GUI;
  private objectListFolder!: GUI;
  private editorFolder: GUI | null = null;

  private readonly shotState: ShotGuiState = {
    originX: -8,
    originY: 1,
    originZ: 2,
    yawDeg: -5.7,
    pitchDeg: -2.9,
    initialEnergy: 100,
    maxRange: 60,
    minEnergy: 1,
    maxInteractions: 8,
    showAim: true,
    showContacts: true,
    showLabels: true,
    showGrid: true,
  };

  private grid: THREE.GridHelper;
  private axes: THREE.AxesHelper;
  private bannerEl: HTMLElement;
  private bannerTimer: number | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.setSize(window.innerWidth, window.innerHeight);
    this.labelRenderer.domElement.style.position = 'absolute';
    this.labelRenderer.domElement.style.top = '0';
    this.labelRenderer.domElement.style.pointerEvents = 'none';
    canvas.parentElement!.appendChild(this.labelRenderer.domElement);

    this.camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 500);
    this.camera.position.set(-14, 9, 16);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    this.scene.background = new THREE.Color(0x0e1117);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.1);
    dirLight.position.set(8, 14, 10);
    this.scene.add(dirLight);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.35);
    fill.position.set(-10, 6, -8);
    this.scene.add(fill);

    this.grid = new THREE.GridHelper(40, 40, 0x39414f, 0x222833);
    this.axes = new THREE.AxesHelper(3);
    this.scene.add(this.grid, this.axes, this.objectGroup, this.aimLine.group, this.trajectoryView.group);

    this.bannerEl = document.getElementById('banner')!;
    this.sidePanel.setSelectHandler((idx) => this.selectSegment(idx));

    const initial = defaultScene();
    this.boxes = initial.boxes;
    this.targets = initial.targets;
    this.shotState.originX = initial.shot.origin.x;
    this.shotState.originY = initial.shot.origin.y;
    this.shotState.originZ = initial.shot.origin.z;
    this.rebuildObjectViews();
    this.buildGui();
    this.syncShotStateToAim();

    window.addEventListener('resize', this.onResize);
    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.addEventListener('pointerup', this.onPointerUp);
    this.pointerDownPos = null;

    this.animate();
  }

  private pointerDownPos: { x: number; y: number } | null;

  // ---------------------------------------------------------------- GUI

  private buildGui(): void {
    this.gui = new GUI({ title: '射线弹道控制台' });

    this.shotFolder = this.gui.addFolder('发射参数');
    const s = this.shotState;
    this.shotFolder.add(s, 'originX', -20, 20, 0.1).name('发射点 X').onChange(() => this.onShotEdited());
    this.shotFolder.add(s, 'originY', -10, 15, 0.1).name('发射点 Y').onChange(() => this.onShotEdited());
    this.shotFolder.add(s, 'originZ', -20, 20, 0.1).name('发射点 Z').onChange(() => this.onShotEdited());
    this.shotFolder.add(s, 'yawDeg', -180, 180, 0.5).name('方向 偏航角°').onChange(() => this.onShotEdited());
    this.shotFolder.add(s, 'pitchDeg', -89, 89, 0.5).name('方向 俯仰角°').onChange(() => this.onShotEdited());
    this.shotFolder.add(s, 'initialEnergy', 1, 500, 1).name('初始能量').onChange(() => this.onShotEdited());
    this.shotFolder.add(s, 'maxRange', 1, 200, 1).name('最大射程').onChange(() => this.onShotEdited());
    this.shotFolder.add(s, 'minEnergy', 0, 50, 0.5).name('最低能量').onChange(() => this.onShotEdited());
    this.shotFolder.add(s, 'maxInteractions', 1, 8, 1).name('交互上限(≤8)').onChange(() => this.onShotEdited());
    this.shotFolder.add(s, 'showAim').name('显示瞄准线').onChange((v: boolean) => (this.aimLine.setVisible(v)));
    this.shotFolder.add(s, 'showContacts').name('显示接触标记').onChange((v: boolean) => (this.trajectoryView.group.visible = v));
    this.shotFolder.add(s, 'showLabels').name('显示文字标签').onChange((v: boolean) => this.setLabelsVisible(v));
    this.shotFolder.add(s, 'showGrid').name('显示网格/坐标轴').onChange((v: boolean) => {
      this.grid.visible = v;
      this.axes.visible = v;
    });
    this.shotFolder.add({ fire: () => this.fire() }, 'fire').name('▶ 发射 (重新计算)');
    this.shotFolder.open();

    const presetFolder = this.gui.addFolder('固定现场');
    for (const preset of allPresets()) {
      presetFolder.add(
        { load: () => this.loadPreset(preset) },
        'load',
      ).name(preset.label);
    }
    presetFolder.add({ reset: () => this.loadDefaultScene() }, 'reset').name('默认编辑场景');

    this.objectListFolder = this.gui.addFolder('场景物体');
    this.objectListFolder.add({ addBox: () => this.addBox() }, 'addBox').name('+ 新建长方体');
    this.objectListFolder.add({ addTarget: () => this.addTarget() }, 'addTarget').name('+ 新建靶面');
    this.refreshObjectList();
  }

  private refreshObjectList(): void {
    // 清掉旧的物体入口控制器
    this.objectListFolder.controllers.slice(2).forEach((c) => c.destroy());
    for (const box of this.boxes) {
      this.objectListFolder
        .add({ select: () => this.selectObject(box.id) }, 'select')
        .name(`▣ ${box.name} [${MATERIAL_LABELS[box.material.kind]}]`);
    }
    for (const target of this.targets) {
      this.objectListFolder
        .add({ select: () => this.selectObject(target.id) }, 'select')
        .name(`◎ ${target.name}`);
    }
  }

  private closeEditor(): void {
    if (this.editorFolder) {
      this.editorFolder.destroy();
      this.editorFolder = null;
    }
  }

  private selectObject(id: string): void {
    this.selectedObjectId = id;
    this.applyHighlights();
    this.closeEditor();

    const box = this.boxes.find((b) => b.id === id);
    if (box) {
      this.editorFolder = this.gui.addFolder(`编辑: ${box.name}`);
      const st: BoxGuiState = {
        posX: box.position.x,
        posY: box.position.y,
        posZ: box.position.z,
        rotXdeg: THREE.MathUtils.radToDeg(box.rotation.x),
        rotYdeg: THREE.MathUtils.radToDeg(box.rotation.y),
        rotZdeg: THREE.MathUtils.radToDeg(box.rotation.z),
        sizeX: box.size.x,
        sizeY: box.size.y,
        sizeZ: box.size.z,
        kind: box.material.kind,
        resistance: box.material.resistance,
        reflectLossRatio: box.material.reflectLossRatio,
        maxReflectAngleDeg: box.material.maxReflectAngleDeg,
      };
      const snapshot = cloneDefs([box])[0] as BoxDef;
      const commit = () => this.commitBoxEdit(box, st, snapshot);

      this.editorFolder.add(st, 'posX', -20, 20, 0.1).name('位置 X').onChange(commit);
      this.editorFolder.add(st, 'posY', -10, 15, 0.1).name('位置 Y').onChange(commit);
      this.editorFolder.add(st, 'posZ', -20, 20, 0.1).name('位置 Z').onChange(commit);
      this.editorFolder.add(st, 'rotXdeg', -180, 180, 1).name('旋转 X°').onChange(commit);
      this.editorFolder.add(st, 'rotYdeg', -180, 180, 1).name('旋转 Y°').onChange(commit);
      this.editorFolder.add(st, 'rotZdeg', -180, 180, 1).name('旋转 Z°').onChange(commit);
      this.editorFolder.add(st, 'sizeX', 0.2, 12, 0.1).name('尺寸 X').onChange(commit);
      this.editorFolder.add(st, 'sizeY', 0.2, 12, 0.1).name('尺寸 Y').onChange(commit);
      this.editorFolder.add(st, 'sizeZ', 0.2, 12, 0.1).name('尺寸 Z').onChange(commit);
      this.editorFolder
        .add(st, 'kind', ['penetrable', 'reflective', 'blocking'] as MaterialKind[])
        .name('材料类型')
        .onChange((kind: MaterialKind) => {
          const fresh = defaultMaterial(kind);
          st.resistance = fresh.resistance;
          st.reflectLossRatio = fresh.reflectLossRatio;
          st.maxReflectAngleDeg = fresh.maxReflectAngleDeg;
          box.material = { ...fresh };
          if (!this.hasOverlap(box.id)) {
            this.boxViews.get(box.id)?.syncMaterial();
            this.refreshObjectList();
            this.markStale();
          }
          this.gui.controllersRecursive().forEach((c) => c.updateDisplay());
        });
      this.editorFolder.add(st, 'resistance', 0, 50, 0.5).name('阻力(穿透)').onChange(commit);
      this.editorFolder.add(st, 'reflectLossRatio', 0, 0.9, 0.05).name('反弹耗能比例').onChange(commit);
      this.editorFolder.add(st, 'maxReflectAngleDeg', 1, 90, 1).name('最大反射角°').onChange(commit);
      this.editorFolder.add({ delete: () => this.deleteObject(box.id) }, 'delete').name('✖ 删除该长方体');
      this.editorFolder.open();
      return;
    }

    const target = this.targets.find((t) => t.id === id);
    if (target) {
      this.editorFolder = this.gui.addFolder(`编辑: ${target.name}`);
      const st: TargetGuiState = {
        posX: target.position.x,
        posY: target.position.y,
        posZ: target.position.z,
        rotXdeg: THREE.MathUtils.radToDeg(target.rotation.x),
        rotYdeg: THREE.MathUtils.radToDeg(target.rotation.y),
        rotZdeg: THREE.MathUtils.radToDeg(target.rotation.z),
        sizeX: target.size.x,
        sizeY: target.size.y,
      };
      const snapshot = cloneDefs([target])[0] as TargetDef;
      const commit = () => this.commitTargetEdit(target, st, snapshot);
      this.editorFolder.add(st, 'posX', -20, 20, 0.1).name('位置 X').onChange(commit);
      this.editorFolder.add(st, 'posY', -10, 15, 0.1).name('位置 Y').onChange(commit);
      this.editorFolder.add(st, 'posZ', -20, 20, 0.1).name('位置 Z').onChange(commit);
      this.editorFolder.add(st, 'rotXdeg', -180, 180, 1).name('旋转 X°').onChange(commit);
      this.editorFolder.add(st, 'rotYdeg', -180, 180, 1).name('旋转 Y°').onChange(commit);
      this.editorFolder.add(st, 'rotZdeg', -180, 180, 1).name('旋转 Z°').onChange(commit);
      this.editorFolder.add(st, 'sizeX', 0.2, 12, 0.1).name('尺寸 X').onChange(commit);
      this.editorFolder.add(st, 'sizeY', 0.2, 12, 0.1).name('尺寸 Y').onChange(commit);
      this.editorFolder.add({ delete: () => this.deleteObject(target.id) }, 'delete').name('✖ 删除该靶面');
      this.editorFolder.open();
    }
  }

  // ---------------------------------------------------------------- 编辑提交与校验

  private commitBoxEdit(box: BoxDef, st: BoxGuiState, snapshot: BoxDef): void {
    box.position.set(st.posX, st.posY, st.posZ);
    box.rotation.set(
      THREE.MathUtils.degToRad(st.rotXdeg),
      THREE.MathUtils.degToRad(st.rotYdeg),
      THREE.MathUtils.degToRad(st.rotZdeg),
    );
    box.size.set(st.sizeX, st.sizeY, st.sizeZ);
    box.material.resistance = st.resistance;
    box.material.reflectLossRatio = st.reflectLossRatio;
    box.material.maxReflectAngleDeg = st.maxReflectAngleDeg;

    if (this.hasOverlap(box.id)) {
      this.restoreBox(box, snapshot);
      this.gui.controllersRecursive().forEach((c) => c.updateDisplay());
      this.flashBanner('该位置/尺寸会与其他物体相交, 已回退此次修改', true);
      return;
    }
    const view = this.boxViews.get(box.id);
    view?.syncTransform();
    view?.syncMaterial();
    this.refreshObjectList();
    this.markStale();
  }

  private commitTargetEdit(target: TargetDef, st: TargetGuiState, snapshot: TargetDef): void {
    target.position.set(st.posX, st.posY, st.posZ);
    target.rotation.set(
      THREE.MathUtils.degToRad(st.rotXdeg),
      THREE.MathUtils.degToRad(st.rotYdeg),
      THREE.MathUtils.degToRad(st.rotZdeg),
    );
    target.size.set(st.sizeX, st.sizeY);

    if (this.hasOverlap(target.id)) {
      this.restoreTarget(target, snapshot);
      this.gui.controllersRecursive().forEach((c) => c.updateDisplay());
      this.flashBanner('该位置/尺寸会与其他物体相交, 已回退此次修改', true);
      return;
    }
    this.targetViews.get(target.id)?.syncTransform();
    this.markStale();
  }

  private restoreBox(box: BoxDef, snapshot: BoxDef): void {
    box.position.copy(snapshot.position);
    box.rotation.copy(snapshot.rotation);
    box.size.copy(snapshot.size);
    box.material = { ...snapshot.material };
    this.boxViews.get(box.id)?.syncTransform();
  }

  private restoreTarget(target: TargetDef, snapshot: TargetDef): void {
    target.position.copy(snapshot.position);
    target.rotation.copy(snapshot.rotation);
    target.size.copy(snapshot.size);
    this.targetViews.get(target.id)?.syncTransform();
  }

  private hasOverlap(id: string): boolean {
    for (let i = 0; i < this.boxes.length; i++) {
      for (let j = i + 1; j < this.boxes.length; j++) {
        if (boxesOverlap(this.boxes[i], this.boxes[j])) return true;
      }
    }
    for (const b of this.boxes) {
      for (const t of this.targets) {
        if (boxTargetOverlap(b, t)) return true;
      }
    }
    for (let i = 0; i < this.targets.length; i++) {
      for (let j = i + 1; j < this.targets.length; j++) {
        if (targetsOverlap(this.targets[i], this.targets[j])) return true;
      }
    }
    // id 仅用于语义; 全量 SAT 已覆盖
    void id;
    return false;
  }

  private addBox(): void {
    const base = makeBox({
      name: `可穿透盒 ${this.boxes.length + 1}`,
      position: new THREE.Vector3(
        Math.round((Math.random() - 0.5) * 6),
        Math.round((Math.random() - 0.5) * 3),
        Math.round((Math.random() - 0.5) * 6),
      ),
      size: new THREE.Vector3(1.5, 1.5, 1.5),
      material: defaultMaterial('penetrable'),
    });
    this.boxes.push(base);
    if (this.hasOverlap(base.id)) {
      this.boxes.pop();
      this.flashBanner('附近没有不相交的空位, 请先移动其他物体', true);
      return;
    }
    const view = new BoxView(base);
    this.boxViews.set(base.id, view);
    this.objectGroup.add(view.group);
    this.refreshObjectList();
    this.markStale();
    this.selectObject(base.id);
  }

  private addTarget(): void {
    const target = makeTarget({
      name: `靶面 ${this.targets.length + 1}`,
      position: new THREE.Vector3(
        Math.round((Math.random() - 0.5) * 6),
        Math.round((Math.random() - 0.5) * 3),
        Math.round(8 + Math.random() * 4),
      ),
      size: new THREE.Vector2(2.5, 2.5),
    });
    this.targets.push(target);
    if (this.hasOverlap(target.id)) {
      this.targets.pop();
      this.flashBanner('附近没有不相交的空位, 请先移动其他物体', true);
      return;
    }
    const view = new TargetView(target);
    this.targetViews.set(target.id, view);
    this.objectGroup.add(view.group);
    this.refreshObjectList();
    this.markStale();
    this.selectObject(target.id);
  }

  private deleteObject(id: string): void {
    const boxView = this.boxViews.get(id);
    if (boxView) {
      this.objectGroup.remove(boxView.group);
      boxView.dispose();
      this.boxViews.delete(id);
      this.boxes = this.boxes.filter((b) => b.id !== id);
    }
    const targetView = this.targetViews.get(id);
    if (targetView) {
      this.objectGroup.remove(targetView.group);
      targetView.dispose();
      this.targetViews.delete(id);
      this.targets = this.targets.filter((t) => t.id !== id);
    }
    this.selectedObjectId = null;
    this.closeEditor();
    this.refreshObjectList();
    this.applyHighlights();
    this.markStale();
  }

  // ---------------------------------------------------------------- 发射与结果

  private buildShotParams() {
    const s = this.shotState;
    return {
      origin: new THREE.Vector3(s.originX, s.originY, s.originZ),
      direction: directionFromYawPitch(s.yawDeg, s.pitchDeg),
      initialEnergy: s.initialEnergy,
      maxRange: s.maxRange,
      maxInteractions: Math.min(8, Math.max(1, Math.round(s.maxInteractions))),
      minEnergy: s.minEnergy,
    };
  }

  private syncShotStateToAim(): void {
    const p = this.buildShotParams();
    this.aimLine.update(p.origin, p.direction, p.maxRange);
  }

  private onShotEdited(): void {
    this.syncShotStateToAim();
    this.markStale();
  }

  private fire(): void {
    const params = this.buildShotParams();
    try {
      this.result = simulateShot(this.boxes, this.targets, params);
    } catch (err) {
      this.flashBanner(`模拟失败: ${(err as Error).message}`, true);
      return;
    }
    this.stale = false;
    this.hideBanner();
    this.trajectoryView.build(this.result);
    this.trajectoryView.group.visible = this.shotState.showContacts;
    this.sidePanel.showResult(this.result);
  }

  private markStale(): void {
    if (!this.result) return;
    this.stale = true;
    this.bannerEl.textContent = '场景已修改, 上次射击结果已过期 — 点击「发射」重新计算';
    this.bannerEl.className = 'banner';
  }

  private flashBanner(text: string, isError: boolean): void {
    this.bannerEl.textContent = text;
    this.bannerEl.className = `banner${isError ? ' error' : ''}`;
    if (this.bannerTimer !== null) window.clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => {
      if (this.stale && this.result) {
        this.bannerEl.textContent = '场景已修改, 上次射击结果已过期 — 点击「发射」重新计算';
        this.bannerEl.className = 'banner';
      } else {
        this.hideBanner();
      }
    }, 3000);
  }

  private hideBanner(): void {
    this.bannerEl.className = 'banner hidden';
  }

  private selectSegment(index: number | null): void {
    this.trajectoryView.setSelected(index);
    this.sidePanel.select(index);
  }

  // ---------------------------------------------------------------- 预设

  private loadPreset(preset: Preset): void {
    this.applyScene(preset.boxes, preset.targets);
    const p = preset.shot;
    this.applyShotToGui(p);
    this.flashBanner(`已载入「${preset.label}」: ${preset.description}`, false);
    this.fire();
  }

  private loadDefaultScene(): void {
    const d = defaultScene();
    this.applyScene(d.boxes, d.targets);
    this.applyShotToGui(d.shot);
    this.hideBanner();
    this.fire();
  }

  private applyScene(boxes: BoxDef[], targets: TargetDef[]): void {
    for (const view of this.boxViews.values()) view.dispose();
    for (const view of this.targetViews.values()) view.dispose();
    this.boxViews.clear();
    this.targetViews.clear();
    this.objectGroup.clear();
    this.boxes = cloneDefs(boxes).filter(isBoxDef) as BoxDef[];
    this.targets = cloneDefs(targets).filter((d) => !isBoxDef(d)) as TargetDef[];
    this.selectedObjectId = null;
    this.closeEditor();
    this.rebuildObjectViews();
    this.refreshObjectList();
    this.result = null;
    this.stale = false;
    this.sidePanel.clear();
    this.trajectoryView.clear();
  }

  private applyShotToGui(p: {
    origin: THREE.Vector3;
    direction: THREE.Vector3;
    maxRange: number;
    initialEnergy: number;
    minEnergy: number;
    maxInteractions: number;
  }): void {
    const s = this.shotState;
    s.originX = p.origin.x;
    s.originY = p.origin.y;
    s.originZ = p.origin.z;
    const yaw = Math.atan2(p.direction.x, p.direction.z);
    const pitch = Math.asin(THREE.MathUtils.clamp(p.direction.y, -1, 1));
    s.yawDeg = THREE.MathUtils.radToDeg(yaw);
    s.pitchDeg = THREE.MathUtils.radToDeg(pitch);
    s.initialEnergy = p.initialEnergy;
    s.maxRange = p.maxRange;
    s.minEnergy = p.minEnergy;
    s.maxInteractions = p.maxInteractions;
    this.gui.controllersRecursive().forEach((c) => c.updateDisplay());
    this.syncShotStateToAim();
  }

  // ---------------------------------------------------------------- 视图与拾取

  private rebuildObjectViews(): void {
    for (const box of this.boxes) {
      const view = new BoxView(box);
      this.boxViews.set(box.id, view);
      this.objectGroup.add(view.group);
    }
    for (const target of this.targets) {
      const view = new TargetView(target);
      this.targetViews.set(target.id, view);
      this.objectGroup.add(view.group);
    }
    this.setLabelsVisible(this.shotState.showLabels);
  }

  private applyHighlights(): void {
    for (const [id, view] of this.boxViews) view.setHighlight(id === this.selectedObjectId);
    for (const [id, view] of this.targetViews) view.setHighlight(id === this.selectedObjectId);
  }

  private setLabelsVisible(v: boolean): void {
    this.objectGroup.traverse((obj) => {
      if (obj instanceof CSS2DObject) obj.visible = v;
    });
    this.trajectoryView.group.traverse((obj) => {
      if (obj instanceof CSS2DObject) obj.visible = v;
    });
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.pointerDownPos = { x: e.clientX, y: e.clientY };
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.pointerDownPos) return;
    const dx = e.clientX - this.pointerDownPos.x;
    const dy = e.clientY - this.pointerDownPos.y;
    this.pointerDownPos = null;
    if (dx * dx + dy * dy > 25) return; // 拖拽旋转, 不算点击

    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);

    // 优先拾取弹道线段
    const segIdx = this.trajectoryView.pickSegment(this.pointer, this.camera);
    if (segIdx !== null && this.shotState.showContacts) {
      this.selectSegment(segIdx);
      return;
    }

    const pickables: THREE.Object3D[] = [];
    for (const v of this.boxViews.values()) pickables.push(v.mesh);
    for (const v of this.targetViews.values()) pickables.push(v.mesh);
    const hits = this.raycaster.intersectObjects(pickables, false);
    if (hits.length > 0) {
      const id = hits[0].object.userData.objectId as string;
      this.selectObject(id);
    } else {
      this.selectedObjectId = null;
      this.applyHighlights();
    }
  };

  private onResize = (): void => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.labelRenderer.setSize(window.innerWidth, window.innerHeight);
  };

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
  };
}
