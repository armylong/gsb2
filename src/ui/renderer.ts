/**
 * Canvas 渲染器: 房间、导航网格单元与多边形连接(门户)、
 * 障碍/挡门、起终点、经过区域、路线与圆形角色、状态提示。
 */
import { Vec2 } from '../core/geometry';
import { Simulation } from '../core/simulation';
import { DoorDef } from '../core/layouts';

export interface RenderOptions {
  showCells: boolean;
  showPortals: boolean;
  showInflat: boolean;
}

const COLORS = {
  bg: '#0f1420',
  room: '#161d2e',
  roomBorder: '#3b4a6b',
  cell: 'rgba(64, 120, 200, 0.10)',
  cellStroke: 'rgba(96, 165, 250, 0.35)',
  traversedCell: 'rgba(74, 222, 128, 0.18)',
  portal: 'rgba(250, 204, 21, 0.85)',
  inflat: 'rgba(248, 113, 113, 0.10)',
  inflatStroke: 'rgba(248, 113, 113, 0.35)',
  obstacle: '#334155',
  obstacleStroke: '#64748b',
  obstacleDrag: '#475569',
  doorOpen: 'rgba(34, 197, 94, 0.25)',
  doorOpenStroke: 'rgba(34, 197, 94, 0.7)',
  doorClosed: '#7f1d1d',
  doorClosedStroke: '#ef4444',
  start: '#38bdf8',
  goal: '#f472b6',
  route: '#facc15',
  routeGlow: 'rgba(250, 204, 21, 0.25)',
  character: '#e2e8f0',
  characterEdge: '#f8fafc',
  invalid: '#ef4444',
  text: '#cbd5e1',
};

