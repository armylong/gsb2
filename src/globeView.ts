/**
 * globeView.ts —— Three.js 球面视图。
 *
 * 职责：
 * - 程序生成的球体、经纬网、地标；
 * - 同一条 GreatCircle 以圆管绘制，shader 按地平线平面逐片元裁剪，
 *   与地标/端点/指示点使用完全相同的地平线判据 (u·camDir >= 1/d)；
 * - 旋转/缩放只改变相机与裁剪 uniform，不改变所选路线；
 * - 点击球面取经纬度；在航线附近按下并拖动 = 沿路径 scrub。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  closestTToVector,
  vector3ToLonLat,
  type GreatCircle,
  type LonLat,
} from './geo';
import { LANDMARKS } from './landmarks';

const R = 1;
const ROUTE_R = 1.006;
const SCRUB_HIT_ANGLE = 0.075; // 弧度，约 4.3°，触屏也够大

export type PickMode = 'start' | 'end' | null;

export interface GlobeViewOptions {
  onPickEndpoint: (which: 'start' | 'end', ll: LonLat) => void;
  onScrubStart: (t: number) => void;
  onScrubMove: (t: number) => void;
  onScrubEnd: () => void;
  onHover: (t: number | null) => void;
  formatTooltip: (t: number) => string;
}

interface LabelItem {
  el: HTMLDivElement;
  dir: THREE.Vector3;
  radius: number;
}

interface EpBadge {
  el: HTMLDivElement;
  which: 'a' | 'b';
}

/** GreatCircle -> Three Curve，供 TubeGeometry 采样 */
class GeoCurve extends THREE.Curve<THREE.Vector3> {
  constructor(
    private readonly gc: GreatCircle,
    private readonly radius: number,
  ) {
    super();
  }
  getPoint(t: number, target = new THREE.Vector3()): THREE.Vector3 {
    return target.copy(this.gc.at(t).vec).multiplyScalar(this.radius);
  }
}

export class GlobeView {
  private readonly container: HTMLElement;
  private readonly opts: GlobeViewOptions;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNdc = new THREE.Vector2();
  private readonly resizeObs: ResizeObserver;
  private readonly tooltipEl: HTMLDivElement;

  private earth!: THREE.Mesh;
  private routeGroup = new THREE.Group();
  private routeMesh: THREE.Mesh | null = null;
  private routeHalo: THREE.Mesh | null = null;
  private startMarker: THREE.Group;
  private endMarker: THREE.Group;
  private scrubMarker: THREE.Group;
  private hoverMarker: THREE.Mesh;
  private centerRing: THREE.Mesh;

  private gc: GreatCircle | null = null;
  private scrubT = 0.35;
  private hoverT: number | null = null;
  private pickMode: PickMode = null;
  private centerLL: LonLat | null = null;

  /** 与 shader 共享的地平线 uniform 持有者 */
  private readonly uCamDir = { value: new THREE.Vector3(0, 0, 1) };
  private readonly uHorizonCos = { value: 0.4 };

  private readonly labels: LabelItem[] = [];
  private readonly epBadges: EpBadge[] = [];
  private readonly tmpDir = new THREE.Vector3();

  private scrubbing = false;
  private downSeen = false;
  private downX = 0;
  private downY = 0;

