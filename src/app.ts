import * as THREE from 'three';
import { CameraCollisionSolver, DEFAULT_CAMERA_CONFIG } from './math/camera';
import { DEFAULT_CHARACTER, moveCharacter, pivotPosition } from './math/character';
import { getLevel, LEVELS, clampToWorld } from './math/levels';
import type { Vec3 } from './math/vector';
import { v3 } from './math/vector';
import { InputManager } from './control/input';
import { buildLevelScene } from './render/scene';
import { Minimap } from './render/minimap';
import { Hud } from './render/hud';

const MOUSE_SENS = 0.0042;
const WHEEL_SENS = 0.0015;

export class App {
  private renderer: THREE.WebGLRenderer;
  private mapRenderer: THREE.WebGLRenderer;
  private mainCamera: THREE.PerspectiveCamera;
  private minimap: Minimap;
  private input: InputManager;
  private hud: Hud;

  private solver: CameraCollisionSolver;
  private scene!: THREE.Scene;
  private debugGroup!: THREE.Group;
  private character!: THREE.Group;
  private facing!: THREE.Object3D;

  private level = getLevel(LEVELS[0].id);
  private charPos: Vec3 = v3.create();
  private yaw = 0;
  private pitch = 0.28;
  private desiredDistance = 4.2;
  private collisionEnabled = true;
  private mapVisible = true;
  private waypointIndex = 0;

  private desiredCamMarker!: THREE.Mesh;
  private pivotMarker!: THREE.Mesh;
  private charMaterials: THREE.MeshStandardMaterial[] = [];

  private clock = new THREE.Clock();
  private fpsSmoothed = 60;
  private raf = 0;
  private resizeObserver: ResizeObserver;

  constructor() {
    const viewport = document.getElementById('viewport')!;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    viewport.appendChild(this.renderer.domElement);

    this.mapRenderer = new THREE.WebGLRenderer({
      canvas: document.getElementById('minimap') as HTMLCanvasElement,
      antialias: true,
    });
    this.mapRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.mainCamera = new THREE.PerspectiveCamera(
      (DEFAULT_CAMERA_CONFIG.fovY * 180) / Math.PI,
      1,
      DEFAULT_CAMERA_CONFIG.near,
      200,
    );
    this.minimap = new Minimap();
    this.input = new InputManager(this.renderer.domElement);
    this.hud = new Hud();
    this.solver = new CameraCollisionSolver({ ...DEFAULT_CAMERA_CONFIG });

    this.bindInput();
    this.loadLevel(this.level.id, true);

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(viewport);
    this.handleResize();
  }

  private bindInput(): void {
    this.input.onToggleMap = () => this.toggleMap();
    this.input.onToggleCollision = () => this.toggleCollision();
    this.input.onReset = () => this.resetAll();
    this.hud.onSelectLevel = (id) => this.loadLevel(id, true);
    this.hud.onToggleMap = () => this.toggleMap();
    this.hud.onToggleCollision = () => this.toggleCollision();
    this.hud.onReset = () => this.resetAll();
    this.hud.onPrevWaypoint = () => this.jumpWaypoint(-1);
    this.hud.onNextWaypoint = () => this.jumpWaypoint(1);
    this.hud.onRadiusChange = (r) => {
      this.solver.cfg.collisionRadius = r;
    };
    this.hud.onNearChange = (n) => {
      this.solver.cfg.near = n;
      this.mainCamera.near = n;
      this.mainCamera.updateProjectionMatrix();
    };
  }

  private toggleMap(): void {
    this.mapVisible = !this.mapVisible;
    const el = document.getElementById('minimap')!;
    el.hidden = !this.mapVisible;
    this.hud.setMapButton(this.mapVisible);
  }

  private toggleCollision(): void {
    this.collisionEnabled = !this.collisionEnabled;
    this.hud.setCollisionButton(this.collisionEnabled);
    // 切回碰撞时重置平滑，避免用关闭期间的远距离穿墙插值
    if (this.collisionEnabled) this.solver.reset(this.desiredDistance);
  }

  private resetAll(): void {
    this.loadLevel(this.level.id, true);
  }

  private jumpWaypoint(dir: number): void {
    const total = this.level.waypoints.length;
    this.waypointIndex = (this.waypointIndex + dir + total) % total;
    const wp = this.level.waypoints[this.waypointIndex];
    this.charPos.x = wp.pos.x;
    this.charPos.z = wp.pos.z;
    this.solver.reset(this.desiredDistance);
  }