export class Renderer {
  readonly ctx: CanvasRenderingContext2D;
  /** 场景单位 -> 像素的缩放 */
  scale = 20;
  /** 场景原点在画布上的像素偏移 */
  offsetX = 0;
  offsetY = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法获取 2D canvas 上下文');
    this.ctx = ctx;
  }

  resize(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.floor(rect.width * dpr);
    this.canvas.height = Math.floor(rect.height * dpr);
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** 根据房间宽高与画布尺寸计算缩放和居中偏移 */
  fit(roomW: number, roomH: number): void {
    const cssW = this.canvas.width / (window.devicePixelRatio || 1);
    const cssH = this.canvas.height / (window.devicePixelRatio || 1);
    const padding = 24;
    this.scale = Math.min((cssW - padding * 2) / roomW, (cssH - padding * 2) / roomH);
    this.offsetX = (cssW - roomW * this.scale) / 2;
    this.offsetY = (cssH - roomH * this.scale) / 2;
  }

  toScene(pixelX: number, pixelY: number): Vec2 {
    return {
      x: (pixelX - this.offsetX) / this.scale,
      y: (pixelY - this.offsetY) / this.scale,
    };
  }

  private px(x: number): number {
    return this.offsetX + x * this.scale;
  }
  private py(y: number): number {
    return this.offsetY + y * this.scale;
  }

  render(sim: Simulation, options: RenderOptions, dragIndex: number | null): void {
    const { ctx } = this;
    const cssW = this.canvas.width / (window.devicePixelRatio || 1);
    const cssH = this.canvas.height / (window.devicePixelRatio || 1);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, cssW, cssH);

    this.fit(sim.width, sim.height);

    // 房间底
    ctx.fillStyle = COLORS.room;
    ctx.fillRect(this.px(0), this.py(0), sim.width * this.scale, sim.height * this.scale);
    ctx.strokeStyle = COLORS.roomBorder;
    ctx.lineWidth = 2;
    ctx.strokeRect(this.px(0), this.py(0), sim.width * this.scale, sim.height * this.scale);

    // 导航网格单元 + 经过区域高亮
    const traversed = new Set(sim.pathResult?.cellIds ?? []);
    if (options.showCells) {
      for (const cell of sim.navMesh.cells) {
        const isTraversed = traversed.has(cell.id);
        ctx.fillStyle = isTraversed ? COLORS.traversedCell : COLORS.cell;
        ctx.fillRect(
          this.px(cell.x0),
          this.py(cell.y0),
          (cell.x1 - cell.x0) * this.scale,
          (cell.y1 - cell.y0) * this.scale,
        );
        ctx.strokeStyle = COLORS.cellStroke;
        ctx.lineWidth = 1;
        ctx.strokeRect(
          this.px(cell.x0),
          this.py(cell.y0),
          (cell.x1 - cell.x0) * this.scale,
          (cell.y1 - cell.y0) * this.scale,
        );
      }
    }

    // 膨胀矩形(角色体积的可视化)
    if (options.showInflat) {
      for (const r of sim.navMesh.inflatedObstacles) {
        ctx.fillStyle = COLORS.inflat;
        ctx.fillRect(this.px(r.x), this.py(r.y), r.w * this.scale, r.h * this.scale);
        ctx.strokeStyle = COLORS.inflatStroke;
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;
        ctx.strokeRect(this.px(r.x), this.py(r.y), r.w * this.scale, r.h * this.scale);
        ctx.setLineDash([]);
      }
    }

    // 多边形连接(门户)
    if (options.showPortals) {
      ctx.strokeStyle = COLORS.portal;
      ctx.lineWidth = 2.5;
      for (const p of sim.navMesh.allPortals()) {
        ctx.beginPath();
        ctx.moveTo(this.px(p.a.x), this.py(p.a.y));
        ctx.lineTo(this.px(p.b.x), this.py(p.b.y));
        ctx.stroke();
      }
    }

    // 静态障碍
    sim.obstacleList.forEach((o, i) => {
      ctx.fillStyle = i === dragIndex ? COLORS.obstacleDrag : COLORS.obstacle;
      ctx.fillRect(this.px(o.x), this.py(o.y), o.w * this.scale, o.h * this.scale);
      ctx.strokeStyle = COLORS.obstacleStroke;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(this.px(o.x), this.py(o.y), o.w * this.scale, o.h * this.scale);
    });

    // 挡门: 打开画绿色虚线轮廓, 关闭画红色实心
    for (const d of sim.doorList) {
      const open = sim.isDoorOpen(d.doorId);
      ctx.fillStyle = open ? COLORS.doorOpen : COLORS.doorClosed;
      ctx.fillRect(this.px(d.x), this.py(d.y), d.w * this.scale, d.h * this.scale);
      ctx.strokeStyle = open ? COLORS.doorOpenStroke : COLORS.doorClosedStroke;
      ctx.lineWidth = 1.5;
      ctx.setLineDash(open ? [6, 4] : []);
      ctx.strokeRect(this.px(d.x), this.py(d.y), d.w * this.scale, d.h * this.scale);
      ctx.setLineDash([]);
      this.renderDoorLabel(d, open);
    }

    // 路线(发光底线 + 主线)
    if (sim.route.length >= 2) {
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = COLORS.routeGlow;
      ctx.lineWidth = 8;
      this.traceRoute(sim.route);
      ctx.stroke();
      ctx.strokeStyle = COLORS.route;
      ctx.lineWidth = 3;
      this.traceRoute(sim.route);
      ctx.stroke();
      // 路线拐点
      ctx.fillStyle = COLORS.route;
      for (let i = 1; i < sim.route.length - 1; i++) {
        const p = sim.route[i];
        ctx.beginPath();
        ctx.arc(this.px(p.x), this.py(p.y), 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 起点 / 终点(非法时染红)
    const startIllegal = sim.status === 'start-invalid';
    const goalIllegal = sim.status === 'goal-invalid';
    this.renderMarker(sim.start, COLORS.start, startIllegal ? COLORS.invalid : COLORS.start, 'S', startIllegal);
    this.renderMarker(sim.goal, COLORS.goal, goalIllegal ? COLORS.invalid : COLORS.goal, 'G', goalIllegal);

    // 角色(带半径圆, 体现体积)
    const trapped = sim.status === 'trapped';
    const c = sim.position;
    ctx.beginPath();
    ctx.arc(this.px(c.x), this.py(c.y), sim.radius * this.scale, 0, Math.PI * 2);
    ctx.fillStyle = trapped ? 'rgba(239,68,68,0.35)' : 'rgba(226,232,240,0.9)';
    ctx.fill();
    ctx.strokeStyle = trapped ? COLORS.invalid : COLORS.characterEdge;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(this.px(c.x), this.py(c.y), 2.5, 0, Math.PI * 2);
    ctx.fillStyle = trapped ? COLORS.invalid : '#0f172a';
    ctx.fill();

    // 坐标尺标
    this.renderScaleTag();
  }
  private traceRoute(route: Vec2[]): void {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(this.px(route[0].x), this.py(route[0].y));
    for (let i = 1; i < route.length; i++) {
      ctx.lineTo(this.px(route[i].x), this.py(route[i].y));
    }
  }

  private renderMarker(p: Vec2, fill: string, ring: string, label: string, invalid: boolean): void {
    const { ctx } = this;
    const r = 7;
    ctx.beginPath();
    ctx.arc(this.px(p.x), this.py(p.y), r, 0, Math.PI * 2);
    ctx.fillStyle = invalid ? 'rgba(239,68,68,0.3)' : fill;
    ctx.fill();
    ctx.strokeStyle = ring;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, this.px(p.x), this.py(p.y) + 0.5);
  }

  private renderDoorLabel(d: DoorDef, open: boolean): void {
    const { ctx } = this;
    const cx = this.px(d.x + d.w / 2);
    const cy = this.py(d.y + d.h / 2);
    ctx.fillStyle = open ? '#86efac' : '#fca5a5';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(open ? '开' : '关', cx, cy);
  }

  private renderScaleTag(): void {
    const { ctx } = this;
    ctx.fillStyle = 'rgba(203, 213, 225, 0.75)';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('场景 40 × 30 单位', 8, 8);
  }
}
