/**
 * Canvas 渲染器。
 * 裁剪用 canvas 原生 clip(path, fillRule), 几何来源与命中测试是同一个 VectorPath,
 * 遮罩按顺序嵌套 clip —— 天然实现「父层裁掉的区域子层无法重新打开」。
 */
import type { Mat3 } from '../core/geometry/matrix';
import { apply, multiply, setCanvasTransform } from '../core/geometry/matrix';
import { pathBounds, toPath2D, toContours } from '../core/geometry/path';
import type { FillRule, VectorPath } from '../core/geometry/path';
import type { HitResult } from '../core/hitTest';
import type { LayerKey, MaskKey, SceneModel, ViewMode } from '../core/scene/types';

export interface RenderState {
  scene: SceneModel;
  /** 场景根坐标 -> CSS 像素 */
  view: Mat3;
  mode: ViewMode;
  active: LayerKey;
  hit: HitResult | null;
  hoverHandle: string | null;
  showChecker: boolean;
  /** 导出时为 true: 只输出裁剪后的图形本身, 不带遮罩着色/轮廓/手柄/标记 */
  exportOnly?: boolean;
}

const HANDLE_RADIUS = 9;
const ROT_HANDLE_DIST = 58;

function scaleUniform(m: Mat3): number {
  return Math.hypot(m.a, m.b);
}

export class Renderer {
  readonly ctx: CanvasRenderingContext2D;
  dpr = 1;

  constructor(readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建 2D canvas 上下文');
    this.ctx = ctx;
  }

  resize(cssWidth: number, cssHeight: number): void {
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(cssWidth * this.dpr);
    this.canvas.height = Math.round(cssHeight * this.dpr);
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
  }

  private deviceView(view: Mat3): Mat3 {
    const s = this.dpr;
    return { a: view.a * s, b: view.b * s, c: view.c * s, d: view.d * s, e: view.e * s, f: view.f * s };
  }

  render(state: RenderState): void {
    const { ctx, canvas } = this;
    const dv = this.deviceView(state.view);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (state.showChecker) this.drawChecker();

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    if (state.mode === 'outline') {
      this.renderOutline(state, dv);
    } else {
      this.renderMasked(state, dv);
    }
    if (!state.exportOnly) {
      this.renderMaskOverlays(state, dv);
      this.renderHandles(state);
      this.renderHitMarker(state, dv);
    }
  }

  /* ------------------------------ 背景棋盘 ------------------------------ */

  private drawChecker(): void {
    const { ctx, canvas } = this;
    const tile = 12 * this.dpr;
    for (let y = 0; y < canvas.height; y += tile) {
      for (let x = 0; x < canvas.width; x += tile) {
        const odd = ((x / tile) + (y / tile)) % 2 === 0;
        ctx.fillStyle = odd ? 'rgba(125,135,155,0.16)' : 'rgba(125,135,155,0.07)';
        ctx.fillRect(x, y, tile, tile);
      }
    }
  }

  /* --------------------------- 轮廓视图(无裁剪) --------------------------- */

  private renderOutline(state: RenderState, dv: Mat3): void {
    const { ctx } = this;
    const { scene } = state;
    setCanvasTransform(ctx, multiply(dv, scene.contentMatrix));
    for (const shape of [...scene.shapes].sort((a, b) => a.z - b.z)) {
      const p = toPath2D(shape.path);
      ctx.save();
      ctx.globalAlpha = 0.14;
      ctx.fillStyle = shape.color;
      ctx.fill(p, shape.rule);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = shape.color;
      ctx.lineWidth = 1.5 / scaleUniform(multiply(dv, scene.contentMatrix));
      ctx.stroke(p);
      ctx.restore();
    }
  }

  /* --------------------------- 遮罩裁剪后的正式视图 --------------------------- */

  private maskLocalToRoot(scene: SceneModel, key: MaskKey) {
    return key === 'A'
      ? scene.masks.A.matrix
      : multiply(scene.masks.A.matrix, scene.masks.B.matrix);
  }

  private activeMaskKeys(mode: ViewMode): MaskKey[] {
    if (mode === 'maskA') return ['A'];
    if (mode === 'maskB') return ['B'];
    if (mode === 'final') return ['A', 'B'];
    return [];
  }

