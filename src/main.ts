import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

import { createAssembly } from './scene/assembly';
import { AnchorSystem } from './scene/anchors';
import { CameraDirector, VIEW_PRESETS, type ViewPresetName } from './scene/cameraDirector';
import {
  layoutLabels,
  type AnchorLayoutInput,
  type LabelPlacement,
  type Rect,
} from './core/layout';
import { ViewChangeTracker } from './core/stability';
import type { AnchorState } from './core/visibility';
import { LabelOverlay } from './ui/overlay';
import { Sidebar } from './ui/sidebar';
import './styles.css';

const SETTINGS_KEY = 'assembly-labeler:settings:v1';

interface PersistedSettings {
  priorities: Record<string, number>;
  locks: Record<string, boolean>;
  showOccluded: boolean;
}

interface Selection {
  partId: string | null;
  anchorId: string | null;
}

function loadSettings(): PersistedSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) throw new Error('empty');
    const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
    return {
      priorities: parsed.priorities ?? {},
      locks: parsed.locks ?? {},
      showOccluded: parsed.showOccluded ?? true,
    };
  } catch {
    return { priorities: {}, locks: {}, showOccluded: true };
  }
}

class App {
  private readonly viewport: HTMLElement;
  private readonly labelsHost: HTMLElement;
  private readonly leaderSvg: SVGSVGElement;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly director: CameraDirector;
  private readonly assembly = createAssembly();
  private readonly anchorSystem: AnchorSystem;
  private readonly overlay: LabelOverlay;
  private readonly sidebar: Sidebar;

  private readonly tracker = new ViewChangeTracker();
  private readonly priorities = new Map<string, number>();
  private readonly locks = new Map<string, boolean>();
  private stickySlots = new Map<string, number>();
  private showOccluded = true;

  private selection: Selection = { partId: null, anchorId: null };
  private autoSwing = false;
  private swingTime = 0;
  private lastFrameTime = 0;
  private wasFlying = false;
  private pointerDown: { x: number; y: number; time: number } | null = null;
  private currentView: ViewPresetName = 'front';

  private readonly pulse: THREE.Mesh;
  private pulseTime = Number.POSITIVE_INFINITY;
  private readonly pulseOrigin = new THREE.Vector3();

  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNdc = new THREE.Vector2();

  private lastViewport = { width: 0, height: 0 };
  private resizeObserver: ResizeObserver | null = null;
  private rafHandle = 0;

  private placements: ReadonlyMap<string, LabelPlacement> = new Map();
  private stowed = new Set<string>();

