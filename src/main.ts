/**
 * 观察页主程序：
 * - 左视口：两块曲面直接拼接（不同细分 → 裂缝可见）
 * - 右视口：接缝修正后的同一对曲面（密侧边顶点吸附到疏侧折线）
 * 两个视口各用一台相机，相机平移半个视间距，保证看到的是同一个模型的两个版本。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import {
  Patch,
  MeshData,
  createInitialPatches,
  tessellate,
  fixSeam,
  measureGap,
  evaluateSharedEdge,
  GapReport,
} from './core/surface';
import { Vec3 } from './core/vec3';
import { meshToGeometry, edgeLineGeometry } from './core/threeAdapter';

interface ViewSet {
  group: THREE.Group;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  surfaces: THREE.Mesh[];
  wires: THREE.LineSegments[];
  edgeLines: THREE.LineSegments[];
}

const SPLIT_GAP = 7; // 两个视口中心在世界坐标中的间距
const FOV = 50;

class Lab {
  private renderer: THREE.WebGLRenderer;
  private host: HTMLElement;
  private direct: ViewSet;
  private fixed: ViewSet;
  private transform: TransformControls;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private pointSpheres: THREE.Mesh[] = [];
  private pointSphereMap = new Map<THREE.Mesh, { patch: 'A' | 'B'; u: number; v: number }>();
  private arrowA!: THREE.ArrowHelper;
  private arrowB!: THREE.ArrowHelper;

  private patchA: Patch;
  private patchB: Patch;
  private options = { wireframe: true, showPoints: true, split: true };
  private selectedKey = '';

  constructor() {
    this.host = document.getElementById('canvas-host')!;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setScissorTest(true);
    this.host.appendChild(this.renderer.domElement);

    const initial = createInitialPatches();
    this.patchA = initial.patchA;
    this.patchB = initial.patchB;
    this.applyUrlParams();

    this.direct = this.createView(-SPLIT_GAP / 2);
    this.fixed = this.createView(SPLIT_GAP / 2);

    // TransformControls 挂在直接拼接视口的场景上（控制点在左视口编辑）
    this.transform = new TransformControls(this.direct.camera, this.renderer.domElement);
    this.transform.addEventListener('objectChange', () => this.onControlDragged());
    // r180 起 TransformControls 本身不再是 Object3D，需通过 getHelper() 取 gizmo 入场景
    this.direct.group.parent!.add(this.transform.getHelper());

    // 两个 OrbitControls 共用一个 canvas：在捕获阶段按指针所在半屏决定哪台响应，
    // 且 TransformControls 拖拽期间一律禁用轨道（dragging-changed 不再需要维护开关）
    const gateControls = (view: ViewSet, isLeft: boolean) => {
      view.controls.domElement!.addEventListener(
        'pointerdown',
        (ev) => {
          if (this.transform.dragging) {
            view.controls.enabled = false;
            return;
          }
          const rect = this.renderer.domElement.getBoundingClientRect();
          const inLeft = ev.clientX - rect.left <= rect.width / 2;
          view.controls.enabled = !this.options.split || inLeft === isLeft;
        },
        true,
      );
    };
    gateControls(this.direct, true);
    gateControls(this.fixed, false);

    this.bindEvents();
    this.syncUIControls();
    this.applyCameraDistanceParam();
    this.buildPointPicker();
    this.rebuild();
    this.resize();
  }

  /** URL ?dist= 初始化相机距离（测量面板滑杆同步） */
  private applyCameraDistanceParam() {
    const raw = new URLSearchParams(location.search).get('dist');
    if (raw === null) return;
    const d = Number(raw);
    if (!Number.isFinite(d)) return;
    const clamped = Math.min(48, Math.max(4, d));
    const slider = document.getElementById('camDist') as HTMLInputElement;
    slider.value = String(clamped);
    document.getElementById('dist-val')!.textContent = clamped.toFixed(1);
    this.setCameraDistance(this.direct, clamped);
    this.setCameraDistance(this.fixed, clamped);
  }

  private createView(offsetX: number): ViewSet {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x14161a);

    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 200);
    camera.position.set(9, -7, 7);
    camera.lookAt(offsetX, 0, 0);

    const group = new THREE.Group();
    group.position.x = offsetX;
    scene.add(group);

    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    scene.add(ambient);
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(6, -8, 10);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.35);
    fill.position.set(-6, 6, 4);
    scene.add(fill);

    const grid = new THREE.GridHelper(12, 24, 0x2c323c, 0x22262d);
    grid.position.set(offsetX, -2.6, 0);
    scene.add(grid);

    const controls = new OrbitControls(camera, this.renderer.domElement);
    controls.target.set(offsetX, 0, 0.4);
    controls.enableDamping = true;

    // 把 scene 暂挂到 group 上供渲染循环取用
    (group as unknown as { userScene: THREE.Scene }).userScene = scene;
    return { group, camera, controls, surfaces: [], wires: [], edgeLines: [] };
  }

  // ---------- 构建 ----------

  private clearView(view: ViewSet) {
    [...view.surfaces, ...view.wires, ...view.edgeLines].forEach((obj) => {
      view.group.remove(obj);
      const mesh = obj as THREE.Mesh;
      mesh.geometry?.dispose();
      const mat = (mesh as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    });
    view.surfaces = [];
    view.wires = [];
    view.edgeLines = [];
  }

  private addSurface(view: ViewSet, mesh: MeshData, color: number, edgeColor: number) {
    const geo = meshToGeometry(mesh);
    const mat = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.55,
      metalness: 0.05,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.92,
    });
    const surface = new THREE.Mesh(geo, mat);
    view.group.add(surface);
    view.surfaces.push(surface);

    const wireGeo = new THREE.WireframeGeometry(geo);
    const wire = new THREE.LineSegments(
      wireGeo,
      new THREE.LineBasicMaterial({ color: 0x111418, transparent: true, opacity: 0.9 }),
    );
    wire.visible = this.options.wireframe;
    view.group.add(wire);
    view.wires.push(wire);

    const edge = new THREE.LineSegments(
      edgeLineGeometry(mesh),
      new THREE.LineBasicMaterial({ color: edgeColor, linewidth: 2 }),
    );
    view.group.add(edge);
    view.edgeLines.push(edge);
  }

  /** 仅重建两块曲面 / 接缝高亮 / 箭头 / 测量；不动控制点 sphere 与 gizmo（拖拽中调用） */
  private rebuildSurfaces() {
    const meshA = tessellate(this.patchA);
    const meshB = tessellate(this.patchB);
    const { fixedA, fixedB } = fixSeam(meshA, meshB);

    this.clearView(this.direct);
    this.clearView(this.fixed);
    // 直接拼接：共享边红色高亮（裂缝处）
    this.addSurface(this.direct, meshA, 0xe0884a, 0xff5252);
    this.addSurface(this.direct, meshB, 0x4a90e0, 0xff5252);
    // 修正后：共享边绿色
    this.addSurface(this.fixed, fixedA, 0xe0884a, 0x5fd08a);
    this.addSurface(this.fixed, fixedB, 0x4a90e0, 0x5fd08a);

    this.rebuildArrows();
    this.updateMetrics(meshA, meshB, fixedA, fixedB);
  }

  /** 全量重建：曲面 + 控制点 sphere + gizmo（结构变化时调用） */
  private rebuild() {
    this.rebuildSurfaces();
    this.rebuildPointSpheres();
  }

  private rebuildArrows() {
    // 箭头表示各曲面共享边的局部 v 增长方向（反转后箭头自动调头）
    const makeArrow = (patch: Patch, color: number) => {
      const vMid = 0.5;
      const p0 = evaluateSharedEdge(patch, vMid);
      const p1 = evaluateSharedEdge(patch, Math.min(1, vMid + 0.08));
      const origin = new THREE.Vector3(p0.x, p0.y, p0.z + 0.35);
      const dir = new THREE.Vector3(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z).normalize();
      return new THREE.ArrowHelper(dir, origin, 0.8, color, 0.22, 0.12);
    };
    this.arrowA?.removeFromParent();
    this.arrowB?.removeFromParent();
    this.arrowA = makeArrow(this.patchA, 0xffb066);
    this.arrowB = makeArrow(this.patchB, 0x8fc1ff);
    this.direct.group.add(this.arrowA, this.arrowB);
  }

  // ---------- 控制点 ----------

  private uniqueControlPoints(): { key: string; label: string; point: Vec3 }[] {
    const items: { key: string; label: string; point: Vec3 }[] = [];
    const seen = new Set<Vec3>();
    const collect = (patch: Patch, tag: 'A' | 'B') => {
      for (let u = 0; u < 4; u++) {
        for (let v = 0; v < 4; v++) {
          const p = patch.grid[u][v];
          if (seen.has(p)) continue;
          seen.add(p);
          const shared =
            (tag === 'A' && u === 3) || (tag === 'B' && u === 0);
          items.push({
            key: `${tag}-${u}-${v}`,
            label: `Patch ${tag} [u${u} v${v}]${shared ? '（共享边）' : ''}`,
            point: p,
          });
        }
      }
    };
    collect(this.patchA, 'A');
    collect(this.patchB, 'B');
    return items;
  }

  private buildPointPicker() {
    const select = document.getElementById('pointSelect') as HTMLSelectElement;
    select.innerHTML = '';
    for (const item of this.uniqueControlPoints()) {
      const opt = document.createElement('option');
      opt.value = item.key;
      opt.textContent = item.label;
      select.appendChild(opt);
    }
    if (!this.selectedKey) this.selectedKey = select.value;
    select.value = this.selectedKey;
  }

  /**
   * 从 URL 查询参数初始化状态，便于复现/分享特定场景：
   * ?va=2&vb=24&ua=8&ub=8&revA=0&revB=1&dist=8
   */
  private applyUrlParams() {
    const q = new URLSearchParams(location.search);
    const intParam = (key: string, min: number, max: number): number | null => {
      const raw = q.get(key);
      if (raw === null) return null;
      const n = Math.round(Number(raw));
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
    };
    const va = intParam('va', 1, 32);
    const vb = intParam('vb', 1, 32);
    const ua = intParam('ua', 1, 32);
    const ub = intParam('ub', 1, 32);
    if (va !== null) this.patchA.subdivV = va;
    if (vb !== null) this.patchB.subdivV = vb;
    if (ua !== null) this.patchA.subdivU = ua;
    if (ub !== null) this.patchB.subdivU = ub;
    if (q.get('revA') !== null) this.patchA.edgeReversed = q.get('revA') === '1';
    if (q.get('revB') !== null) this.patchB.edgeReversed = q.get('revB') === '1';
  }

  /** 把全部 UI 控件的值回写为当前 patch 状态（重置样例时使用） */
  private syncUIControls() {
    const setRange = (id: string, labelId: string, value: number) => {
      const input = document.getElementById(id) as HTMLInputElement;
      input.value = String(value);
      document.getElementById(labelId)!.textContent = String(value);
    };
    setRange('subdivVA', 'va-val', this.patchA.subdivV);
    setRange('subdivUA', 'ua-val', this.patchA.subdivU);
    setRange('subdivVB', 'vb-val', this.patchB.subdivV);
    setRange('subdivUB', 'ub-val', this.patchB.subdivU);
    (document.getElementById('reverseA') as HTMLInputElement).checked = this.patchA.edgeReversed;
    (document.getElementById('reverseB') as HTMLInputElement).checked = this.patchB.edgeReversed;
  }

  private pointSphereGeo = new THREE.SphereGeometry(0.09, 16, 12);

  private rebuildPointSpheres() {
    this.pointSpheres.forEach((s) => {
      s.removeFromParent();
      (s.material as THREE.Material).dispose();
    });
    this.pointSpheres = [];
    this.pointSphereMap.clear();

    for (const item of this.uniqueControlPoints()) {
      const isShared = item.label.includes('共享');
      const mat = new THREE.MeshStandardMaterial({
        color: isShared ? 0xffd166 : item.key.startsWith('A') ? 0xe0884a : 0x4a90e0,
        emissive: item.key === this.selectedKey ? 0xffffff : 0x000000,
        emissiveIntensity: item.key === this.selectedKey ? 0.35 : 0,
      });
      const sphere = new THREE.Mesh(this.pointSphereGeo, mat);
      sphere.position.set(item.point.x, item.point.y, item.point.z);
      sphere.visible = this.options.showPoints;
      this.direct.group.add(sphere);
      this.pointSpheres.push(sphere);
      const [, uStr, vStr] = item.key.split('-');
      this.pointSphereMap.set(sphere, {
        patch: item.key[0] as 'A' | 'B',
        u: Number(uStr),
        v: Number(vStr),
      });
    }
    this.attachTransformToSelected();
  }

  /** 拖拽过程中把各 sphere 位置同步到控制点（共享点引用天然联动），不重建 gizmo */
  private syncSpherePositions() {
    this.uniqueControlPoints().forEach((item, i) => {
      const sphere = this.pointSpheres[i];
      if (!sphere || this.transform.object === sphere) return; // 被拖拽的 sphere 由 gizmo 驱动
      sphere.position.set(item.point.x, item.point.y, item.point.z);
    });
  }

  private selectedPoint(): { key: string; point: Vec3 } | null {
    const item = this.uniqueControlPoints().find((i) => i.key === this.selectedKey);
    return item ? { key: item.key, point: item.point } : null;
  }

  private attachTransformToSelected() {
    this.transform.detach();
    const sphere = this.pointSpheres.find((s) => {
      const info = this.pointSphereMap.get(s)!;
      return `A-${info.u}-${info.v}` === this.selectedKey || `B-${info.u}-${info.v}` === this.selectedKey;
    });
    const sel = this.selectedPoint();
    if (!sphere || !sel) return;
    // 选中的若是共享点，sphere 与控制点共享位置；直接把 gizmo 挂到 sphere
    this.transform.attach(sphere);
    this.syncPointInputs(sel.point);
  }

  private onControlDragged() {
    const obj = this.transform.object;
    if (!obj) return;
    const info = this.pointSphereMap.get(obj as THREE.Mesh);
    if (!info) return;
    const patch = info.patch === 'A' ? this.patchA : this.patchB;
    const target = patch.grid[info.u][info.v];
    target.x = obj.position.x;
    target.y = obj.position.y;
    target.z = obj.position.z;
    // 共享引用保证对侧自动同步；只更新曲面与其余 sphere，不重建 gizmo（拖拽不断流）
    this.syncSpherePositions();
    this.rebuildSurfaces();
    this.syncPointInputs(target);
  }

  private syncPointInputs(p: Vec3) {
    (document.getElementById('cpX') as HTMLInputElement).value = p.x.toFixed(3);
    (document.getElementById('cpY') as HTMLInputElement).value = p.y.toFixed(3);
    (document.getElementById('cpZ') as HTMLInputElement).value = p.z.toFixed(3);
  }

  // ---------- 测量 ----------

  private updateMetrics(meshA: MeshData, meshB: MeshData, fixedA: MeshData, fixedB: MeshData) {
    const fineFirst = meshA.nv >= meshB.nv;
    const directGap: GapReport = fineFirst
      ? measureGap(meshA, meshB)
      : measureGap(meshB, meshA);
    const fixedGap: GapReport = fineFirst
      ? measureGap(fixedA, fixedB)
      : measureGap(fixedB, fixedA);

    const camDist = Number((document.getElementById('camDist') as HTMLInputElement).value);
    const toPx = (world: number) => {
      const fov = (FOV * Math.PI) / 180;
      const worldPerPixel = (2 * camDist * Math.tan(fov / 2)) / this.renderer.domElement.clientHeight;
      return world / worldPerPixel;
    };

    const el = document.getElementById('metrics')!;
    const row = (name: string, g: GapReport) =>
      `${name}:\n` +
      `  最大偏离      ${g.maxDeviation.toExponential(4)}\n` +
      `  密→疏 / 疏→密  ${g.maxFineToCoarse.toExponential(3)} / ${g.maxCoarseToFine.toExponential(3)}\n` +
      `  最差位置 s    ${g.worstS.toFixed(3)}\n` +
      `  当前距离像素  ${toPx(g.maxDeviation).toFixed(3)} px\n` +
      `  边顶点数      密 ${g.fineVertexCount} / 疏 ${g.coarseVertexCount}`;

    el.innerHTML =
      `<span class="bad">${row('● 直接拼接', directGap)}</span>\n\n` +
      `<span class="good">${row('● 接缝修正', fixedGap)}</span>`;

    // 距离预设表（确定性的多距离复核，与 npm run verify 同一公式）
    const presets = [8, 16, 32];
    el.innerHTML +=
      '\n\n多距离像素偏离（直接 / 修正）:\n' +
      presets
        .map((d) => {
          const fov = (FOV * Math.PI) / 180;
          const wpp = (2 * d * Math.tan(fov / 2)) / 900;
          return `  d=${String(d).padStart(2)}: ${(directGap.maxDeviation / wpp).toFixed(2)} px / ${(fixedGap.maxDeviation / wpp).toExponential(1)} px`;
        })
        .join('\n');
  }

  // ---------- 事件 ----------

  private bindEvents() {
    window.addEventListener('resize', () => this.resize());

    const bindRange = (id: string, labelId: string, apply: (v: number) => void) => {
      const input = document.getElementById(id) as HTMLInputElement;
      const label = document.getElementById(labelId)!;
      input.addEventListener('input', () => {
        label.textContent = input.value;
        apply(Number(input.value));
        this.rebuild();
      });
    };
    bindRange('subdivVA', 'va-val', (v) => (this.patchA.subdivV = v));
    bindRange('subdivUA', 'ua-val', (v) => (this.patchA.subdivU = v));
    bindRange('subdivVB', 'vb-val', (v) => (this.patchB.subdivV = v));
    bindRange('subdivUB', 'ub-val', (v) => (this.patchB.subdivU = v));

    (document.getElementById('wireframe') as HTMLInputElement).addEventListener('change', (e) => {
      this.options.wireframe = (e.target as HTMLInputElement).checked;
      [...this.direct.wires, ...this.fixed.wires].forEach((w) => (w.visible = this.options.wireframe));
    });
    (document.getElementById('showPoints') as HTMLInputElement).addEventListener('change', (e) => {
      this.options.showPoints = (e.target as HTMLInputElement).checked;
      this.pointSpheres.forEach((s) => (s.visible = this.options.showPoints));
    });
    (document.getElementById('splitView') as HTMLInputElement).addEventListener('change', (e) => {
      this.options.split = (e.target as HTMLInputElement).checked;
      document.body.classList.toggle('split', this.options.split);
      document.getElementById('label-right')!.style.display = this.options.split ? '' : 'none';
      this.resize();
    });
    (document.getElementById('reverseA') as HTMLInputElement).addEventListener('change', (e) => {
      this.patchA.edgeReversed = (e.target as HTMLInputElement).checked;
      this.rebuild();
    });
    (document.getElementById('reverseB') as HTMLInputElement).addEventListener('change', (e) => {
      this.patchB.edgeReversed = (e.target as HTMLInputElement).checked;
      this.rebuild();
    });

    (document.getElementById('pointSelect') as HTMLSelectElement).addEventListener('change', (e) => {
      this.selectedKey = (e.target as HTMLSelectElement).value;
      this.rebuildPointSpheres();
      const sel = this.selectedPoint();
      if (sel) this.syncPointInputs(sel.point);
    });
    (['cpX', 'cpY', 'cpZ'] as const).forEach((id, axis) => {
      document.getElementById(id)!.addEventListener('change', () => {
        const sel = this.selectedPoint();
        if (!sel) return;
        const val = Number((document.getElementById(id) as HTMLInputElement).value);
        if (axis === 0) sel.point.x = val;
        if (axis === 1) sel.point.y = val;
        if (axis === 2) sel.point.z = val;
        this.rebuild();
      });
    });
    (document.getElementById('dragMode') as HTMLSelectElement).addEventListener('change', (e) => {
      this.transform.setMode((e.target as HTMLSelectElement).value as 'translate' | 'rotate');
    });
    document.getElementById('resetBtn')!.addEventListener('click', () => {
      const init = createInitialPatches();
      this.patchA = init.patchA;
      this.patchB = init.patchB;
      this.selectedKey = '';
      this.syncUIControls();
      this.buildPointPicker();
      const sel = this.selectedPoint();
      if (sel) this.syncPointInputs(sel.point);
      this.rebuild();
    });
    (document.getElementById('camDist') as HTMLInputElement).addEventListener('input', (e) => {
      const d = Number((e.target as HTMLInputElement).value);
      document.getElementById('dist-val')!.textContent = d.toFixed(1);
      this.setCameraDistance(this.direct, d);
      this.setCameraDistance(this.fixed, d);
      // metrics 重新读取距离值
      const meshA = tessellate(this.patchA);
      const meshB = tessellate(this.patchB);
      const { fixedA, fixedB } = fixSeam(meshA, meshB);
      this.updateMetrics(meshA, meshB, fixedA, fixedB);
    });

    // 点击 sphere 选择控制点（控制点与 gizmo 只在左视口，右半屏忽略拾取）
    this.renderer.domElement.addEventListener('pointerdown', (e) => {
      if (this.transform.dragging) return;
      const rect = this.renderer.domElement.getBoundingClientRect();
      if (this.options.split && e.clientX - rect.left > rect.width / 2) return;
      this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      this.raycaster.setFromCamera(this.pointer, this.direct.camera);
      const hit = this.raycaster.intersectObjects(this.pointSpheres, false)[0];
      if (hit) {
        const info = this.pointSphereMap.get(hit.object as THREE.Mesh);
        if (info) {
          this.selectedKey = `${info.patch}-${info.u}-${info.v}`;
          (document.getElementById('pointSelect') as HTMLSelectElement).value = this.selectedKey;
          this.rebuildPointSpheres();
          const sel = this.selectedPoint();
          if (sel) this.syncPointInputs(sel.point);
        }
      }
    });
  }

  private setCameraDistance(view: ViewSet, dist: number) {
    const dir = view.camera.position.clone().sub(view.controls.target).normalize();
    view.camera.position.copy(view.controls.target).addScaledVector(dir, dist);
  }

  private resize() {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    this.renderer.setSize(w, h);
    if (this.options.split) {
      this.direct.camera.aspect = (w / 2) / h;
      this.fixed.camera.aspect = (w / 2) / h;
    } else {
      this.direct.camera.aspect = w / h;
    }
    this.direct.camera.updateProjectionMatrix();
    this.fixed.camera.updateProjectionMatrix();
  }

  private renderView(view: ViewSet, x: number, width: number) {
    const h = this.host.clientHeight;
    this.renderer.setViewport(x, 0, width, h);
    this.renderer.setScissor(x, 0, width, h);
    const scene = (view.group as unknown as { userScene: THREE.Scene }).userScene;
    this.renderer.render(scene, view.camera);
  }

  start() {
    const tick = () => {
      requestAnimationFrame(tick);
      this.direct.controls.update();
      this.fixed.controls.update();
      const w = this.host.clientWidth;
      if (this.options.split) {
        this.renderView(this.direct, 0, w / 2);
        this.renderView(this.fixed, w / 2, w / 2);
      } else {
        this.renderView(this.direct, 0, w);
      }
    };
    tick();
  }
}

document.body.classList.add('split');
const lab = new Lab();
lab.start();

// ?selftest=1 时执行页面内交互自测（结果写入 #selftest-out 与 document.title）
if (new URLSearchParams(location.search).get('selftest') === '1') {
  import('./selftest').then((m) => m.runSelfTest());
}
