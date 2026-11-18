/**
 * Canvas 渲染器:只负责把 Simulation 的状态画出来,不修改模拟状态。
 * 同时承担屏幕坐标 <-> 世界坐标的换算,供 UI 命中测试使用。
 */
import { Simulation, RuntimeAgent } from '../sim/sim';
import { Vec, sub, dist, len, mul } from '../sim/math';
import { WORLD_W, WORLD_H, NEIGHBOR_DIST, Rect } from '../sim/types';

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  scale = 1;
  offsetX = 0;
  offsetY = 0;
  showTrails = true;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法获取 2D 绘图上下文');
    this.ctx = ctx;
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.scale = Math.min(cssW / WORLD_W, cssH / WORLD_H);
    this.offsetX = (cssW - WORLD_W * this.scale) / 2;
    this.offsetY = (cssH - WORLD_H * this.scale) / 2;
  }

  toWorld(sx: number, sy: number): Vec {
    return {
      x: (sx - this.offsetX) / this.scale,
      y: (sy - this.offsetY) / this.scale,
    };
  }

  draw(sim: Simulation, selectedId: number | null, hoverId: number | null): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.scale(
      this.canvas.width / this.canvas.clientWidth,
      this.canvas.height / this.canvas.clientHeight,
    );
    ctx.translate(this.offsetX, this.offsetY);
    ctx.scale(this.scale, this.scale);

    this.drawFloor(ctx);
    this.drawRects(ctx, sim.rects);
    if (this.showTrails) this.drawTrails(ctx, sim);
    this.drawNeighborRange(ctx, sim, selectedId);
    for (const a of sim.agents) this.drawGoal(ctx, a);
    for (const a of sim.agents) {
      this.drawAgent(
        ctx,
        a,
        a.id === selectedId,
        a.id === hoverId,
        sim.layoutBlocked,
      );
    }
    if (selectedId !== null) this.drawSelectionVectors(ctx, sim, selectedId);
    this.drawBorder(ctx);
    ctx.restore();
  }

  private drawFloor(ctx: CanvasRenderingContext2D): void {
    ctx.fillStyle = '#10151d';
    ctx.fillRect(0, 0, WORLD_W, WORLD_H);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1 / this.scale;
    ctx.beginPath();
    for (let x = 1; x < WORLD_W; x++) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, WORLD_H);
    }
    for (let y = 1; y < WORLD_H; y++) {
      ctx.moveTo(0, y);
      ctx.lineTo(WORLD_W, y);
    }
    ctx.stroke();
  }

  private drawBorder(ctx: CanvasRenderingContext2D): void {
    ctx.strokeStyle = '#5b7fa6';
    ctx.lineWidth = 2 / this.scale;
    ctx.strokeRect(0, 0, WORLD_W, WORLD_H);
  }

  private drawRects(ctx: CanvasRenderingContext2D, rects: Rect[]): void {
    for (const r of rects) {
      ctx.fillStyle = '#2c3a4f';
      ctx.strokeStyle = '#7fa3cc';
      ctx.lineWidth = 1.5 / this.scale;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      // 斜线纹理表示不可通行
      ctx.save();
      ctx.beginPath();
      ctx.rect(r.x, r.y, r.w, r.h);
      ctx.clip();
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1 / this.scale;
      for (let d = -r.h; d < r.w + r.h; d += 0.8) {
        ctx.beginPath();
        ctx.moveTo(r.x + d, r.y);
        ctx.lineTo(r.x + d + r.h, r.y + r.h);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  private drawTrails(ctx: CanvasRenderingContext2D, sim: Simulation): void {
    for (const a of sim.agents) {
      if (a.trail.length < 2) continue;
      ctx.strokeStyle = this.alpha(a.spec.color, 0.35);
      ctx.lineWidth = 0.06;
      ctx.beginPath();
      ctx.moveTo(a.trail[0].x, a.trail[0].y);
      for (const p of a.trail) ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
  }

  private drawGoal(ctx: CanvasRenderingContext2D, a: RuntimeAgent): void {
    if (a.arrived) return;
    const g = a.goal;
    ctx.strokeStyle = this.alpha(a.spec.color, 0.9);
    ctx.lineWidth = 1.5 / this.scale;
    const s = 0.22;
    ctx.beginPath();
    ctx.moveTo(g.x - s, g.y - s);
    ctx.lineTo(g.x + s, g.y + s);
    ctx.moveTo(g.x + s, g.y - s);
    ctx.lineTo(g.x - s, g.y + s);
    ctx.stroke();
    ctx.strokeStyle = this.alpha(a.spec.color, 0.35);
    ctx.beginPath();
    ctx.arc(g.x, g.y, a.radius, 0, Math.PI * 2);
    ctx.stroke();
  }

  private drawAgent(
    ctx: CanvasRenderingContext2D,
    a: RuntimeAgent,
    selected: boolean,
    hover: boolean,
    blocked: boolean,
  ): void {
    const fill = a.arrived
      ? '#3d8b5f'
      : a.waiting
        ? '#d98e2b'
        : a.spec.color;
    ctx.beginPath();
    ctx.arc(a.pos.x, a.pos.y, a.radius, 0, Math.PI * 2);
    ctx.fillStyle = this.alpha(fill, a.arrived ? 0.55 : 0.9);
    ctx.fill();
    ctx.lineWidth = (selected ? 2.5 : hover ? 2 : 1.2) / this.scale;
    ctx.strokeStyle = selected ? '#ffffff' : blocked ? '#ff5252' : this.alpha(fill, 1);
    ctx.stroke();

    // 编号
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.font = `${0.42}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(a.id), a.pos.x, a.pos.y + 0.01);
  }

  private drawNeighborRange(
    ctx: CanvasRenderingContext2D,
    sim: Simulation,
    selectedId: number | null,
  ): void {
    if (selectedId === null) return;
    const me = sim.agents.find((a) => a.id === selectedId);
    if (!me) return;
    ctx.beginPath();
    ctx.arc(me.pos.x, me.pos.y, NEIGHBOR_DIST, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(120,180,255,0.06)';
    ctx.fill();
    ctx.setLineDash([0.25, 0.25]);
    ctx.strokeStyle = 'rgba(140,190,255,0.5)';
    ctx.lineWidth = 1 / this.scale;
    ctx.stroke();
    ctx.setLineDash([]);

    // 与最近邻近的表面间距连线
    for (const nb of sim.neighborsOf(selectedId)) {
      const other = sim.agents.find((a) => a.id === nb.id);
      if (!other) continue;
      const dir = sub(other.pos, me.pos);
      const d = len(dir);
      if (d < 1e-9) continue;
      const unit = mul(dir, 1 / d);
      const p1 = { x: me.pos.x + unit.x * me.radius, y: me.pos.y + unit.y * me.radius };
      const p2 = { x: other.pos.x - unit.x * other.radius, y: other.pos.y - unit.y * other.radius };
      ctx.strokeStyle = nb.surfaceGap < 0 ? 'rgba(255,80,80,0.9)' : 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1 / this.scale;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }
  }

  private drawSelectionVectors(
    ctx: CanvasRenderingContext2D,
    sim: Simulation,
    selectedId: number,
  ): void {
    const me = sim.agents.find((a) => a.id === selectedId);
    if (!me) return;
    // 实际速度(白色实线)
    this.arrow(ctx, me.pos, { x: me.pos.x + me.vel.x, y: me.pos.y + me.vel.y }, '#ffffff');
    // 目标方向(黄色虚线)
    if (!me.arrived) {
      const toGoal = sub(me.goal, me.pos);
      const d = len(toGoal);
      if (d > 1e-9) {
        const end = {
          x: me.pos.x + (toGoal.x / d) * Math.min(1.6, d),
          y: me.pos.y + (toGoal.y / d) * Math.min(1.6, d),
        };
        ctx.setLineDash([0.18, 0.18]);
        ctx.strokeStyle = '#ffe082';
        ctx.lineWidth = 1.2 / this.scale;
        ctx.beginPath();
        ctx.moveTo(me.pos.x, me.pos.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  private arrow(ctx: CanvasRenderingContext2D, from: Vec, to: Vec, color: string): void {
    const d = dist(from, to);
    if (d < 1e-6) return;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.4 / this.scale;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    const u = mul(sub(to, from), 1 / d);
    const head = 0.22;
    ctx.beginPath();
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(to.x - u.x * head + u.y * head * 0.6, to.y - u.y * head - u.x * head * 0.6);
    ctx.lineTo(to.x - u.x * head - u.y * head * 0.6, to.y - u.y * head + u.x * head * 0.6);
    ctx.closePath();
    ctx.fill();
  }

  private alpha(hex: string, a: number): string {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
}
