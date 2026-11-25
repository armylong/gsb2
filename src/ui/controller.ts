/**
 * 交互控制器。
 * 所有指针位置都先换算回场景根坐标再参与命中/变换, 与渲染器使用同一条矩阵链,
 * 因此切换视图模式不会改变「指针 → 内容坐标」的对应关系。
 *
 * 嵌套变换要点: 每层只存「本层局部 → 直接父空间」的矩阵。
 * 拖动 B 时, 先把根空间位移换算到 A 局部再合成; 绕 B 枢轴旋转的枢轴点同样取 A 局部坐标。
 */
import { Renderer, type RenderState } from '../render/renderer';
import { hitTest, type HitResult } from '../core/hitTest';
import {
  apply,
  identity,
  invert,
  multiply,
  rotatedBy,
  translatedBy,
  translation,
} from '../core/geometry/matrix';
import type { Mat3 } from '../core/geometry/matrix';
import type { Vec2 } from '../core/geometry/path';
import type { LayerKey, SceneModel, ViewMode } from '../core/scene/types';

interface DragState {
  kind: 'translate' | 'rotate';
  layer: LayerKey;
  lastRoot: Vec2;
  startAngle: number;
  moved: boolean;
}

export interface AppCallbacks {
  onHitChange: (hit: HitResult | null) => void;
  onSceneChange: () => void;
}

export class AppController {
  view: Mat3 = identity();
  mode: ViewMode = 'final';
  active: LayerKey = 'content';
  hit: HitResult | null = null;
  hoverHandle: string | null = null;
  showChecker = true;

  private drag: DragState | null = null;
  private cssWidth = 0;
  private cssHeight = 0;

  constructor(
    readonly scene: SceneModel,
    readonly renderer: Renderer,
    private cb: AppCallbacks,
  ) {}

  setSize(cssWidth: number, cssHeight: number): void {
    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;
    this.renderer.resize(cssWidth, cssHeight);
    this.draw();
  }

  fitView(): void {
    const s = Math.min(this.cssWidth / 640, this.cssHeight / 520);
    this.view = { a: s, d: s, b: 0, c: 0, e: this.cssWidth / 2, f: this.cssHeight / 2 };
    this.draw();
  }

  setMode(mode: ViewMode): void {
    this.mode = mode;
    this.draw();
  }

  setActive(layer: LayerKey): void {
    this.active = layer;
    this.draw();
  }

  resetLayer(layer: LayerKey): void {
    if (layer === 'content') this.scene.contentMatrix = identity();
    else if (layer === 'A') this.scene.masks.A.matrix = identity();
    else this.scene.masks.B.matrix = translation(130, -70);
    this.cb.onSceneChange();
    this.draw();
  }

  /* ------------------------------ 坐标换算 ------------------------------ */

  private toRoot(cssPoint: Vec2): Vec2 {
    return apply(invert(this.view), cssPoint);
  }

  /** HUD 用: 指针在各空间的实时坐标。 */
  pointerCoordinates(cssPoint: Vec2): { root: Vec2; content: Vec2; a: Vec2; b: Vec2 } {
    const root = this.toRoot(cssPoint);
    const bToRoot = multiply(this.scene.masks.A.matrix, this.scene.masks.B.matrix);
    return {
      root,
      content: apply(invert(this.scene.contentMatrix), root),
      a: apply(invert(this.scene.masks.A.matrix), root),
      b: apply(invert(bToRoot), root),
    };
  }

  private layerMatrix(layer: LayerKey): Mat3 {
    if (layer === 'content') return this.scene.contentMatrix;
    return this.scene.masks[layer].matrix;
  }

  private setLayerMatrix(layer: LayerKey, m: Mat3): void {
    if (layer === 'content') this.scene.contentMatrix = m;
    else this.scene.masks[layer].matrix = m;
  }

  /** 该层的「局部 → 直接父空间」之外, 父空间 → 根的矩阵。 */
  private parentToRoot(layer: LayerKey): Mat3 {
    if (layer === 'B') return this.scene.masks.A.matrix;
    return identity();
  }

  /** 该层枢轴(局部原点)在其直接父空间中的坐标。 */
  private pivotInParent(layer: LayerKey): Vec2 {
    return apply(this.layerMatrix(layer), { x: 0, y: 0 });
  }

  renderState(): RenderState {
    return {
      scene: this.scene,
      view: this.view,
      mode: this.mode,
      active: this.active,
      hit: this.hit,
      hoverHandle: this.hoverHandle,
      showChecker: this.showChecker,
    };
  }

