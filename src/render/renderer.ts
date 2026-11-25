import { add, fromAngle, len, scale, type Vec2 } from '../vec';
import type { Boat, BoatReadout, Buoy, CurrentZone, GateSpec, WindState } from '../engine/types';
import { BOAT_RADIUS } from '../engine/world';
import type { CourseDef } from '../engine/course';

export interface RenderState {
  boat: Boat;
  readout: BoatReadout;
  wind: WindState;
  currents: CurrentZone[];
  buoys: Buoy[];
  course: CourseDef | null;
  nextGateIndex: number;
  paused: boolean;
  showVectors: boolean;
  trail: Vec2[];
  windArrows: { pos: Vec2; phase: number }[];
  ghost?: { boat: Boat; trail: Vec2[] } | null;
}

const COL = {
  water: '#0e2a3a',
  waterDeep: '#0a2030',
  current: 'rgba(120, 200, 230, 0.10)',
  currentArrow: 'rgba(140, 210, 235, 0.55)',
  boat: '#f2f4f6',
  boatDeck: '#d9b483',
  sail: '#fafafa',
  sailLuff: '#ffd27a',
  buoy: '#ff5a4e',
  buoyRing: 'rgba(255,90,78,0.25)',
  gate: 'rgba(255,255,255,0.35)',
  gateNext: 'rgba(120,230,160,0.7)',
  wind: 'rgba(220,240,255,0.5)',
  heading: '#7dd3fc',
  cog: '#fbbf24',
  force: '#f472b6',
  trail: 'rgba(125, 211, 252, 0.35)',
  noGo: 'rgba(248, 113, 113, 0.12)',
};