  constructor() {
    this.viewport = must('viewport');
    this.labelsHost = must('labels');
    this.leaderSvg = document.getElementById('leaders') as unknown as SVGSVGElement;
    if (!this.leaderSvg) throw new Error('缺少 #leaders');

    const settings = loadSettings();
    this.showOccluded = settings.showOccluded;

    // ------------------------------------------------------------ 渲染器
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.className = 'webgl';
    this.viewport.prepend(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 120);
    this.camera.position.set(...VIEW_PRESETS.front.position);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(...VIEW_PRESETS.front.target);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.rotateSpeed = 0.72;
    this.controls.zoomSpeed = 0.85;
    this.controls.panSpeed = 0.7;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 38;
    this.controls.maxPolarAngle = Math.PI * 0.94;
    this.controls.minPolarAngle = Math.PI * 0.04;
    this.controls.update();

    this.director = new CameraDirector(this.camera, { controls: this.controls, duration: 0.9 });

    // ------------------------------------------------------------ 场景
    this.setupScene();
    this.anchorSystem = new AnchorSystem(this.assembly);

    this.overlay = new LabelOverlay(this.viewport, this.labelsHost, this.leaderSvg, {
      onSelectPart: (partId, anchorId) => this.selectPart(partId, anchorId),
      onToggleLock: (anchorId, locked) => this.setLock(anchorId, locked),
    });

    this.sidebar = new Sidebar({
      onTogglePart: (partId, visible) => this.setPartVisible(partId, visible),
      onSetPriority: (anchorId, priority) => this.setPriority(anchorId, priority),
      onToggleLock: (anchorId, locked) => this.setLock(anchorId, locked),
      onFocusAnchor: (anchorId) => this.focusAnchor(anchorId),
      onViewChange: (view) => this.flyToView(view),
      onArmAngle: (degrees) => {
        this.setAutoSwing(false);
        this.setArmDegrees(degrees);
      },
      onAutoSwing: (enabled) => this.setAutoSwing(enabled),
      onNarrowMode: (enabled) => this.setNarrow(enabled),
      onShowOccluded: (enabled) => this.setShowOccluded(enabled),
    });

    // 先建立标签 DOM，再套用持久化设置（否则优先级角标无处可写）。
    this.overlay.createLabels(this.anchorSystem.runtimes, (partId) => this.partName(partId));
    this.overlay.setSelected(null, null);

    for (const anchor of this.assembly.anchors) {
      this.priorities.set(anchor.id, settings.priorities[anchor.id] ?? anchor.priority);
      this.locks.set(anchor.id, settings.locks[anchor.id] ?? anchor.locked);
      this.overlay.setPriority(anchor.id, this.priorityOf(anchor.id));
      this.overlay.setLocked(anchor.id, this.isLocked(anchor.id));
    }
    this.sidebar.setShowOccluded(this.showOccluded);

    // 点击标签后零件上的脉冲标记
    this.pulse = new THREE.Mesh(
      new THREE.SphereGeometry(0.11, 16, 12),
      new THREE.MeshBasicMaterial({
        color: 0xffc36b,
        transparent: true,
        opacity: 0.95,
        depthTest: false,
      }),
    );
    this.pulse.renderOrder = 20;
    this.pulse.visible = false;
    this.scene.add(this.pulse);

    this.refreshSidebar();

    this.setupInteraction();
    this.observeResize();

    this.frame(performance.now());
    this.rafHandle = requestAnimationFrame((t) => this.frame(t));

    document.fonts?.ready.then(() => {
      this.remeasure();
    });
  }

