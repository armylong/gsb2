// Canvas 渲染：世界坐标（米，y 向上）→ 屏幕坐标（像素，y 向下）
import { GliderState, Simulation, TrailPoint, sampleWindGrid } from './physics/sim';
import { GROUND_POINTS, PLATFORM, WORLD, buildSegments } from './physics/terrain';
import { CrosswindConfig, ThermalConfig } from './physics/wind';
import { Vec2, len, rad2deg } from './physics/vec';

export interface RenderOptions {
  showWindGrid: boolean;
  showTrail: boolean;
  showVectors: boolean;
  overlayTrails: TrailPoint[][];
}

const COLORS = {
  bg: '#0e1420',
  ground: '#26344a',
  groundLine: '#4a6a8f',
  platform: '#3d5a7a',
  thermalFill: 'rgba(255, 138, 76, 0.10)',
  thermalEdge: 'rgba(255, 138, 76, 0.55)',
  windFill: 'rgba(100, 180, 255, 0.07)',
  windEdge: 'rgba(100, 180, 255, 0.45)',
  glider: '#ffd166',
  gliderStalled: '#ef476f',
  gliderBody: '#f8f9fa',
  trail: '#8ecae6',
  trailStall: '#ef476f',
  velGround: '#06d6a0',
  velAir: '#ffd166',
  windVec: '#9db4d4',
  text: '#cdd7e5',
};