export class Renderer {
  readonly ctx: CanvasRenderingContext2D;
  readonly width: number;
  readonly height: number;

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx = ctx;
    this.width = canvas.width;
    this.height = canvas.height;
  }

  render(s: RenderState): void {
    const { ctx } = this;
    ctx.clearRect(0, 0, this.width, this.height);
    this.drawWater();
    this.drawNoGoZone(s);
    this.drawCurrents(s);
    if (s.course) this.drawGates(s);
    this.drawBuoys(s);
    this.drawTrail(s);
    this.drawWindField(s);
    if (s.ghost) this.drawGhost(s.ghost);
    this.drawBoat(s);
    if (s.showVectors) this.drawVectors(s);
  }

  private drawWater(): void {
    const { ctx } = this;
    ctx.fillStyle = COL.water;
    ctx.fillRect(0, 0, this.width, this.height);
    // 细网格水纹
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= this.width; x += 50) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.height);
      ctx.stroke();
    }
    for (let y = 0; y <= this.height; y += 50) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.width, y);
      ctx.stroke();
    }
  }

  /** 风眼扇形（no-go zone），画在屏幕上风方向。 */
  private drawNoGoZone(s: RenderState): void {
    const { ctx } = this;
    const windFrom = s.wind.dir + Math.PI;
    const cx = this.width / 2;
    const cy = 60;
    const r = 46;
    ctx.fillStyle = COL.noGo;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, windFrom - Math.PI / 7, windFrom + Math.PI / 7);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(248,113,113,0.85)';
    ctx.font = '11px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('风眼', cx, cy - r - 6);
  }

  private drawCurrents(s: RenderState): void {
    const { ctx } = this;
    for (const z of s.currents) {
      ctx.fillStyle = COL.current;
      ctx.fillRect(z.x0, z.y0, z.x1 - z.x0, z.y1 - z.y0);
      // 流向箭头网格
      const mag = len(z.velocity);
      if (mag < 0.01) continue;
      const ang = Math.atan2(z.velocity.y, z.velocity.x);
      ctx.strokeStyle = COL.currentArrow;
      ctx.fillStyle = COL.currentArrow;
      ctx.lineWidth = 1.5;
      for (let x = z.x0 + 40; x < z.x1; x += 80) {
        for (let y = z.y0 + 30; y < z.y1; y += 55) {
          this.arrow(x, y, ang, 16);
        }
      }
    }
  }

  private drawGates(s: RenderState): void {
    const { ctx } = this;
    s.course!.gates.forEach((gate, i) => {
      const across = { x: -gate.legDir.y, y: gate.legDir.x };
      const a = add(gate.center, scale(across, -gate.halfWidth));
      const b = add(gate.center, scale(across, gate.halfWidth));
      const isNext = i === s.nextGateIndex;
      ctx.strokeStyle = isNext ? COL.gateNext : COL.gate;
      ctx.lineWidth = isNext ? 3 : 1.5;
      ctx.setLineDash(isNext ? [] : [7, 6]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      // 航段方向小箭头
      if (isNext) {
        const c = gate.center;
        this.arrow(c.x, c.y - gate.halfWidth - 14, Math.atan2(gate.legDir.y, gate.legDir.x), 14, COL.gateNext);
      }
      // 门标签
      ctx.fillStyle = isNext ? '#bbf7d0' : 'rgba(255,255,255,0.6)';
      ctx.font = '11px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(gate.label, gate.center.x, gate.center.y - gate.halfWidth - 22);
    });
  }

  private drawBuoys(s: RenderState): void {
    const { ctx } = this;
    for (const b of s.buoys) {
      ctx.beginPath();
      ctx.arc(b.pos.x, b.pos.y, b.radius + 6, 0, Math.PI * 2);
      ctx.fillStyle = COL.buoyRing;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(b.pos.x, b.pos.y, b.radius, 0, Math.PI * 2);
      ctx.fillStyle = COL.buoy;
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 11px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(b.id), b.pos.x, b.pos.y);
      ctx.textBaseline = 'alphabetic';
    }
  }

  private drawTrail(s: RenderState): void {
    const { ctx } = this;
    if (s.trail.length < 2) return;
    ctx.strokeStyle = COL.trail;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(s.trail[0].x, s.trail[0].y);
    for (const p of s.trail) ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }

  /** A/B 对照幽灵船：半透明绿色，带自己的航迹。 */
  private drawGhost(ghost: { boat: Boat; trail: Vec2[] }): void {
    const { ctx } = this;
    if (ghost.trail.length > 1) {
      ctx.strokeStyle = 'rgba(74, 222, 128, 0.35)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(ghost.trail[0].x, ghost.trail[0].y);
      for (const p of ghost.trail) ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
    ctx.save();
    ctx.translate(ghost.boat.pos.x, ghost.boat.pos.y);
    ctx.rotate(ghost.boat.heading);
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.moveTo(16, 0);
    ctx.quadraticCurveTo(10, -7, -12, -6);
    ctx.quadraticCurveTo(-15, 0, -12, 6);
    ctx.quadraticCurveTo(10, 7, 16, 0);
    ctx.closePath();
    ctx.fillStyle = '#4ade80';
    ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  private drawWindField(s: RenderState): void {
    const { ctx } = this;
    ctx.strokeStyle = COL.wind;
    ctx.fillStyle = COL.wind;
    ctx.lineWidth = 1;
    const ang = s.wind.dir;
    for (const w of s.windArrows) {
      const wobble = Math.sin(w.phase) * 2;
      this.arrow(w.pos.x, w.pos.y + wobble, ang, 12, COL.wind);
    }
  }

  private drawBoat(s: RenderState): void {
    const { ctx } = this;
    const { boat } = s;
    ctx.save();
    ctx.translate(boat.pos.x, boat.pos.y);
    ctx.rotate(boat.heading);

    // 船体：尖头椭圆
    ctx.beginPath();
    ctx.moveTo(16, 0);
    ctx.quadraticCurveTo(10, -7, -12, -6);
    ctx.quadraticCurveTo(-15, 0, -12, 6);
    ctx.quadraticCurveTo(10, 7, 16, 0);
    ctx.closePath();
    ctx.fillStyle = COL.boat;
    ctx.fill();
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1;
    ctx.stroke();
    // 甲板舱
    ctx.fillStyle = COL.boatDeck;
    ctx.beginPath();
    ctx.ellipse(-2, 0, 6, 3.2, 0, 0, Math.PI * 2);
    ctx.fill();

    // 帆：从桅杆（船中）向帆桁方向画三角帆
    const boomOff = boat.boomAngle - boat.heading;
    ctx.save();
    ctx.rotate(boomOff);
    const luff = s.readout.luffing;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-18, 0);
    ctx.lineTo(-2, -20);
    ctx.closePath();
    ctx.fillStyle = luff ? COL.sailLuff : COL.sail;
    ctx.globalAlpha = 0.7 + 0.3 * boat.fill;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#64748b';
    ctx.lineWidth = 1;
    ctx.stroke();
    // 帆桁
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-18, 0);
    ctx.stroke();
    ctx.restore();

    // 船头方向标记
    ctx.strokeStyle = COL.heading;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(16, 0);
    ctx.lineTo(24, 0);
    ctx.stroke();

    ctx.restore();

    // 失速时船周红色提示圈
    if (s.readout.inNoGo) {
      ctx.beginPath();
      ctx.arc(boat.pos.x, boat.pos.y, BOAT_RADIUS + 10, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(248,113,113,${0.4 + 0.4 * (1 - boat.fill)})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  /** 三个关键方向向量：船头、实际运动(COG)、帆受力。 */
  private drawVectors(s: RenderState): void {
    const { ctx } = this;
    const p = s.boat.pos;
    // 船头（蓝色，最长基准）
    this.vector(p, s.boat.heading, 42, COL.heading, '船头');
    // 实际运动方向 COG（橙色）
    const ground = add(s.boat.vel, s.readout.current);
    if (len(ground) > 0.05) {
      const cog = Math.atan2(ground.y, ground.x);
      this.vector(p, cog, 34, COL.cog, '运动');
    }
    // 帆受力方向（粉色）
    if (s.readout.sailForceMag > 0.05) {
      const f = s.readout.sailForce;
      const fa = Math.atan2(f.y, f.x);
      this.vector(p, fa, 30, COL.force, '帆力');
    }
  }

  private vector(origin: Vec2, ang: number, length: number, color: string, label: string): void {
    const { ctx } = this;
    const end = add(origin, fromAngle(ang, length));
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(origin.x, origin.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    this.arrowHead(end.x, end.y, ang, 6, color);
    ctx.font = '10px system-ui';
    ctx.textAlign = 'left';
    ctx.fillText(label, end.x + 4, end.y - 4);
  }

  private arrow(x: number, y: number, ang: number, size: number, color?: string): void {
    const { ctx } = this;
    if (color) {
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
    }
    const end = { x: x + Math.cos(ang) * size, y: y + Math.sin(ang) * size };
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    this.arrowHead(end.x, end.y, ang, 5);
  }

  private arrowHead(x: number, y: number, ang: number, size: number, color?: string): void {
    const { ctx } = this;
    if (color) ctx.fillStyle = color;
    const a1 = ang + 2.6;
    const a2 = ang - 2.6;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - Math.cos(a1) * size, y - Math.sin(a1) * size);
    ctx.lineTo(x - Math.cos(a2) * size, y - Math.sin(a2) * size);
    ctx.closePath();
    ctx.fill();
  }
}