  // ------------------------------------------------------------------ 场景搭建
  private setupScene(): void {
    this.scene.background = new THREE.Color(0x0d141d);
    this.scene.fog = new THREE.Fog(0x0d141d, 36, 72);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.42;

    this.scene.add(new THREE.HemisphereLight(0xbfd6ee, 0x121a24, 0.55));

    const key = new THREE.DirectionalLight(0xfff0d8, 1.55);
    key.position.set(9, 14, 10);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -14;
    key.shadow.camera.right = 14;
    key.shadow.camera.top = 14;
    key.shadow.camera.bottom = -14;
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 48;
    key.shadow.bias = -0.0006;
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0x8fb8ff, 0.45);
    fill.position.set(-12, 8, -10);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xffb066, 0.35);
    rim.position.set(2, 5, -14);
    this.scene.add(rim);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(30, 64),
      new THREE.MeshStandardMaterial({ color: 0x131c27, roughness: 0.95, metalness: 0.05 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.02;
    floor.receiveShadow = true;
    this.scene.add(floor);

    const grid = new THREE.GridHelper(40, 40, 0x2a3b4e, 0x1b2836);
    grid.position.y = 0.001;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.5;
    this.scene.add(grid);

    this.scene.add(this.assembly.root);
    this.assembly.setArmAngle(0);
  }

  // ------------------------------------------------------------------ 状态读取
  private priorityOf(anchorId: string): number {
    const def = this.assembly.anchors.find((a) => a.id === anchorId);
    return this.priorities.get(anchorId) ?? def?.priority ?? 3;
  }

  private isLocked(anchorId: string): boolean {
    const def = this.assembly.anchors.find((a) => a.id === anchorId);
    return this.locks.get(anchorId) ?? def?.locked ?? false;
  }

  private partName(partId: string): string {
    return this.assembly.parts.get(partId)?.name ?? partId;
  }

  private anchorState(anchorId: string): AnchorState {
    const runtime = this.anchorSystem.find(anchorId);
    if (!runtime || !runtime.partVisible) return 'behind';
    return runtime.state;
  }

  private anchorCode(anchorId: string): string {
    return this.assembly.anchors.find((a) => a.id === anchorId)?.code ?? anchorId;
  }

  private persist(): void {
    const priorities: Record<string, number> = {};
    const locks: Record<string, boolean> = {};
    for (const anchor of this.assembly.anchors) {
      priorities[anchor.id] = this.priorityOf(anchor.id);
      locks[anchor.id] = this.isLocked(anchor.id);
    }
    try {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({ priorities, locks, showOccluded: this.showOccluded }),
      );
    } catch {
      // 隐私模式等场景下忽略
    }
  }

  // ------------------------------------------------------------------ 交互
  private setupInteraction(): void {
    this.controls.addEventListener('start', () => {
      this.director.cancel();
      this.wasFlying = false;
      this.setFlyingClass(false);
    });

    const dom = this.renderer.domElement;
    dom.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      this.pointerDown = { x: event.clientX, y: event.clientY, time: performance.now() };
    });
    dom.addEventListener('pointerup', (event) => {
      if (event.button !== 0) return;
      const down = this.pointerDown;
      this.pointerDown = null;
      if (!down) return;
      const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y);
      if (moved > 5 || performance.now() - down.time > 650) return;
      this.pickPart(event);
    });

    document.getElementById('sidebar-toggle')?.addEventListener('click', () => {
      document.getElementById('app')?.classList.toggle('sidebar-collapsed');
    });

    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.clearSelection();
    });
  }

  pickPart(event: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointerNdc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const meshes: THREE.Mesh[] = [];
    for (const part of this.assembly.parts.values()) {
      if (part.visible) meshes.push(...part.meshes);
    }
    const hits = this.raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) {
      this.clearSelection();
      return;
    }
    const partId = hits[0].object.userData.partId as string | undefined;
    if (partId) this.selectPart(partId, null);
  }

  selectPart(partId: string, anchorId: string | null): void {
    this.selection = { partId, anchorId };
    this.assembly.setSelectedPart(partId);
    this.overlay.setSelected(partId, anchorId);

    if (anchorId) {
      const runtime = this.anchorSystem.find(anchorId);
      if (runtime) {
        this.pulseOrigin.copy(runtime.world);
        this.pulse.position.copy(runtime.world);
        this.pulse.visible = true;
        this.pulseTime = 0;
      }
    }

    const row = document.querySelector<HTMLElement>(
      `.part-row[data-part-id="${CSS.escape(partId)}"]`,
    );
    document.querySelectorAll('.part-row.is-selected-part').forEach((el) => {
      el.classList.remove('is-selected-part');
    });
    row?.classList.add('is-selected-part');
    row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    this.syncSelectionLabel();
  }

  focusAnchor(anchorId: string): void {
    const runtime = this.anchorSystem.find(anchorId);
    if (!runtime) return;
    if (!runtime.part.visible) {
      this.setPartVisible(runtime.def.partId, true);
      const check = document.querySelector<HTMLInputElement>(
        `.part-row[data-part-id="${CSS.escape(runtime.def.partId)}"] input[type="checkbox"]`,
      );
      if (check) check.checked = true;
    }
    this.selectPart(runtime.def.partId, anchorId);
  }

  private clearSelection(): void {
    this.selection = { partId: null, anchorId: null };
    this.assembly.setSelectedPart(null);
    this.overlay.setSelected(null, null);
    this.pulse.visible = false;
    document.querySelectorAll('.part-row.is-selected-part').forEach((el) => {
      el.classList.remove('is-selected-part');
    });
    this.syncSelectionLabel();
  }

  private syncSelectionLabel(): void {
    if (!this.selection.partId) {
      this.sidebar.setSelectedPart('未选中零件');
      return;
    }
    const label = this.partName(this.selection.partId);
    if (this.selection.anchorId) {
      this.sidebar.setSelectedPart(
        `${this.anchorCode(this.selection.anchorId)} → ${label}`,
        this.anchorState(this.selection.anchorId),
      );
    } else {
      this.sidebar.setSelectedPart(`已选中：${label}`);
    }
  }

  // ------------------------------------------------------------------ 用户动作
  setPartVisible(partId: string, visible: boolean): void {
    this.assembly.setPartVisible(partId, visible);
    this.anchorSystem.syncOccluders();
    if (!visible && this.selection.partId === partId) this.clearSelection();
    this.resetLayout();
    this.refreshSidebar();
  }

  setPriority(anchorId: string, priority: number): void {
    this.priorities.set(anchorId, priority);
    this.overlay.setPriority(anchorId, priority);
    this.persist();
    this.resetLayout();
    this.refreshSidebar();
  }

  setLock(anchorId: string, locked: boolean): void {
    this.locks.set(anchorId, locked);
    this.overlay.setLocked(anchorId, locked);
    this.persist();
    this.resetLayout();
    this.refreshSidebar();
  }

  setShowOccluded(enabled: boolean): void {
    this.showOccluded = enabled;
    this.sidebar.setShowOccluded(enabled);
    this.persist();
    this.resetLayout();
  }

  setArmDegrees(degrees: number): void {
    this.assembly.setArmAngle(THREE.MathUtils.degToRad(degrees));
  }

  setAutoSwing(enabled: boolean): void {
    this.autoSwing = enabled;
    if (enabled) this.swingTime = 0;
    this.sidebar.setAutoSwing(enabled);
  }

  setNarrow(enabled: boolean): void {
    this.sidebar.setNarrowMode(enabled);
    document.getElementById('app')?.classList.toggle('narrow', enabled);
    // 尺寸变化由 ResizeObserver 统一触发重排。
  }

  flyToView(view: ViewPresetName): void {
    this.currentView = view;
    this.director.flyTo(VIEW_PRESETS[view], this.controls.target.clone());
    this.resetLayout();
    this.setFlyingClass(true);
    this.sidebar.setViewActive(view);
  }

  private setFlyingClass(flying: boolean): void {
    this.viewport.classList.toggle('is-flying', flying);
  }

  /** 清零粘滞位：下一次排布按当前状态重新选择每个标签的位置。 */
  private resetLayout(): void {
    this.stickySlots = new Map();
  }

  private refreshSidebar(): void {
    this.sidebar.render({
      anchors: this.assembly.anchors,
      parts: [...this.assembly.parts.values()],
      priorityOf: (id) => this.priorityOf(id),
      lockedOf: (id) => this.isLocked(id),
      stateOf: (id) => this.anchorState(id),
      selectedPartId: this.selection.partId,
    });
  }

  // ------------------------------------------------------------------ 尺寸
  private observeResize(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this.viewport);
    this.handleResize();
  }

  private handleResize(): void {
    const rect = this.viewport.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    if (width === this.lastViewport.width && height === this.lastViewport.height) return;
    this.lastViewport = { width, height };

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.resetLayout();
    this.remeasure();
  }

  private remeasure(): void {
    const rect = this.viewport.getBoundingClientRect();
    this.overlay.measure(
      Math.max(1, Math.round(rect.width)),
      Math.max(1, Math.round(rect.height)),
    );
  }

  // ------------------------------------------------------------------ 主循环
  private frame(nowMs: number): void {
    const now = nowMs / 1000;
    const dt = this.lastFrameTime > 0 ? Math.min(0.1, now - this.lastFrameTime) : 1 / 60;
    this.lastFrameTime = now;

    if (this.autoSwing) {
      this.swingTime += dt;
      const degrees = Math.sin(this.swingTime * 0.45) * 26;
      this.setArmDegrees(degrees);
      this.sidebar.setArmValue(degrees);
    }

    const flying = this.director.update(dt);
    if (!flying) this.controls.update();
    if (flying || this.wasFlying) {
      this.setFlyingClass(flying);
      this.resetLayout();
      this.wasFlying = flying;
    }

    // 相机不在 scene 图里，必须手动更新，否则锚点投影会落后一帧。
    this.camera.updateMatrixWorld(true);
    this.scene.updateMatrixWorld(true);
    this.anchorSystem.update(this.camera, this.lastViewport.width, this.lastViewport.height);

    // 视角变化分类：缓慢旋转沿用粘滞位；突然切换（预设、瞬移、快速拖拽）重排。
    const change = this.tracker.update(
      { position: this.camera.position, target: this.controls.target, fov: this.camera.fov },
      now,
    );
    if (change.kind === 'jump') this.resetLayout();

    this.updatePulse(dt);
    this.refreshLayout();
    this.renderer.render(this.scene, this.camera);

    this.rafHandle = requestAnimationFrame((t) => this.frame(t));
  }

  private refreshLayout(): void {
    const width = this.lastViewport.width;
    const height = this.lastViewport.height;

    const inputs: AnchorLayoutInput[] = [];
    for (let i = 0; i < this.anchorSystem.runtimes.length; i += 1) {
      const runtime = this.anchorSystem.runtimes[i];
      if (!runtime.partVisible || !runtime.inFront) continue;
      if (runtime.state === 'behind') continue;
      if (runtime.state === 'occluded' && !this.showOccluded) continue;
      const size = this.overlay.getSize(runtime.def.id);
      if (!size) continue;
      inputs.push({
        id: runtime.def.id,
        anchor: { x: runtime.screen.x, y: runtime.screen.y },
        width: size.width,
        height: size.height,
        priority: this.priorityOf(runtime.def.id),
        locked: this.isLocked(runtime.def.id),
        order: i,
      });
    }

    const result = layoutLabels(inputs, {
      viewport: { width, height },
      padding: 12,
      labelGap: 18,
      labelSpacing: 6,
      obstacles: hudObstacles(this.viewport),
      stickySlots: this.stickySlots,
    });
    this.stickySlots = result.slots;
    this.placements = result.placements;
    this.stowed = new Set(result.stowed.map((s) => s.id));

    this.overlay.update(
      this.anchorSystem.runtimes,
      this.placements,
      this.stowed,
      this.showOccluded,
    );

    this.sidebar.setHidden(result.stowed, (id) => {
      const def = this.assembly.anchors.find((a) => a.id === id);
      return def ? `${def.code} ${def.title}` : id;
    });

    let visibleCount = 0;
    let occludedCount = 0;
    for (const runtime of this.anchorSystem.runtimes) {
      if (!runtime.partVisible) continue;
      if (runtime.state === 'visible') visibleCount += 1;
      else if (runtime.state === 'occluded') occludedCount += 1;
    }
    this.sidebar.setStats(
      `可见 ${visibleCount} · 被挡 ${occludedCount} · 显示 ${result.placements.size} · 收起 ${result.stowed.length}`,
    );
    this.syncSelectionLabel();
    this.sidebar.setSelectedState(
      this.selection.anchorId ? this.anchorState(this.selection.anchorId) : null,
    );
    this.sidebar.updateAnchorStates((id) => this.anchorState(id));

    const anyAnchor = this.anchorSystem.runtimes.some((r) => r.partVisible);
    this.overlay.setEmptyMessage(
      anyAnchor ? null : '所有零件已隐藏 · 在左侧重新勾选零件后，标注会按同一套规则重新排布',
    );
  }

  private updatePulse(dt: number): void {
    if (!this.pulse.visible) return;
    this.pulseTime += dt;
    const duration = 1.6;
    if (this.pulseTime > duration) {
      this.pulse.visible = false;
      return;
    }
    const t = this.pulseTime / duration;
    this.pulse.scale.setScalar(1 + Math.sin(t * Math.PI) * 1.6);
    (this.pulse.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - t);
    this.pulse.position.copy(this.pulseOrigin);
  }

  // ------------------------------------------------------------------ 调试接口
  debugSnapshot() {
    const labels = this.anchorSystem.runtimes.map((runtime) => {
      const placement = this.placements.get(runtime.def.id);
      return {
        id: runtime.def.id,
        code: runtime.def.code,
        partId: runtime.def.partId,
        partVisible: runtime.partVisible,
        inFront: runtime.inFront,
        state: runtime.state,
        priority: this.priorityOf(runtime.def.id),
        locked: this.isLocked(runtime.def.id),
        screen: { x: runtime.screen.x, y: runtime.screen.y },
        world: runtime.world.toArray(),
        placed: Boolean(placement),
        rect: placement ? { ...placement.rect } : null,
        slot: placement ? placement.slot : null,
        sticky: placement ? placement.sticky : null,
        direction: placement ? placement.direction : null,
        leaderLength: placement ? placement.leaderLength : null,
        clamped: placement ? placement.clamped : null,
        stowed: this.stowed.has(runtime.def.id),
      };
    });
    return {
      viewport: { ...this.lastViewport },
      camera: {
        position: this.camera.position.toArray(),
        target: this.controls.target.toArray(),
        fov: this.camera.fov,
      },
      view: this.currentView,
      flying: this.director.isFlying,
      showOccluded: this.showOccluded,
      stowed: [...this.stowed],
      labels,
    };
  }

  /** 供自动化验收：直接点击某个标签的 DOM。 */
  clickLabelForTest(anchorId: string): boolean {
    const el = this.overlay.elementFor(anchorId);
    if (!el) return false;
    el.click();
    return true;
  }

  /** 每个零件的世界包围盒，用于校验标注点确实落在自己的零件上。 */
  partBoundsDebug(): Record<string, { min: number[]; max: number[] }> {
    const out: Record<string, { min: number[]; max: number[] }> = {};
    const box = new THREE.Box3();
    for (const part of this.assembly.parts.values()) {
      box.setFromObject(part.group);
      if (box.isEmpty()) continue;
      out[part.id] = { min: box.min.toArray(), max: box.max.toArray() };
    }
    return out;
  }

  probeAnchor(anchorId: string) {
    return this.anchorSystem.probe(anchorId, this.camera);
  }

  /** 供自动化验收：按视口像素坐标点击三维场景。 */
  clickPartAtForTest(x: number, y: number): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pickPart({ clientX: rect.left + x, clientY: rect.top + y } as PointerEvent);
  }

  dispose(): void {
    cancelAnimationFrame(this.rafHandle);
    this.resizeObserver?.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
  }
}

