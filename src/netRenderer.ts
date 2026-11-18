/**
 * 二维展开图渲染器（Canvas 2D）。
 * 负责：面填充与编号、不对称方向标记、铰链边/裁切边/根面标识、点击拾取、联动高亮。
 */
import * as THREE from 'three';
import type { BuiltModel } from './types';

export const FACE_COLORS = [
  '#4f8cff', '#36d399', '#ffb020', '#ff5d73',
  '#b48cff', '#22d3ee', '#fb923c', '#a3e635',
];

const HINGE_COLOR = '#ffb020';
const CUT_COLOR = '#ff5d73';
const ROOT_RING = '#b48cff';

export class NetRenderer {
  private ctx: CanvasRenderingContext2D;
  private model: BuiltModel | null = null;
  private selectedId: string | null = null;
  private hoverId: string | null = null;
  /** 屏幕变换缓存，用于拾取。 */
  private faceScreenPolys: { id: string; poly: THREE.Vector3[] }[] = [];
  private scale = 1;
  private offset = new THREE.Vector2();
  onPick: ((id: string | null) => void) | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法获取 2D 上下文');
    this.ctx = ctx;
    canvas.addEventListener('click', (e) => this.handleClick(e));
    canvas.addEventListener('mousemove', (e) => this.handleMove(e));
    canvas.addEventListener('mouseleave', () => {
      this.hoverId = null;
      this.draw();
    });
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  setModel(model: BuiltModel) {
    this.model = model;
    this.selectedId = null;
    this.draw();
  }

  setSelected(id: string | null) {
    this.selectedId = id;
    this.draw();
  }

  private edgeIsHinge(va: number, vb: number): boolean {
    return this.model!.hingeEdges.some((h) => h.key === this.edgeKey(va, vb));
  }

  private edgeKey(a: number, b: number): string {
    return a < b ? `${a}-${b}` : `${b}-${a}`;
  }