  private renderMasked(state: RenderState, dv: Mat3): void {
    const { ctx } = this;
    const { scene, mode } = state;
    const keys = this.activeMaskKeys(mode);

    ctx.save();
    // 遮罩区域淡色底, 便于看清板与孔的范围(导出时省略, 保证 PNG 只有图形像素)
    if (!state.exportOnly) {
      for (const key of keys) {
        const mask = scene.masks[key];
        const m = multiply(dv, this.maskLocalToRoot(scene, key));
        setCanvasTransform(ctx, m);
        ctx.save();
        ctx.globalAlpha = 0.09;
        ctx.fillStyle = mask.color;
        ctx.fill(toPath2D(mask.path), mask.rule);
        ctx.restore();
      }
    }

    // 嵌套 clip: 后一层在前一层的可见区域内再次裁剪, 交集关系
    for (const key of keys) {
      const mask = scene.masks[key];
      setCanvasTransform(ctx, multiply(dv, this.maskLocalToRoot(scene, key)));
      ctx.save();
      ctx.clip(toPath2D(mask.path), mask.rule);
    }

    setCanvasTransform(ctx, multiply(dv, scene.contentMatrix));
    for (const shape of [...scene.shapes].sort((a, b) => a.z - b.z)) {
      ctx.save();
      ctx.fillStyle = shape.color;
      ctx.fill(toPath2D(shape.path), shape.rule);
      ctx.restore();
    }
    for (let i = 0; i < keys.length; i++) ctx.restore();
    ctx.restore();
  }

  /* ------------------------------ 遮罩轮廓叠加 ------------------------------ */

  private renderMaskOverlays(state: RenderState, dv: Mat3): void {
    const { ctx } = this;
    const { scene, mode } = state;
    const keys: MaskKey[] = mode === 'outline' ? ['A', 'B'] : this.activeMaskKeys(mode);
    for (const key of keys) {
      const mask = scene.masks[key];
      const m = multiply(dv, this.maskLocalToRoot(scene, key));
      setCanvasTransform(ctx, m);
      const p = toPath2D(mask.path);
      ctx.save();
      ctx.lineWidth = 1.4 / scaleUniform(m);
      ctx.setLineDash([7 / scaleUniform(m), 5 / scaleUniform(m)]);
      ctx.strokeStyle = mask.color;
      ctx.stroke(p);
      ctx.setLineDash([]);
      ctx.restore();

      const labelPos = this.maskLabelAnchor(scene, key);
      this.drawLabel(apply(dv, labelPos), mask.label, mask.color);
    }
  }

  private maskLabelAnchor(scene: SceneModel, key: MaskKey) {
    const mask = scene.masks[key];
    const b = pathBounds(mask.path);
    const local = { x: b.minX, y: b.minY - 10 };
    const m = this.maskLocalToRoot(scene, key);
    return apply(m, local);
  }

  private drawLabel(screen: { x: number; y: number }, text: string, color: string): void {
    const { ctx } = this;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
    const w = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(15,23,42,0.78)';
    ctx.beginPath();
    ctx.roundRect(screen.x - 4, screen.y - 15, w + 8, 19, 5);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.fillText(text, screen.x, screen.y - 2);
    ctx.restore();
  }

  /* -------------------------------- 变换手柄 -------------------------------- */

  layerLocalToRoot(scene: SceneModel, layer: LayerKey) {
    if (layer === 'content') return scene.contentMatrix;
    if (layer === 'A') return scene.masks.A.matrix;
    return multiply(scene.masks.A.matrix, scene.masks.B.matrix);
  }

  /** 返回各手柄在 CSS 像素下的位置与命中半径, 交互层直接复用。 */
  handles(state: RenderState): { id: string; layer: LayerKey; kind: 'pivot' | 'rotate'; screen: { x: number; y: number }; radius: number }[] {
    const { scene, view } = state;
    const layers: LayerKey[] = ['content', 'A', 'B'];
    const out: { id: string; layer: LayerKey; kind: 'pivot' | 'rotate'; screen: { x: number; y: number }; radius: number }[] = [];
    for (const layer of layers) {
      const m = multiply(view, this.layerLocalToRoot(scene, layer));
      const pivot = apply(m, { x: 0, y: 0 });
      out.push({ id: `${layer}:pivot`, layer, kind: 'pivot', screen: pivot, radius: HANDLE_RADIUS });
      if (layer === state.active) {
        const rot = apply(m, { x: 0, y: -ROT_HANDLE_DIST });
        out.push({ id: `${layer}:rotate`, layer, kind: 'rotate', screen: rot, radius: HANDLE_RADIUS });
      }
    }
    return out;
  }

