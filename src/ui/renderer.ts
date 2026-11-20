import { Harness } from '../core/harness';
import { Vec2 } from '../core/protocol';

const COLORS = {
  bg: '#0f1420',
  wall: '#3a4663',
  wallEdge: '#5a6a92',
  grid: '#1a2236',
  spawn: '#2c3b2f',
  trailPred: 'rgba(88, 166, 255, 0.55)',
  trailSrv: 'rgba(255, 170, 84, 0.55)',
  predicted: '#58a6ff',
  render: '#ffffff',
  server: '#ffaa54',
  errorLine: 'rgba(255, 99, 132, 0.9)',
};

/** 同屏渲染：一张地图上同时画出权威位置（橙）、客户端逻辑位置（蓝）与视觉位置（白） */
export class Renderer {
  ctx: CanvasRenderingContext2D;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D 不可用');
    this.ctx = ctx;
  }

  draw(h: Harness): void {
    const { ctx } = this;
    const w = h.world;
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    this.grid();
    this.spawn(w.spawn, w.radius);
    this.pushZone(h);
    for (const wall of w.walls) {
      ctx.fillStyle = COLORS.wall;
      ctx.fillRect(wall.x, wall.y, wall.w, wall.h);
      ctx.strokeStyle = COLORS.wallEdge;
      ctx.lineWidth = 1;
      ctx.strokeRect(wall.x + 0.5, wall.y + 0.5, wall.w - 1, wall.h - 1);
    }

    if (h.settings.showTrail) {
      this.trail(h.trailPredicted, COLORS.trailPred);
      this.trail(h.trailServer, COLORS.trailSrv);
    }

    // 逻辑误差连线：客户端逻辑点 ↔ 权威点
    const s = h.server.pos;
    const p = h.client.pos;
    if (Math.hypot(p.x - s.x, p.y - s.y) > 0.5) {
      ctx.strokeStyle = COLORS.errorLine;
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(s.x, s.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 权威端真实位置：橙色实心圆 + 外环
    this.marker(s, COLORS.server, w.radius, '权威');
    // 客户端逻辑位置：蓝色圆
    this.marker(p, COLORS.predicted, w.radius * 0.82, '预测(逻辑)');
    // 视觉位置（平滑后的渲染点）：白色描边圆，关闭平滑时与蓝点重合
    const r = h.client.renderPos;
    ctx.strokeStyle = COLORS.render;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(r.x, r.y, w.radius * 0.55, 0, Math.PI * 2);
    ctx.stroke();
  }

  private grid(): void {
    const { ctx } = this;
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    for (let x = 40; x < this.canvas.width; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.canvas.height);
      ctx.stroke();
    }
    for (let y = 40; y < this.canvas.height; y += 40) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.canvas.width, y);
      ctx.stroke();
    }
  }

  private spawn(pos: Vec2, radius: number): void {
    const { ctx } = this;
    ctx.fillStyle = COLORS.spawn;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, radius + 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#4d7a52';
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /** 权威推挤区：半透明紫色区域 + 推力方向箭头；仅权威端模拟，客户端只渲染 */
  private pushZone(h: Harness): void {
    const { ctx } = this;
    const z = h.world.pushZone;
    ctx.save();
    ctx.fillStyle = h.settings.pushZone ? 'rgba(150, 110, 220, 0.16)' : 'rgba(120,120,120,0.07)';
    ctx.fillRect(z.x, z.y, z.w, z.h);
    ctx.strokeStyle = h.settings.pushZone ? 'rgba(190, 150, 255, 0.75)' : 'rgba(160,160,160,0.35)';
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(z.x + 1, z.y + 1, z.w - 2, z.h - 2);
    ctx.setLineDash([]);
    if (h.settings.pushZone) {
      const cy = z.y + z.h / 2;
      ctx.strokeStyle = 'rgba(210, 180, 255, 0.9)';
      ctx.fillStyle = 'rgba(210, 180, 255, 0.9)';
      ctx.lineWidth = 2;
      for (const ax of [z.x + 28, z.x + 62, z.x + 96]) {
        ctx.beginPath();
        ctx.moveTo(ax - 10, cy);
        ctx.lineTo(ax + 8, cy);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(ax + 8, cy);
        ctx.lineTo(ax + 1, cy - 4);
        ctx.lineTo(ax + 1, cy + 4);
        ctx.closePath();
        ctx.fill();
      }
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillText('权威推挤区（客户端不模拟）', z.x + 6, z.y - 6);
    }
    ctx.restore();
  }

  private trail(points: Vec2[], color: string): void {
    if (points.length < 2) return;
    const { ctx } = this;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke();
  }

  private marker(pos: Vec2, color: string, radius: number, label: string): void {
    const { ctx } = this;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillStyle = color;
    ctx.fillText(label, pos.x + radius + 5, pos.y - radius - 2);
  }
}