  constructor(container: HTMLElement, opts: GlobeViewOptions) {
    this.container = container;
    this.opts = opts;

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.domElement.className = 'globe-canvas';
    this.renderer.domElement.style.touchAction = 'none';
    container.appendChild(this.renderer.domElement);

    this.tooltipEl = document.createElement('div');
    this.tooltipEl.className = 'viz-tooltip globe-tooltip';
    this.tooltipEl.hidden = true;
    container.appendChild(this.tooltipEl);

    const w = container.clientWidth || 600;
    const h = container.clientHeight || 560;
    this.camera = new THREE.PerspectiveCamera(42, w / h, 0.01, 50);
    this.camera.position.set(0.35, 0.55, 2.55);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.rotateSpeed = 0.65;
    this.controls.minDistance = 1.35;
    this.controls.maxDistance = 6;
    this.controls.enablePan = false;

    this.buildScene();

    // 端点 / 指示标记
    this.startMarker = this.makeEndpointMarker('#2cc987');
    this.endMarker = this.makeEndpointMarker('#ff7a45');
    this.scene.add(this.startMarker, this.endMarker);

    this.scrubMarker = this.makeScrubMarker();
    this.scene.add(this.scrubMarker);

    this.hoverMarker = new THREE.Mesh(
      new THREE.RingGeometry(0.022, 0.029, 32),
      new THREE.MeshBasicMaterial({
        color: 0xb7aef5,
        transparent: true,
        opacity: 0.95,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    this.hoverMarker.visible = false;
    this.scene.add(this.hoverMarker);

    this.centerRing = new THREE.Mesh(
      new THREE.RingGeometry(0.03, 0.037, 40),
      new THREE.MeshBasicMaterial({
        color: 0x9085e9,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    this.centerRing.visible = false;
    this.scene.add(this.centerRing);

    this.scene.add(this.routeGroup);

    // 容器捕获阶段：若按在航线上，截获事件做 scrub，否则放行给 OrbitControls
    container.addEventListener('pointerdown', this.onPointerDownCapture, true);
    container.addEventListener('pointermove', this.onPointerMove);
    container.addEventListener('pointerleave', this.onPointerLeave);
    window.addEventListener('pointerup', this.onWindowPointerUp);
    window.addEventListener('pointermove', this.onWindowPointerMove);

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
    this.resize();

    this.renderer.setAnimationLoop(this.tick);
  }

  // ---------------- 场景构建 ----------------

  private buildScene(): void {
    this.scene.add(new THREE.AmbientLight(0xbcd6f5, 1.15));
    const sun = new THREE.DirectionalLight(0xffffff, 1.7);
    sun.position.set(3, 2.2, 2.4);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0x6fa8ff, 0.35);
    fill.position.set(-3, -1, -2);
    this.scene.add(fill);

    // 海洋球体
    const earthGeo = new THREE.SphereGeometry(R, 72, 48);
    const earthMat = new THREE.MeshPhongMaterial({
      color: 0x1c4e80,
      emissive: 0x0a223c,
      specular: 0x2a5f96,
      shininess: 14,
    });
    this.earth = new THREE.Mesh(earthGeo, earthMat);
    this.scene.add(this.earth);

    // 大气边缘光
    const atmo = new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.16, 64, 48),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexShader: /* glsl */ `
          varying vec3 vN;
          void main() {
            vN = normalize(normalMatrix * normal);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          varying vec3 vN;
          void main() {
            float f = pow(clamp(0.72 - dot(vN, vec3(0.0, 0.0, 1.0)), 0.0, 1.0), 3.2);
            gl_FragColor = vec4(0.36, 0.62, 1.0, 1.0) * f * 0.9;
          }`,
      }),
    );
    this.scene.add(atmo);

    // 经纬网（程序生成）
    const grid = this.buildGraticule();
    this.scene.add(grid);

    // 地标小点 + HTML 标签
    for (const lm of LANDMARKS) {
      const dir = this.llToDir(lm.ll);
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(0.0085, 16, 12),
        new THREE.MeshBasicMaterial({ color: 0xf2ead2 }),
      );
      dot.position.copy(dir).multiplyScalar(1.008);
      this.scene.add(dot);

      const el = document.createElement('div');
      el.className = 'globe-label';
      el.textContent = lm.name;
      this.container.appendChild(el);
      this.labels.push({ el, dir, radius: 1.045 });
    }

    // 起 / 终 HTML 徽章（直接标注，不单靠颜色）
    for (const which of ['a', 'b'] as const) {
      const el = document.createElement('div');
      el.className = `globe-ep-badge ${which === 'a' ? 'ep-start' : 'ep-end'}`;
      el.textContent = which === 'a' ? '起' : '终';
      this.container.appendChild(el);
      this.epBadges.push({ el, which });
    }
  }