  private renderHandles(state: RenderState): void {
    const { ctx } = this;
    const handles = this.handles(state);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (const h of handles) {
      const active = h.layer === state.active;
      const hovered = state.hoverHandle === h.id;
      const color =
        h.layer === 'content' ? '#0f766e' : h.layer === 'A' ? '#0369a1' : '#c2410c';
      if (h.kind === 'rotate') {
        const pivot = handles.find((x) => x.layer === h.layer && x.kind === 'pivot')!;
        ctx.strokeStyle = 'rgba(15,23,42,0.45)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pivot.screen.x, pivot.screen.y);
        ctx.lineTo(h.screen.x, h.screen.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(h.screen.x, h.screen.y, HANDLE_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = hovered ? color : '#ffffff';
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.arc(h.screen.x, h.screen.y, 3.5, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.rect(h.screen.x - HANDLE_RADIUS / 1.4, h.screen.y - HANDLE_RADIUS / 1.4, (HANDLE_RADIUS / 1.4) * 2, (HANDLE_RADIUS / 1.4) * 2);
        ctx.fillStyle = hovered || active ? color : '#ffffff';
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = hovered || active ? '#ffffff' : color;
        ctx.font = 'bold 9px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(h.layer === 'content' ? 'C' : h.layer, h.screen.x, h.screen.y + 0.5);
      }
    }
    ctx.restore();
  }

  /* -------------------------------- 点击标记 -------------------------------- */

  private renderHitMarker(state: RenderState, dv: Mat3): void {
    const hit = state.hit;
    if (!hit) return;
    const { ctx } = this;
    const p = apply(dv, hit.pointRoot);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const color = hit.visible ? '#16a34a' : hit.shape ? '#d97706' : '#64748b';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p.x - 11, p.y);
    ctx.lineTo(p.x + 11, p.y);
    ctx.moveTo(p.x, p.y - 11);
    ctx.lineTo(p.x, p.y + 11);
    ctx.stroke();
    ctx.restore();
  }
}

/** 场景整体包围盒(根坐标), 导出时用于 fit。 */
export function sceneBounds(scene: SceneModel) {
  const boxes: { minX: number; minY: number; maxX: number; maxY: number }[] = [];
  const collect = (path: VectorPath, m: Mat3) => {
    const b = pathBounds(path);
    const corners = [
      apply(m, { x: b.minX, y: b.minY }),
      apply(m, { x: b.maxX, y: b.minY }),
      apply(m, { x: b.maxX, y: b.maxY }),
      apply(m, { x: b.minX, y: b.maxY }),
    ];
    boxes.push({
      minX: Math.min(...corners.map((p) => p.x)),
      minY: Math.min(...corners.map((p) => p.y)),
      maxX: Math.max(...corners.map((p) => p.x)),
      maxY: Math.max(...corners.map((p) => p.y)),
    });
  };
  for (const s of scene.shapes) collect(s.path, scene.contentMatrix);
  collect(scene.masks.A.path, scene.masks.A.matrix);
  collect(scene.masks.B.path, multiply(scene.masks.A.matrix, scene.masks.B.matrix));
  return {
    minX: Math.min(...boxes.map((b) => b.minX)),
    minY: Math.min(...boxes.map((b) => b.minY)),
    maxX: Math.max(...boxes.map((b) => b.maxX)),
    maxY: Math.max(...boxes.map((b) => b.maxY)),
  };
}

/** 供导出模块复用的纯几何轮廓信息。 */
export function contourCount(path: VectorPath): number {
  return toContours(path).length;
}

export function ruleName(rule: FillRule): string {
  return rule === 'evenodd' ? '奇偶 evenodd' : '方向计数 nonzero';
}