  private loadLevel(id: string, resetView: boolean): void {
    this.level = getLevel(id);
    this.scene = this.buildRootScene();
    const built = buildLevelScene(this.level);
    this.scene.add(built.group);
    this.character = built.character;
    this.facing = built.facing;

    this.charPos = v3.copy(v3.create(), this.level.spawn);
    this.waypointIndex = 0;
    if (resetView) {
      this.yaw = this.level.spawnYaw;
      this.pitch = 0.28;
      this.desiredDistance = 4.2;
      this.solver.reset(this.desiredDistance);
    }

    this.addDebugMarkers();
    this.minimap.setLevel(this.level.boxes, this.level.waypoints);
    this.hud.setActiveLevel(id);
    this.hud.setMapButton(this.mapVisible);
    this.hud.setCollisionButton(this.collisionEnabled);
  }

  private buildRootScene(): THREE.Scene {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1b2430);
    scene.fog = new THREE.Fog(0x1b2430, 32, 72);
    scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x3a4150, 0.95));
    const dir = new THREE.DirectionalLight(0xfff2dd, 1.4);
    dir.position.set(8, 16, 6);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    dir.shadow.camera.left = -22;
    dir.shadow.camera.right = 22;
    dir.shadow.camera.top = 22;
    dir.shadow.camera.bottom = -22;
    dir.shadow.camera.far = 60;
    scene.add(dir);
    return scene;
  }

  /** 主场景调试 marker：pivot、期望相机、pivot→实际相机连线。
   *  实际相机与碰撞球位于相机自身附近，放入主视图只会遮挡画面，
   *  需求要求的四项标注统一由俯视辅助图给出。 */
  private addDebugMarkers(): void {
    this.debugGroup = new THREE.Group();
    this.debugGroup.name = 'debug-markers';

    this.pivotMarker = new THREE.Mesh(
      new THREE.SphereGeometry(0.1, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xffd166 }),
    );
    this.desiredCamMarker = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.2),
      new THREE.MeshBasicMaterial({ color: 0x4cc9f0, wireframe: true }),
    );

    // pivot→相机的连线不放进主视图（会垂直穿过角色造成干扰），
    // 空间关系统一由俯视辅助图表达。
    this.debugGroup.add(this.pivotMarker, this.desiredCamMarker);
    this.scene.add(this.debugGroup);

    // 收集角色材质用于近距离淡出
    this.charMaterials = [];
    this.character.traverse((o) => {
      const mesh = o as THREE.Mesh;
      const mat = mesh.material as THREE.MeshStandardMaterial | undefined;
      if (mat && mat.isMeshStandardMaterial) {
        mat.transparent = true;
        this.charMaterials.push(mat);
      }
    });
  }

  /** 相机贴近时淡出角色，避免镜头钻进自身模型；远离后恢复 */
  private updateCharacterFade(actualDistance: number): void {
    const opacity = THREE.MathUtils.clamp((actualDistance - 0.55) / 0.45, 0, 1);
    for (const mat of this.charMaterials) {
      mat.opacity = opacity;
      mat.depthWrite = opacity > 0.5;
    }
  }

  start(): void {
    this.clock.start();
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.frame();
    };
    loop();
  }

  /**
   * 验证探针：用独立临时求解器对任意几何跑一帧，
   * 供控制台 / E2E 验证打包后的真实碰撞代码，不影响主场景状态。
   */
  runSolverProbe(
    pivot: Vec3,
    yaw: number,
    pitch: number,
    desired: number,
    radius: number,
    near: number,
    boxes: import('./math/aabb').AABB[],
  ): unknown {
    const probe = new CameraCollisionSolver({
      ...DEFAULT_CAMERA_CONFIG,
      collisionRadius: radius,
      near,
      aspect: this.mainCamera.aspect,
    });
    return probe.update(pivot, yaw, pitch, desired, 1 / 60, boxes);
  }

  private frame(): void {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.fpsSmoothed = this.fpsSmoothed * 0.92 + (1 / Math.max(dt, 1e-4)) * 0.08;

    // ---- 视角输入：yaw/pitch 只由鼠标驱动，角色转向不重置观察角 ----
    this.yaw += this.input.mouseDX * MOUSE_SENS;
    this.pitch = THREE.MathUtils.clamp(
      this.pitch + this.input.mouseDY * MOUSE_SENS,
      -1.45,
      1.45,
    );
    if (this.input.wheelDelta !== 0) {
      this.desiredDistance = THREE.MathUtils.clamp(
        this.desiredDistance + this.input.wheelDelta * WHEEL_SENS,
        this.solver.cfg.minDistance,
        this.solver.cfg.maxDistance,
      );
    }

    // ---- 角色移动：方向相对当前观察 yaw，碰撞逐轴推出 ----
    const move = this.input.sampleMove();
    if (move.x !== 0 || move.z !== 0) {
      const sin = Math.sin(this.yaw);
      const cos = Math.cos(this.yaw);
      const worldX = move.x * cos + move.z * sin;
      const worldZ = -move.x * sin + move.z * cos;
      const delta = v3.create(
        worldX * DEFAULT_CHARACTER.moveSpeed * dt,
        0,
        worldZ * DEFAULT_CHARACTER.moveSpeed * dt,
      );
      moveCharacter(this.charPos, delta, DEFAULT_CHARACTER.radius, this.level.boxes);
      clampToWorld(this.charPos);
      // 仅视觉朝向，不影响相机
      this.facing.rotation.y = Math.atan2(-worldX, -worldZ);
    }
    this.character.position.set(this.charPos.x, this.charPos.y, this.charPos.z);

    // ---- 相机碰撞求解（关闭碰撞对照时传空盒集）----
    const pivot = pivotPosition(this.charPos, DEFAULT_CHARACTER.pivotHeight, v3.create());
    const boxes = this.collisionEnabled ? this.level.boxes : [];
    const result = this.solver.update(
      pivot, this.yaw, this.pitch, this.desiredDistance, dt, boxes,
    );

    this.mainCamera.position.set(result.actualPos.x, result.actualPos.y, result.actualPos.z);
    this.mainCamera.lookAt(pivot.x, pivot.y, pivot.z);
    this.updateCharacterFade(result.actualDistance);
    this.updateDebugMarkers(pivot, result);

    if (this.mapVisible) {
      this.minimap.update(
        pivot, result.desiredPos, result.actualPos,
        this.solver.cfg.collisionRadius, this.minimapAspect(),
      );
    }

    this.hud.update({
      desiredDistance: result.desiredDistance,
      actualDistance: result.actualDistance,
      safeDistance: result.safeDistance,
      noSolution: result.safeDistance < 0,
      minDistance: this.solver.cfg.minDistance,
      minClearance: result.safeDistance < 0 ? NaN : result.minClearance,
      collisionRadius: this.solver.cfg.collisionRadius,
      constrained: result.constrained,
      frustumClamped: result.frustumClamped,
      limitingBoxes: result.limitingBoxes,
      collisionEnabled: this.collisionEnabled,
      yawDeg: (this.yaw * 180) / Math.PI,
      pitchDeg: (this.pitch * 180) / Math.PI,
      fps: this.fpsSmoothed,
      levelLabel: this.level.label,
      waypointIndex: this.waypointIndex,
      waypointTotal: this.level.waypoints.length,
      waypointLabel: this.level.waypoints[this.waypointIndex].label,
    });

    this.render();
    this.input.endFrame();
  }

  private updateDebugMarkers(pivot: Vec3, result: ReturnType<CameraCollisionSolver['update']>): void {
    this.pivotMarker.position.set(pivot.x, pivot.y, pivot.z);
    this.desiredCamMarker.position.set(result.desiredPos.x, result.desiredPos.y, result.desiredPos.z);
    // 期望相机与实际相机重合时，marker 会落在相机眼睛处、线框放射状遮挡画面，
    // 因此只在确实发生缩近（两者分离）时显示
    const separated = Math.abs(result.desiredDistance - result.actualDistance) > 0.08;
    this.desiredCamMarker.visible = separated && this.collisionEnabled;
    (this.desiredCamMarker.material as THREE.MeshBasicMaterial)
      .color.setHex(this.collisionEnabled ? 0x4cc9f0 : 0x666666);
  }

  private minimapAspect(): number {
    const el = document.getElementById('minimap')!;
    return el.clientWidth / Math.max(el.clientHeight, 1);
  }

  private handleResize(): void {
    const viewport = document.getElementById('viewport')!;
    const w = viewport.clientWidth;
    const h = Math.max(viewport.clientHeight, 1);
    this.renderer.setSize(w, h, false);
    this.mainCamera.aspect = w / h;
    this.mainCamera.updateProjectionMatrix();
    this.solver.cfg.aspect = this.mainCamera.aspect;

    const mm = document.getElementById('minimap')!;
    this.mapRenderer.setSize(mm.clientWidth, mm.clientHeight, false);
  }

  private render(): void {
    this.renderer.render(this.scene, this.mainCamera);
    if (this.mapVisible) {
      this.mapRenderer.render(this.minimap.scene, this.minimap.camera);
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.input.dispose();
    this.renderer.dispose();
    this.mapRenderer.dispose();
  }
}