export class Renderer {
  ctx: CanvasRenderingContext2D;
  scale = 4; // 像素/米
  originX = 0;
  originY = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.resize();
  }

  resize() {
    const parent = this.canvas.parentElement!;
    const w = parent.clientWidth;
    const h = Math.max(420, Math.min(720, w * 0.6));
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.scale = Math.min(w / WORLD.width, h / WORLD.height);
    this.originX = (w - WORLD.width * this.scale) / 2;
    this.originY = h;
  }

  private sx(x: number): number {
    return this.originX + x * this.scale;
  }
  private sy(y: number): number {
    return this.originY - y * this.scale;
  }
  private sp(v: number): number {
    return v * this.scale;
  }

  render(sim: Simulation, opts: RenderOptions) {
    const ctx = this.ctx;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, w, h);

    this.drawWindZones(sim.thermal, sim.crosswind);
    if (opts.showWindGrid) this.drawWindGrid(sim);
    this.drawTerrain();
    if (opts.showTrail) {
      for (const trail of opts.overlayTrails) this.drawTrail(trail, 'rgba(142,202,230,0.35)', true);
      this.drawTrail(sim.trail, COLORS.trail, false);
    }
    this.drawGlider(sim.state);
    if (opts.showVectors) this.drawVelocityVectors(sim.state);
    this.drawHud(sim.state);
  }

  private drawWindZones(thermal: ThermalConfig, cross: CrosswindConfig) {
    const ctx = this.ctx;
    if (thermal.enabled) {
      ctx.save();
      ctx.fillStyle = COLORS.thermalFill;
      ctx.strokeStyle = COLORS.thermalEdge;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.ellipse(this.sx(thermal.cx), this.sy(thermal.cy), this.sp(thermal.rx), this.sp(thermal.ry), 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = COLORS.thermalEdge;
      ctx.font = '12px monospace';
      ctx.fillText(`暖气团 ↑${thermal.strength}m/s`, this.sx(thermal.cx - thermal.rx), this.sy(thermal.cy + thermal.ry) + 16);
      ctx.restore();
    }
    if (cross.enabled) {
      const ctx2 = this.ctx;
      ctx2.save();
      ctx2.fillStyle = COLORS.windFill;
      ctx2.strokeStyle = COLORS.windEdge;
      ctx2.lineWidth = 1.5;
      ctx2.setLineDash([4, 4]);
      const x = this.sx(cross.xStart);
      const y = this.sy(cross.yHigh);
      ctx2.fillRect(x, y, this.sp(cross.xEnd - cross.xStart), this.sp(cross.yHigh - cross.yLow));
      ctx2.strokeRect(x, y, this.sp(cross.xEnd - cross.xStart), this.sp(cross.yHigh - cross.yLow));
      ctx2.setLineDash([]);
      ctx2.fillStyle = COLORS.windEdge;
      ctx2.font = '12px monospace';
      ctx2.fillText(`侧风区 ${cross.strength}m/s（负值=迎风）`, x + 6, y + 14);
      ctx2.restore();
    }
  }

  private drawWindGrid(sim: Simulation) {
    const ctx = this.ctx;
    const grid = sampleWindGrid(26, 16, sim.thermal, sim.crosswind);
    ctx.save();
    ctx.strokeStyle = COLORS.windVec;
    ctx.fillStyle = COLORS.windVec;
    ctx.lineWidth = 1;
    for (const { pos, wind } of grid) {
      this.drawArrow(pos, wind, 1.1, COLORS.windVec, 0.7);
    }
    ctx.restore();
  }

  private drawArrow(origin: Vec2, vec: Vec2, scaleSec: number, color: string, alpha: number) {
    const ctx = this.ctx;
    const tip = { x: origin.x + vec.x * scaleSec, y: origin.y + vec.y * scaleSec };
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(this.sx(origin.x), this.sy(origin.y));
    ctx.lineTo(this.sx(tip.x), this.sy(tip.y));
    ctx.stroke();
    // 箭头头部
    const ang = Math.atan2(-(tip.y - origin.y), tip.x - origin.x);
    const hs = 5;
    ctx.beginPath();
    ctx.moveTo(this.sx(tip.x), this.sy(tip.y));
    ctx.lineTo(this.sx(tip.x) - hs * Math.cos(ang - 0.4), this.sy(tip.y) + hs * Math.sin(ang - 0.4));
    ctx.lineTo(this.sx(tip.x) - hs * Math.cos(ang + 0.4), this.sy(tip.y) + hs * Math.sin(ang + 0.4));
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private drawTerrain() {
    const ctx = this.ctx;
    const segs = buildSegments();
    ctx.save();
    // 填充地面
    ctx.beginPath();
    ctx.moveTo(this.sx(GROUND_POINTS[0].x), this.sy(0));
    for (const p of GROUND_POINTS) ctx.lineTo(this.sx(p.x), this.sy(p.y));
    ctx.lineTo(this.sx(GROUND_POINTS[GROUND_POINTS.length - 1].x), this.sy(0));
    ctx.closePath();
    ctx.fillStyle = COLORS.ground;
    ctx.fill();
    // 折线描边
    ctx.beginPath();
    GROUND_POINTS.forEach((p, i) => {
      if (i === 0) ctx.moveTo(this.sx(p.x), this.sy(p.y));
      else ctx.lineTo(this.sx(p.x), this.sy(p.y));
    });
    ctx.strokeStyle = COLORS.groundLine;
    ctx.lineWidth = 2;
    ctx.stroke();
    // 着陆台
    ctx.fillStyle = COLORS.platform;
    ctx.fillRect(
      this.sx(PLATFORM.xLeft),
      this.sy(PLATFORM.yTop),
      this.sp(PLATFORM.xRight - PLATFORM.xLeft),
      this.sp(PLATFORM.yTop - PLATFORM.yBottom),
    );
    ctx.strokeStyle = COLORS.groundLine;
    ctx.strokeRect(
      this.sx(PLATFORM.xLeft),
      this.sy(PLATFORM.yTop),
      this.sp(PLATFORM.xRight - PLATFORM.xLeft),
      this.sp(PLATFORM.yTop - PLATFORM.yBottom),
    );
    ctx.fillStyle = COLORS.text;
    ctx.font = '12px monospace';
    ctx.fillText('观测/着陆台', this.sx(PLATFORM.xLeft) + 4, this.sy(PLATFORM.yTop) - 6);
    // 段名标注（仅山坡与台面前缘）
    ctx.font = '10px monospace';
    ctx.fillStyle = 'rgba(205,215,229,0.55)';
    for (const seg of segs) {
      if (seg.kind === 'slope' || seg.kind === 'platform-edge') {
        const mx = (seg.a.x + seg.b.x) / 2;
        const my = (seg.a.y + seg.b.y) / 2;
        ctx.fillText(seg.name, this.sx(mx) - 14, this.sy(my) + 14);
      }
    }
    ctx.restore();
  }

  private drawTrail(trail: TrailPoint[], color: string, isOverlay: boolean) {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = isOverlay ? 1.2 : 2;
    ctx.beginPath();
    let drawing = false;
    for (let i = 0; i < trail.length; i++) {
      const p = trail[i];
      const c = p.stalled ? COLORS.trailStall : color;
      if (i === 0 || trail[i - 1].stalled !== p.stalled) {
        ctx.stroke();
        ctx.beginPath();
        ctx.strokeStyle = c;
        ctx.moveTo(this.sx(p.x), this.sy(p.y));
        drawing = true;
      } else if (drawing) {
        ctx.lineTo(this.sx(p.x), this.sy(p.y));
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawGlider(s: GliderState) {
    const ctx = this.ctx;
    const r = 2.2; // 纸片半长（米），仅用于绘制
    ctx.save();
    ctx.translate(this.sx(s.pos.x), this.sy(s.pos.y));
    ctx.rotate(-s.pitch); // 屏幕 y 向下，俯仰角取负
    // 机身：细长纸片
    ctx.fillStyle = COLORS.gliderBody;
    ctx.strokeStyle = s.stalled ? COLORS.gliderStalled : COLORS.glider;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(this.sp(r), 0);
    ctx.lineTo(this.sp(-r * 0.85), this.sp(0.9));
    ctx.lineTo(this.sp(-r * 0.55), 0);
    ctx.lineTo(this.sp(-r * 0.85), this.sp(-0.9));
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // 碰撞圆（调试用，淡显）
    ctx.beginPath();
    ctx.arc(0, 0, this.sp(1.4), 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    if (s.stalled) {
      ctx.fillStyle = COLORS.gliderStalled;
      ctx.font = 'bold 13px monospace';
      ctx.fillText('失速 STALL', this.sx(s.pos.x) - 30, this.sy(s.pos.y) - 26);
    }
  }

  private drawVelocityVectors(s: GliderState) {
    // 地速（绿）、空速（黄）、风速隐含为两者之差
    this.drawArrow(s.pos, s.vel, 1.2, COLORS.velGround, 0.95);
    this.drawArrow(s.pos, s.velAir, 1.2, COLORS.velAir, 0.95);
    const ctx = this.ctx;
    ctx.save();
    ctx.font = '11px monospace';
    const vgTip = { x: s.pos.x + s.vel.x * 1.2, y: s.pos.y + s.vel.y * 1.2 };
    const vaTip = { x: s.pos.x + s.velAir.x * 1.2, y: s.pos.y + s.velAir.y * 1.2 };
    ctx.fillStyle = COLORS.velGround;
    ctx.fillText(`地速 ${s.groundSpeed.toFixed(1)}`, this.sx(vgTip.x) + 4, this.sy(vgTip.y));
    ctx.fillStyle = COLORS.velAir;
    ctx.fillText(`空速 ${s.airspeed.toFixed(1)}`, this.sx(vaTip.x) + 4, this.sy(vaTip.y) + 13);
    ctx.restore();
  }

  private drawHud(s: GliderState) {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = 'rgba(14,20,32,0.72)';
    ctx.fillRect(10, 10, 236, 132);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.strokeRect(10, 10, 236, 132);
    ctx.fillStyle = COLORS.text;
    ctx.font = '12px monospace';
    const lines = [
      `t=${s.simTime.toFixed(2)}s  姿态俯仰=${rad2deg(s.pitch).toFixed(1)}°`,
      `迎角 α=${rad2deg(s.alpha).toFixed(1)}°  失速=${s.stalled ? '是' : '否'}`,
      `空速(相对空气)=${s.airspeed.toFixed(2)} m/s`,
      `地速(相对地面)=${s.groundSpeed.toFixed(2)} m/s`,
      `风=(${s.wind.x.toFixed(2)}, ${s.wind.y.toFixed(2)}) |w|=${len(s.wind).toFixed(2)}`,
      `位置=(${s.pos.x.toFixed(1)}, ${s.pos.y.toFixed(1)})`,
    ];
    lines.forEach((line, i) => ctx.fillText(line, 18, 30 + i * 18));
    ctx.restore();
  }
}