  private buildGraticule(): THREE.LineSegments {
    const pts: number[] = [];
    const pushLine = (coords: LonLat[]) => {
      for (let i = 1; i < coords.length; i++) {
        const a = this.llToDir(coords[i - 1]).multiplyScalar(1.002);
        const b = this.llToDir(coords[i]).multiplyScalar(1.002);
        pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
    };
    for (let lon = -180; lon < 180; lon += 30) {
      const line: LonLat[] = [];
      for (let lat = -90; lat <= 90; lat += 2) line.push({ lon, lat });
      pushLine(line);
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      const line: LonLat[] = [];
      for (let lon = -180; lon <= 180; lon += 2) line.push({ lon, lat });
      pushLine(line);
    }
    for (const lat of [66.56, -66.56]) {
      const line: LonLat[] = [];
      for (let lon = -180; lon <= 180; lon += 3) line.push({ lon, lat });
      pushLine(line);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const mat = new THREE.LineBasicMaterial({
      color: 0x8fb6dd,
      transparent: true,
      opacity: 0.32,
    });
    return new THREE.LineSegments(geo, mat);
  }

  private makeEndpointMarker(color: string): THREE.Group {
    const group = new THREE.Group();
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.018, 20, 16),
      new THREE.MeshBasicMaterial({ color }),
    );
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.028, 0.005, 12, 44),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    ring.name = 'face';
    group.add(core, ring);
    return group;
  }

  private makeScrubMarker(): THREE.Group {
    const group = new THREE.Group();
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.02, 20, 16),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.034, 0.0045, 12, 40),
      new THREE.MeshBasicMaterial({ color: 0x6250d6 }),
    );
    ring.name = 'ring';
    group.add(core, ring);
    return group;
  }

  private llToDir(ll: LonLat): THREE.Vector3 {
    // 与 geo.lonLatToVector3 相同约定，避免循环开销直接内联
    const lat = (ll.lat * Math.PI) / 180;
    const lon = (ll.lon * Math.PI) / 180;
    const c = Math.cos(lat);
    return new THREE.Vector3(
      c * Math.cos(lon),
      Math.sin(lat),
      c * Math.sin(lon),
    );
  }

  // ---------------- 公共 API ----------------

  setPickMode(mode: PickMode): void {
    this.pickMode = mode;
    this.renderer.domElement.style.cursor = mode ? 'crosshair' : '';
  }

  setCenter(ll: LonLat | null): void {
    this.centerLL = ll;
    this.centerRing.visible = !!ll;
    if (ll) {
      const dir = this.llToDir(ll);
      this.centerRing.position.copy(dir).multiplyScalar(1.012);
      this.centerRing.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        dir,
      );
    }
  }

  setRoute(gc: GreatCircle | null): void {
    this.gc = gc;
    // 清掉旧圆管
    if (this.routeMesh) {
      this.routeGroup.remove(this.routeMesh);
      this.routeMesh.geometry.dispose();
      (this.routeMesh.material as THREE.Material).dispose();
      this.routeMesh = null;
    }
    if (this.routeHalo) {
      this.routeGroup.remove(this.routeHalo);
      this.routeHalo.geometry.dispose();
      (this.routeHalo.material as THREE.Material).dispose();
      this.routeHalo = null;
    }
    if (!gc || gc.kind === 'coincident') return;

    const curve = new GeoCurve(gc, ROUTE_R);
    const segments = Math.max(256, gc.samples.length);

    const haloMat = new THREE.MeshBasicMaterial({
      color: 0x2a78d6,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
    });
    this.injectHorizonClip(haloMat);
    this.routeHalo = new THREE.Mesh(
      new THREE.TubeGeometry(curve, segments, 0.014, 10, false),
      haloMat,
    );

    const coreMat = new THREE.MeshBasicMaterial({ color: 0x7db8ff });
    this.injectHorizonClip(coreMat);
    this.routeMesh = new THREE.Mesh(
      new THREE.TubeGeometry(curve, segments, 0.0055, 8, false),
      coreMat,
    );
    this.routeGroup.add(this.routeHalo, this.routeMesh);
  }

  /** 注入地平线 discard：与 HTML 标记共用 uCamDir / uHorizonCos */
  private injectHorizonClip(mat: THREE.MeshBasicMaterial): void {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uCamDir = this.uCamDir;
      shader.uniforms.uHorizonCos = this.uHorizonCos;
      shader.vertexShader =
        'varying vec3 vHorizonWorld;\n' +
        shader.vertexShader.replace(
          '#include <project_vertex>',
          `vHorizonWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
           #include <project_vertex>`,
        );
      shader.fragmentShader =
        'uniform vec3 uCamDir;\nuniform float uHorizonCos;\nvarying vec3 vHorizonWorld;\n' +
        shader.fragmentShader.replace(
          '#include <color_fragment>',
          `if (dot(normalize(vHorizonWorld), normalize(uCamDir)) < uHorizonCos) discard;
           #include <color_fragment>`,
        );
    };
  }

  setScrubT(t: number): void {
    this.scrubT = t;
  }

  setHoverT(t: number | null): void {
    this.hoverT = t;
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.resizeObs.disconnect();
    this.container.removeEventListener('pointerdown', this.onPointerDownCapture, true);
    this.container.removeEventListener('pointermove', this.onPointerMove);
    this.container.removeEventListener('pointerleave', this.onPointerLeave);
    window.removeEventListener('pointerup', this.onWindowPointerUp);
    window.removeEventListener('pointermove', this.onWindowPointerMove);
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.tooltipEl.remove();
    for (const l of this.labels) l.el.remove();
    for (const b of this.epBadges) b.el.remove();
  }

  // ---------------- 尺寸 / 帧循环 ----------------

  private resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private readonly tick = (): void => {
    this.controls.update();

    const camLen = this.camera.position.length();
    this.uCamDir.value.copy(this.camera.position).normalize();
    this.uHorizonCos.value = R / camLen;

    this.updateMarkers();
    this.updateLabels();
    this.updateEpBadges();
    this.renderer.render(this.scene, this.camera);
  };

  /** 统一地平线可见性判据：dir·camDir >= R/d */
  private isOverHorizon(dir: THREE.Vector3): boolean {
    return dir.dot(this.uCamDir.value) >= this.uHorizonCos.value;
  }

  private updateMarkers(): void {
    const gc = this.gc;
    if (!gc) {
      this.startMarker.visible = false;
      this.endMarker.visible = false;
      this.scrubMarker.visible = false;
      this.hoverMarker.visible = false;
      return;
    }
    const sDir = gc.a;
    const eDir = gc.b;
    const zAxis = new THREE.Vector3(0, 0, 1);
    this.startMarker.visible = gc.kind !== 'coincident' && this.isOverHorizon(sDir);
    this.startMarker.position.copy(sDir).multiplyScalar(1.012);
    this.startMarker.quaternion.setFromUnitVectors(zAxis, sDir);
    this.endMarker.visible = gc.kind !== 'coincident' && this.isOverHorizon(eDir);
    this.endMarker.position.copy(eDir).multiplyScalar(1.012);
    this.endMarker.quaternion.setFromUnitVectors(zAxis, eDir);

    const sp = gc.at(this.scrubT).vec;
    const scrubVisible = this.isOverHorizon(sp);
    this.scrubMarker.visible = scrubVisible;
    this.scrubMarker.position.copy(sp).multiplyScalar(1.014);
    this.scrubMarker.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      sp.clone().normalize(),
    );

    if (this.hoverT !== null) {
      const hp = gc.at(this.hoverT).vec;
      this.hoverMarker.visible = this.isOverHorizon(hp);
      this.hoverMarker.position.copy(hp).multiplyScalar(1.013);
      this.hoverMarker.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        hp.clone().normalize(),
      );
    } else {
      this.hoverMarker.visible = false;
    }

    if (this.centerLL) {
      this.centerRing.visible = this.isOverHorizon(this.tmpDir.copy(this.llToDir(this.centerLL)));
    }
  }

  private updateLabels(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const gc = this.gc;
    for (const item of this.labels) {
      // 与端点重合的地标不重复标名字（由起/终徽章负责）
      const nearEndpoint =
        gc &&
        gc.kind !== 'coincident' &&
        (item.dir.angleTo(gc.a) < 0.04 || item.dir.angleTo(gc.b) < 0.04);
      if (nearEndpoint || !this.isOverHorizon(item.dir)) {
        item.el.style.opacity = '0';
        continue;
      }
      const p = item.dir.clone().multiplyScalar(item.radius).project(this.camera);
      if (p.z > 1) {
        item.el.style.opacity = '0';
        continue;
      }
      let x = (p.x * 0.5 + 0.5) * w;
      let y = (-p.y * 0.5 + 0.5) * h;
      // 钳制到舞台内，避免顶部/两侧标签被 overflow:hidden 裁掉
      x = Math.max(42, Math.min(w - 42, x));
      y = Math.max(24, Math.min(h - 10, y));
      item.el.style.opacity = '1';
      item.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -135%)`;
    }
  }

  private updateEpBadges(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    for (const badge of this.epBadges) {
      const gc = this.gc;
      if (!gc || gc.kind === 'coincident') {
        badge.el.style.opacity = '0';
        continue;
      }
      const dir = badge.which === 'a' ? gc.a : gc.b;
      if (!this.isOverHorizon(dir)) {
        badge.el.style.opacity = '0';
        continue;
      }
      const p = dir.clone().multiplyScalar(1.05).project(this.camera);
      if (p.z > 1) {
        badge.el.style.opacity = '0';
        continue;
      }
      const x = (p.x * 0.5 + 0.5) * w;
      const y = (-p.y * 0.5 + 0.5) * h;
      badge.el.style.opacity = '1';
      badge.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
    }
  }

  /** 把相机摆到航线中点上空，使整条劣弧尽量完整可见（同时考虑视锥与地平线） */
  frameRoute(): void {
    const gc = this.gc;
    if (!gc || gc.kind === 'coincident') {
      this.camera.position.set(0.35, 0.55, 2.55);
      this.controls.target.set(0, 0, 0);
      this.controls.update();
      return;
    }
    // 1) 视锥适配：半径 1.12 的内容球要在垂直/水平方向都入画
    const halfFovV = (this.camera.fov * Math.PI) / 360;
    const tanV = Math.tan(halfFovV);
    const tanH = tanV * this.camera.aspect;
    const fitR = 1.14;
    const dFit = Math.max(fitR / tanV, fitR / tanH);

    // 2) 地平线适配：acos(1/d) ≥ ω/2 + 余量；对跖时无法看全，夹到 1.15 rad
    const fitAngle = Math.min(gc.omega / 2 + 0.12, 1.15);
    const dHorizon = 1 / Math.max(0.01, Math.cos(fitAngle));

    const d = Math.min(7, Math.max(2.1, dFit, dHorizon));
    const dir = gc.at(0.5).vec.clone().normalize();
    this.camera.position.copy(dir.multiplyScalar(d));
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  // ---------------- 指针交互 ----------------

  private setNdc(e: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointerNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointerNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  private pickSphere(e: PointerEvent): LonLat | null {
    this.setNdc(e);
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const hits = this.raycaster.intersectObject(this.earth, false);
    if (hits.length === 0) return null;
    return vector3ToLonLat(hits[0].point);
  }

  /** 返回指针射线与球面交点相对航线的最近 t（若击中球） */
  private routeHit(e: PointerEvent): { t: number; dist: number } | null {
    if (!this.gc || this.gc.kind === 'coincident') return null;
    this.setNdc(e);
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const hits = this.raycaster.intersectObject(this.earth, false);
    if (hits.length === 0) return null;
    const q = hits[0].point.clone().normalize();
    const { t, angleToRoute } = closestTToVector(this.gc, q);
    return { t, dist: angleToRoute };
  }

  private onPointerDownCapture = (e: PointerEvent): void => {
    this.downSeen = true;
    this.downX = e.clientX;
    this.downY = e.clientY;
    if (e.button !== 0 && e.pointerType === 'mouse') return;

    const hit = this.routeHit(e);
    // 点选端点模式下不拦截，保证“点哪设哪”；普通模式靠近航线才捕获为 scrub
    if (!this.pickMode && hit && hit.dist < SCRUB_HIT_ANGLE) {
      // 截获：OrbitControls 收不到 pointerdown，不会旋转
      e.stopPropagation();
      this.scrubbing = true;
      this.opts.onScrubStart(hit.t);
      this.showTooltipAt(e, hit.t);
    }
  };

  private onWindowPointerMove = (e: PointerEvent): void => {
    if (!this.scrubbing) return;
    const hit = this.routeHit(e);
    if (hit) {
      this.opts.onScrubMove(hit.t);
      this.showTooltipAt(e, hit.t);
    }
  };

  private onWindowPointerUp = (e: PointerEvent): void => {
    if (this.scrubbing) {
      this.scrubbing = false;
      this.downSeen = false;
      this.opts.onScrubEnd();
      this.tooltipEl.hidden = true;
      return;
    }
    if (!this.downSeen) return;
    this.downSeen = false;
    // 普通点击（位移很小）且处于点选模式 -> 取经纬度
    const moved = Math.hypot(e.clientX - this.downX, e.clientY - this.downY);
    if (moved > 6) return;
    if (!this.pickMode) return;
    // pointerup 可能发生在 canvas 外，用 down 坐标更稳；这里直接用事件坐标
    const ll = this.pickSphere({
      clientX: this.downX,
      clientY: this.downY,
    } as PointerEvent) ?? this.pickSphere(e);
    if (ll) this.opts.onPickEndpoint(this.pickMode, ll);
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (this.scrubbing) return;
    if (this.pickMode) {
      this.renderer.domElement.style.cursor = 'crosshair';
      this.opts.onHover(null);
      this.tooltipEl.hidden = true;
      return;
    }
    const hit = this.routeHit(e);
    if (hit && hit.dist < SCRUB_HIT_ANGLE) {
      this.renderer.domElement.style.cursor = 'pointer';
      this.opts.onHover(hit.t);
      this.showTooltipAt(e, hit.t);
    } else {
      this.renderer.domElement.style.cursor = this.pickMode ? 'crosshair' : '';
      this.opts.onHover(null);
      this.tooltipEl.hidden = true;
    }
  };

  private onPointerLeave = (): void => {
    if (!this.scrubbing) {
      this.opts.onHover(null);
      this.tooltipEl.hidden = true;
    }
  };

  private showTooltipAt(e: PointerEvent, t: number): void {
    this.tooltipEl.innerHTML = this.opts.formatTooltip(t);
    this.tooltipEl.hidden = false;
    const rect = this.container.getBoundingClientRect();
    let x = e.clientX - rect.left + 14;
    let y = e.clientY - rect.top + 14;
    const tw = this.tooltipEl.offsetWidth;
    const th = this.tooltipEl.offsetHeight;
    if (x + tw > rect.width - 8) x = e.clientX - rect.left - tw - 14;
    if (y + th > rect.height - 8) y = e.clientY - rect.top - th - 14;
    this.tooltipEl.style.left = `${Math.max(4, x)}px`;
    this.tooltipEl.style.top = `${Math.max(4, y)}px`;
  }
}