let app: App | null = null;

function must(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`缺少 #${id}`);
  return element;
}

/** 标签层需要避开的固定 UI 区域（悬浮状态条）。 */
function hudObstacles(viewport: HTMLElement): Rect[] {
  const hud = viewport.querySelector<HTMLElement>('.hud');
  if (!hud) return [];
  const host = viewport.getBoundingClientRect();
  const box = hud.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return [];
  return [
    {
      x: box.left - host.left - 8,
      y: box.top - host.top - 8,
      w: box.width + 16,
      h: box.height + 16,
    },
  ];
}

function boot(): void {
  try {
    app = new App();
  } catch (error) {
    console.error(error);
    const viewport = document.getElementById('viewport');
    if (viewport) {
      viewport.innerHTML =
        '<div class="fatal"><h2>无法启动三维视图</h2><p>请确认浏览器已启用 WebGL2（Chrome / Edge / Safari 17+）。</p></div>';
    }
    return;
  }

  const debug = {
    snapshot: () => app?.debugSnapshot(),
    setView: (name: ViewPresetName) => app?.flyToView(name),
    setArmAngle: (degrees: number) => app?.setArmDegrees(degrees),
    setAutoSwing: (enabled: boolean) => app?.setAutoSwing(enabled),
    setNarrow: (enabled: boolean) => app?.setNarrow(enabled),
    setShowOccluded: (enabled: boolean) => app?.setShowOccluded(enabled),
    setPriority: (id: string, priority: number) => app?.setPriority(id, priority),
    setLock: (id: string, locked: boolean) => app?.setLock(id, locked),
    setPartVisible: (id: string, visible: boolean) => app?.setPartVisible(id, visible),
    selectPart: (id: string) => app?.selectPart(id, null),
    focusAnchor: (id: string) => app?.focusAnchor(id),
    clickLabel: (id: string) => app?.clickLabelForTest(id),
    clickPartAt: (x: number, y: number) => app?.clickPartAtForTest(x, y),
    probe: (id: string) => app?.probeAnchor(id),
    partBounds: () => app?.partBoundsDebug(),
  };
  (window as unknown as { __assembly: typeof debug }).__assembly = debug;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
