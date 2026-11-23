import type { Engine } from '../engine/engine.ts';
import { beatToTime, timeToBeat } from '../engine/chart.ts';
import type { LaneId, RuntimeTarget } from '../engine/types.ts';

const COLORS = {
  bg: '#10131a',
  grid: '#232838',
  barline: '#3a4358',
  playhead: '#f4f6ff',
  window: 'rgba(120, 150, 255, 0.13)',
  windowEdge: 'rgba(120, 150, 255, 0.35)',
  laneF: '#46d6a4',
  laneJ: '#e0a44d',
  hold: '#7aa2ff',
  text: '#c8cfde',
  dim: '#6b7385',
  perfect: '#8ef0c2',
  good: '#ffd48a',
  miss: '#ff7a7a',
  ignored: '#8a909e',
};

/**
 * Canvas 渲染：横向时间轴 + 每轨一行地板。
 * 纯绘制，不持有游戏状态；每帧由 main 调 render()。
 */
export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  /** 时间轴窗口半宽（秒）：画面覆盖 now±window。 */
  timeWindow = 2.2;
  /** 最近一次判定闪光 {目标id, 等级, 时刻}。 */
  flash: { targetId: string | null; grade: string; t: number } | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  render(engine: Engine, now: number, lanes: LaneId[]): void {
    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const cfg = engine.config;
    const spb = 60 / cfg.bpm;

    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, w, h);

    const xOf = (t: number) => w / 2 + ((t - now) / this.timeWindow) * (w / 2);
    const laneH = (h - 30) / Math.max(1, lanes.length);
    const laneY = (lane: LaneId) => 30 + lanes.indexOf(lane) * laneH;

    // --- 网格：每拍细线，每小节粗线 ---
    const startBeat = Math.max(0, Math.floor(timeToBeat(now - this.timeWindow, cfg.bpm)));
    const endBeat = Math.ceil(timeToBeat(now + this.timeWindow, cfg.bpm));
    ctx.font = '11px ui-monospace, monospace';
    for (let b = startBeat; b <= endBeat; b++) {
      const x = xOf(beatToTime(b, cfg.bpm));
      const isBar = b % cfg.beatsPerMeasure === 0;
      ctx.strokeStyle = isBar ? COLORS.barline : COLORS.grid;
      ctx.lineWidth = isBar ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(x, 24);
      ctx.lineTo(x, h);
      ctx.stroke();
      if (isBar) {
        ctx.fillStyle = COLORS.dim;
        ctx.fillText(`第${b / cfg.beatsPerMeasure + 1}小节`, x + 4, 14);
      }
    }

    // --- 轨标签与分隔线 ---
    lanes.forEach((lane, i) => {
      const y = laneY(lane);
      ctx.strokeStyle = COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      ctx.fillStyle = lane === 'F' ? COLORS.laneF : COLORS.laneJ;
      ctx.font = 'bold 16px ui-monospace, monospace';
      ctx.fillText(lane, 8, y + laneH / 2 + 6);
      ctx.font = '11px ui-monospace, monospace';
      void i;
    });

    // --- 判定窗口带（重叠时肉眼可见）---
    for (const t of engine.targets) {
      if (!lanes.includes(t.lane)) continue;
      const head = engine.headAt(t);
      const x1 = xOf(head - cfg.goodWindow);
      const x2 = xOf(head + cfg.goodWindow);
      const y = laneY(t.lane) + 8;
      ctx.fillStyle = COLORS.window;
      ctx.fillRect(x1, y, x2 - x1, laneH - 16);
      ctx.strokeStyle = COLORS.windowEdge;
      ctx.lineWidth = 1;
      ctx.strokeRect(x1, y, x2 - x1, laneH - 16);
    }

    // --- 地板 ---
    for (const t of engine.targets) {
      if (!lanes.includes(t.lane)) continue;
      this.drawTarget(ctx, engine, t, xOf, laneY(t.lane), laneH);
    }

    // --- 播放头 ---
    ctx.strokeStyle = COLORS.playhead;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(w / 2, 24);
    ctx.lineTo(w / 2, h);
    ctx.stroke();

    // --- 判定闪光 ---
    if (this.flash && now - this.flash.t < 0.45) {
      const alpha = 1 - (now - this.flash.t) / 0.45;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = this.gradeColor(this.flash.grade);
      ctx.font = 'bold 22px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(this.flash.grade.toUpperCase(), w / 2, 22);
      ctx.textAlign = 'left';
      ctx.globalAlpha = 1;
    } else {
      this.flash = null;
    }
    void spb;
  }

  private drawTarget(
    ctx: CanvasRenderingContext2D,
    engine: Engine,
    t: RuntimeTarget,
    xOf: (t: number) => number,
    y0: number,
    laneH: number,
  ): void {
    const head = engine.headAt(t);
    const isHold = t.lengthBeats > 0;
    const y = y0 + 12;
    const bh = laneH - 24;
    const base = t.lane === 'F' ? COLORS.laneF : COLORS.laneJ;

    if (isHold) {
      const tail = engine.tailAt(t);
      const x1 = xOf(head);
      const x2 = xOf(tail);
      // 按住身
      ctx.fillStyle = t.state === 'held' ? COLORS.hold : 'rgba(122,162,255,0.35)';
      ctx.fillRect(x1, y + bh / 2 - 5, Math.max(3, x2 - x1), 10);
      // 尾拍刻度
      ctx.strokeStyle = COLORS.hold;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x2, y);
      ctx.lineTo(x2, y + bh);
      ctx.stroke();
    }

    const x = xOf(head);
    const bw = 14;
    let color = base;
    if (t.state === 'done') {
      color = t.finalGrade ? this.gradeColor(t.finalGrade) : COLORS.dim;
      ctx.globalAlpha = 0.45;
    } else if (t.state === 'held') {
      color = COLORS.hold;
    }
    ctx.fillStyle = color;
    this.roundRect(ctx, x - bw / 2, y, bw, bh, 4);
    ctx.fill();
    ctx.globalAlpha = 1;

    // id 标在板上方
    ctx.fillStyle = COLORS.dim;
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillText(t.id, x - 9, y - 3);
  }

  private roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  private gradeColor(grade: string): string {
    switch (grade) {
      case 'perfect':
        return COLORS.perfect;
      case 'good':
        return COLORS.good;
      case 'miss':
        return COLORS.miss;
      default:
        return COLORS.ignored;
    }
  }
}