  draw(): void {
    this.renderer.render(this.renderState());
  }

  handleAt(cssPoint: Vec2): string | null {
    for (const h of this.renderer.handles(this.renderState())) {
      if (Math.hypot(h.screen.x - cssPoint.x, h.screen.y - cssPoint.y) <= h.radius + 2) return h.id;
    }
    return null;
  }

  /* ------------------------------ 指针事件 ------------------------------ */

  onPointerDown(cssPoint: Vec2): void {
    const handleId = this.handleAt(cssPoint);
    if (handleId) {
      const [layer, kind] = handleId.split(':') as [LayerKey, 'pivot' | 'rotate'];
      this.active = layer;
      this.cb.onSceneChange();
      const root = this.toRoot(cssPoint);
      if (kind === 'pivot') {
        this.drag = { kind: 'translate', layer, lastRoot: root, startAngle: 0, moved: false };
      } else {
        const pivotScreen = apply(multiply(this.view, this.parentToRoot(layer)), this.pivotInParent(layer));
        this.drag = {
          kind: 'rotate',
          layer,
          lastRoot: root,
          startAngle: Math.atan2(cssPoint.y - pivotScreen.y, cssPoint.x - pivotScreen.x),
          moved: false,
        };
      }
      this.draw();
      return;
    }
    // 非手柄: 记录点击命中, 同时允许拖动当前活动层(产生位移才算拖)
    const root = this.toRoot(cssPoint);
    this.hit = hitTest(this.scene, root);
    this.cb.onHitChange(this.hit);
    this.drag = { kind: 'translate', layer: this.active, lastRoot: root, startAngle: 0, moved: false };
    this.draw();
  }

  onPointerMove(cssPoint: Vec2): boolean {
    const root = this.toRoot(cssPoint);
    if (this.drag) {
      const d = this.drag;
      if (d.kind === 'translate') {
        // 根空间位移 -> 该层父空间位移向量
        const p2r = this.parentToRoot(d.layer);
        const deltaRoot = { x: root.x - d.lastRoot.x, y: root.y - d.lastRoot.y };
        const deltaParent = {
          x: p2r.a * deltaRoot.x + p2r.c * deltaRoot.y,
          y: p2r.b * deltaRoot.x + p2r.d * deltaRoot.y,
        };
        this.setLayerMatrix(d.layer, translatedBy(this.layerMatrix(d.layer), deltaParent.x, deltaParent.y));
        d.lastRoot = root;
        d.moved = true;
      } else {
        const pivotScreen = apply(multiply(this.view, this.parentToRoot(d.layer)), this.pivotInParent(d.layer));
        const angle = Math.atan2(cssPoint.y - pivotScreen.y, cssPoint.x - pivotScreen.x);
        const delta = angle - d.startAngle;
        d.startAngle = angle;
        // 枢轴在父空间不动, 旋转在父空间合成
        this.setLayerMatrix(
          d.layer,
          rotatedBy(this.layerMatrix(d.layer), this.pivotInParent(d.layer), delta),
        );
        d.moved = true;
      }
      this.cb.onSceneChange();
      this.draw();
      return true;
    }
    const handleId = this.handleAt(cssPoint);
    if (handleId !== this.hoverHandle) {
      this.hoverHandle = handleId;
      this.draw();
    }
    return false;
  }

  onPointerUp(): boolean {
    const moved = this.drag?.moved ?? false;
    this.drag = null;
    return moved;
  }

  onWheel(cssPoint: Vec2, deltaY: number): void {
    const factor = Math.exp(-deltaY * 0.0012);
    const before = this.toRoot(cssPoint);
    const newScale = Math.min(8, Math.max(0.2, this.view.a * factor));
    const real = newScale / this.view.a;
    this.view = { ...this.view, a: this.view.a * real, d: this.view.d * real };
    // 保持指针下的根坐标不动
    const after = this.toRoot(cssPoint);
    this.view.e += (after.x - before.x) * this.view.a;
    this.view.f += (after.y - before.y) * this.view.d;
    this.draw();
  }

  nudge(dx: number, dy: number, rotate: boolean): void {
    if (rotate) {
      this.setLayerMatrix(
        this.active,
        rotatedBy(this.layerMatrix(this.active), this.pivotInParent(this.active), (dx * Math.PI) / 180),
      );
    } else {
      this.setLayerMatrix(this.active, translatedBy(this.layerMatrix(this.active), dx, dy));
    }
    this.cb.onSceneChange();
    this.draw();
  }
}