  /** 计算适配画布的统一缩放与居中偏移。 */
  private computeView() {
    const m = this.model!;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const f of m.faces) {
      for (const p of f.flatLocalPoints.map((l) => l.clone().applyMatrix4(f.flatMatrix))) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
    }
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pad = 48;
    const sx = (w - pad * 2) / Math.max(maxX - minX, 1e-6);
    const sy = (h - pad * 2) / Math.max(maxY - minY, 1e-6);
    this.scale = Math.min(sx, sy);
    // 网络 y 向上，画布 y 向下，故 y 取反
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    this.offset.set(w / 2 - cx * this.scale, h / 2 + cy * this.scale);
  }

  private toScreen(p: THREE.Vector3): THREE.Vector2 {
    return new THREE.Vector2(
      p.x * this.scale + this.offset.x,
      -p.y * this.scale + this.offset.y,
    );
  }

  private netWorldPoints(faceId: string): THREE.Vector3[] {
    const f = this.model!.faceById.get(faceId)!;
    return f.flatLocalPoints.map((l) => l.clone().applyMatrix4(f.flatMatrix));
  }

  draw() {
    if (!this.model) return;
    const ctx = this.ctx;
    this.computeView();
    ctx.clearRect(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);
    this.faceScreenPolys = [];

    // 先画边（铰链/裁切），再画面，最后画文字与标记
    for (const f of this.model.faces) {
      const world = this.netWorldPoints(f.id);
      const screen = world.map((p) => this.toScreen(p));
      this.faceScreenPolys.push({ id: f.id, poly: screen.map((s) => new THREE.Vector3(s.x, s.y, 0)) });
      this.drawFaceFill(f.id, screen);
    }
    for (const f of this.model.faces) this.drawEdges(f.id);
    for (const f of this.model.faces) this.drawMarks(f.id);
  }

  private faceColor(id: string): string {
    const idx = this.model!.def.faces.findIndex((f) => f.id === id);
    return FACE_COLORS[idx % FACE_COLORS.length];
  }

  private drawFaceFill(id: string, screen: THREE.Vector2[]) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(screen[0].x, screen[0].y);
    for (let i = 1; i < screen.length; i++) ctx.lineTo(screen[i].x, screen[i].y);
    ctx.closePath();
    const isRoot = this.model!.def.rootFaceId === id;
    const isSel = this.selectedId === id;
    const isHover = this.hoverId === id;
    ctx.fillStyle = this.faceColor(id) + (isSel ? 'dd' : isHover ? 'aa' : '88');
    ctx.fill();
    ctx.lineWidth = isSel ? 3 : 1.5;
    ctx.strokeStyle = isSel ? '#ffffff' : isRoot ? ROOT_RING : 'rgba(255,255,255,0.35)';
    ctx.stroke();
    if (isRoot) {
      ctx.save();
      ctx.strokeStyle = ROOT_RING;
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawEdges(faceId: string) {
    const ctx = this.ctx;
    const f = this.model!.faceById.get(faceId)!;
    const fdef = this.model!.def.faces.find((d) => d.id === faceId)!;
    const world = this.netWorldPoints(faceId);
    for (let i = 0; i < world.length; i++) {
      const a = this.toScreen(world[i]);
      const b = this.toScreen(world[(i + 1) % world.length]);
      const va = fdef.targetVertexIds[i];
      const vb = fdef.targetVertexIds[(i + 1) % fdef.targetVertexIds.length];
      const hinge = this.edgeIsHinge(va, vb);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = hinge ? HINGE_COLOR : CUT_COLOR;
      ctx.lineWidth = hinge ? 4 : 2.5;
      ctx.setLineDash(hinge ? [] : [7, 5]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    void f;
  }

  /**
   * 不对称方向标记：在面内画一个从“首顶点边中点”指向面心的箭头，
   * 并标注面编号。箭头方向绑定面的局部顶点顺序，折叠后仍可判断朝向是否正确。
   */
  private drawMarks(faceId: string) {
    const ctx = this.ctx;
    const world = this.netWorldPoints(faceId);
    const screen = world.map((p) => this.toScreen(p));
    const center = screen.reduce((a, b) => a.clone().add(b), new THREE.Vector2()).multiplyScalar(1 / screen.length);

    // 编号
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(faceId, center.x, center.y - 8);

    // 不对称箭头：首边中点 -> 面心，带偏心圆点增强非对称性
    const edgeMid = screen[0].clone().add(screen[1]).multiplyScalar(0.5);
    const dir = center.clone().sub(edgeMid).normalize();
    const start = edgeMid.clone().add(dir.clone().multiplyScalar(6));
    const end = center.clone().add(dir.clone().multiplyScalar(-14));
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    // 箭头头部
    const head = 8;
    const ang = Math.atan2(end.y - start.y, end.x - start.x);
    ctx.beginPath();
    ctx.moveTo(end.x, end.y);
    ctx.lineTo(end.x - head * Math.cos(ang - 0.4), end.y - head * Math.sin(ang - 0.4));
    ctx.moveTo(end.x, end.y);
    ctx.lineTo(end.x - head * Math.cos(ang + 0.4), end.y - head * Math.sin(ang + 0.4));
    ctx.stroke();
    // 偏心点：靠近首顶点一侧
    const dotPos = edgeMid.clone().lerp(center, 0.3);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(dotPos.x, dotPos.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  private hitTest(x: number, y: number): string | null {
    // 从顶层（后画）往前找
    for (let i = this.faceScreenPolys.length - 1; i >= 0; i--) {
      const { id, poly } = this.faceScreenPolys[i];
      if (this.pointInPoly(x, y, poly)) return id;
    }
    return null;
  }

  private pointInPoly(x: number, y: number, poly: THREE.Vector3[]): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      const intersect = a.y > y !== b.y > y &&
        x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  private eventPos(e: MouseEvent): THREE.Vector2 {
    const r = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(e.clientX - r.left, e.clientY - r.top);
  }

  private handleClick(e: MouseEvent) {
    const p = this.eventPos(e);
    this.onPick?.(this.hitTest(p.x, p.y));
  }

  private handleMove(e: MouseEvent) {
    const p = this.eventPos(e);
    const id = this.hitTest(p.x, p.y);
    if (id !== this.hoverId) {
      this.hoverId = id;
      this.canvas.style.cursor = id ? 'pointer' : 'default';
      this.draw();
    }
  }
}
