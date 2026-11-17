/**
 * SceneView —— three.js 渲染与实例表现层
 *
 * 性能策略：5000 个外观相同的物件使用单个 InstancedMesh，一次 draw call。
 * 选中态通过 instanceColor 逐实例着色；隐藏通过缩放 0 实现（实例不销毁、
 * 下标不变量保持）；移动通过 instanceMatrix 插值动画实现。
 */

import {
  Scene,
  PerspectiveCamera,
  WebGLRenderer,
  InstancedMesh,
  BoxGeometry,
  MeshStandardMaterial,
  Matrix4,
  Color,
  GridHelper,
  AmbientLight,
  DirectionalLight,
  Quaternion,
  Vector3,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const COLOR_NORMAL = new Color(0x4f7cff);
const COLOR_SELECTED = new Color(0xffb020);
const COLOR_HOVER = new Color(0x9ad0ff);
const COLOR_HIDDEN = new Color(0x2a2f3a);

const IDENTITY_Q = new Quaternion();
const ONE = new Vector3(1, 1, 1);
const ZERO = new Vector3(0.0001, 0.0001, 0.0001);

export class SceneView {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('./FieldModel').FieldModel} model
   */
  constructor(canvas, model) {
    this.canvas = canvas;
    this.model = model;

    this.scene = new Scene();
    this.scene.background = new Color(0x10131a);

    this.camera = new PerspectiveCamera(55, 1, 0.1, 2000);
    this.homePosition = new Vector3(70, 85, 95);
    this.homeTarget = new Vector3(0, 0, 0);
    this.camera.position.copy(this.homePosition);

    this.renderer = new WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.mouseButtons = {
      LEFT: null, // 左键留给点选/框选，OrbitControls 不接管
      MIDDLE: OrbitControls.DOLLY,
      RIGHT: OrbitControls.ROTATE,
    };

    // 灯光
    this.scene.add(new AmbientLight(0xffffff, 0.75));
    const dir = new DirectionalLight(0xffffff, 1.4);
    dir.position.set(60, 120, 40);
    this.scene.add(dir);

    // 地面网格
    const grid = new GridHelper(220, 44, 0x3a4356, 0x222836);
    grid.position.y = -0.55;
    this.scene.add(grid);

    // 单一 InstancedMesh 承载全部物件
    this.geometry = new BoxGeometry(0.72, 0.72, 0.72);
    this.material = new MeshStandardMaterial({
      metalness: 0.15,
      roughness: 0.55,
    });
    this.mesh = new InstancedMesh(this.geometry, this.material, model.count);
    this.mesh.instanceMatrix.setUsage(0x88e8); // DynamicDrawUsage
    // 实例分布范围远超包围球估算，关闭视锥剔除避免整体被误裁
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);

    /** 逐实例当前颜色，便于 hover 后恢复 */
    this._baseColors = new Array(model.count).fill(null).map(() => COLOR_NORMAL.clone());
    this._hoverId = null;

    /** 移动动画：id -> {from:Matrix4, to:Matrix4, start, duration} */
    this._anims = new Map();

    this._compose = new Matrix4();
    this._from = new Matrix4();
    this._to = new Matrix4();

    this._initInstances();
    this.resize();
  }

  /** 按 model 初始位置写入全部实例矩阵与颜色 */
  _initInstances() {
    const { model, mesh } = this;
    for (let id = 0; id < model.count; id++) {
      const [x, y, z] = model.positions[id];
      this._compose.compose(new Vector3(x, y, z), IDENTITY_Q, ONE);
      mesh.setMatrixAt(id, this._compose);
      mesh.setColorAt(id, COLOR_NORMAL);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
  }

  /** 窗口 / 容器尺寸变化：投影基准同步更新，框选坐标保持准确 */
  resize() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.width = w;
    this.height = h;
  }

  resetView() {
    this.camera.position.copy(this.homePosition);
    this.controls.target.copy(this.homeTarget);
    this.controls.update();
  }

  /**
   * 刷新一组实例的“基础颜色”（选中/普通/隐藏）。
   * hover 高亮是临时覆盖，单独由 setHover 管理。
   */
  refreshColors(selectionStore) {
    const { model, mesh } = this;
    for (let id = 0; id < model.count; id++) {
      let color;
      if (model.isHidden(id)) color = COLOR_HIDDEN;
      else if (selectionStore.has(id)) color = COLOR_SELECTED;
      else color = COLOR_NORMAL;
      this._baseColors[id].copy(color);
      if (id !== this._hoverId) mesh.setColorAt(id, color);
    }
    mesh.instanceColor.needsUpdate = true;
  }

  /** 仅刷新指定 id 的颜色（选择变化时的增量路径，避免每帧全量遍历） */
  refreshIds(ids, selectionStore) {
    const { model, mesh } = this;
    for (const id of ids) {
      let color;
      if (model.isHidden(id)) color = COLOR_HIDDEN;
      else if (selectionStore.has(id)) color = COLOR_SELECTED;
      else color = COLOR_NORMAL;
      this._baseColors[id].copy(color);
      if (id !== this._hoverId) mesh.setColorAt(id, color);
    }
    mesh.instanceColor.needsUpdate = true;
  }

  /** 悬停高亮，传 null 取消 */
  setHover(id) {
    if (id === this._hoverId) return;
    if (this._hoverId != null) {
      this.mesh.setColorAt(this._hoverId, this._baseColors[this._hoverId]);
    }
    this._hoverId = id;
    if (id != null && !this.model.isHidden(id)) {
      this.mesh.setColorAt(id, COLOR_HOVER);
    }
    this.mesh.instanceColor.needsUpdate = true;
  }

  /** 隐藏一批实例：缩放置 0，矩阵下标与 id 不变 */
  applyHidden(ids) {
    for (const id of ids) {
      this.mesh.getMatrixAt(id, this._compose);
      const pos = new Vector3().setFromMatrixPosition(this._compose);
      this._compose.compose(pos, IDENTITY_Q, ZERO);
      this.mesh.setMatrixAt(id, this._compose);
      this._anims.delete(id);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** 恢复一批实例：按 model 中的当前坐标重建单位缩放矩阵（移动过的位置也保留） */
  applyRestored(ids, selectionStore) {
    for (const id of ids) {
      const [x, y, z] = this.model.getPosition(id);
      this._compose.compose(new Vector3(x, y, z), IDENTITY_Q, ONE);
      this.mesh.setMatrixAt(id, this._compose);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.refreshIds(ids, selectionStore);
  }

  /**
   * 启动移动动画：从当前矩阵插值到 model 中的新坐标。
   * 身份（id/下标）不变，仅位置变化。
   */
  move(ids, durationMs = 450) {
    const now = performance.now();
    for (const id of ids) {
      if (this.model.isHidden(id)) continue;
      this.mesh.getMatrixAt(id, this._from);
      const [x, y, z] = this.model.getPosition(id);
      this._to.compose(new Vector3(x, y, z), IDENTITY_Q, ONE);
      this._anims.set(id, {
        from: this._from.clone(),
        to: this._to.clone(),
        start: now,
        duration: durationMs,
      });
    }
  }

  /** 每帧推进移动动画并渲染 */
  render() {
    if (this._anims.size > 0) {
      const now = performance.now();
      const done = [];
      for (const [id, anim] of this._anims) {
        const t = Math.min(1, (now - anim.start) / anim.duration);
        const ease = t * t * (3 - 2 * t); // smoothstep
        this._compose.copy(anim.from).lerp(anim.to, ease);
        this.mesh.setMatrixAt(id, this._compose);
        if (t >= 1) done.push(id);
      }
      for (const id of done) this._anims.delete(id);
      this.mesh.instanceMatrix.needsUpdate = true;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
