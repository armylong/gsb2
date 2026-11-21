/**
 * Canvas 2D 渲染器：只负责画，不做任何计时判定。
 * 绘制内容：跑道（内外边界/中心线）、闸门（编号/方向箭头/状态色）、
 * 角色、幻影、闸门命中闪光与事件标记。
 */
import { Track, Gate } from '../engine/track';
import { Vec2, v } from '../engine/geometry';
import { SessionMode } from '../engine/session';
import { Ghost } from '../engine/ghost';

export interface Flash {
  pos: Vec2;
  gate: number;
  bornAt: number;
  kind: 'ok' | 'bad' | 'overlap';
}

const GATE_COLORS: Record<SessionMode | 'dim', string> = {
  idle: '#8b95a7',
  running: '#37d67a',
  invalid: '#ff5d5d',
  dim: '#5b6472',
};

export class Renderer {
  readonly ctx: CanvasRenderingContext2D;
  private readonly track: Track;

  constructor(
    readonly canvas: HTMLCanvasElement,
    track: Track,
  ) {
    this.track = track;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法获取 2d 上下文');
    this.ctx = ctx;
  }

  draw(state: {
    carPos: Vec2;
    carAngle: number;
    ghost: Ghost | null;
    sessionTime: number;
    mode: SessionMode;
    expected: number;
    flashes: Flash[];
    now: number;
    paused: boolean;
  }): void {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    this.drawBackground();
    this.drawTrack();
    this.drawGates(state.mode, state.expected);
    this.drawFlashes(state.flashes, state.now);
    if (state.ghost) this.drawGhost(state.ghost, state.sessionTime);
    this.drawCar(state.carPos, state.carAngle, state.paused);
  }

  private drawBackground(): void {
    const { ctx, canvas } = this;
    const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
    grad.addColorStop(0, '#141a24');
    grad.addColorStop(1, '#0e131b');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  private drawTrack(): void {
    const { ctx, track } = this;
    const strokeLoop = (points: Vec2[], style: string, width: number, dash: number[] = []) => {
      ctx.beginPath();
      points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.strokeStyle = style;
      ctx.lineWidth = width;
      ctx.setLineDash(dash);
      ctx.stroke();
      ctx.setLineDash([]);
    };

    // 沥青底色：沿中心线粗描边
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    strokeLoop(track.centerline, '#232c3a', track.width);
    strokeLoop(track.outerEdge, '#46536a', 3);
    strokeLoop(track.innerEdge, '#46536a', 3);
    strokeLoop(track.centerline, 'rgba(255,255,255,0.18)', 1.5, [10, 12]);

    // 方向小箭头（沿中心线均布）
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    for (let i = 0; i < 16; i++) {
      const f = i / 16;
      const p = track.positionAt(f);
      const t = track.tangentAt(f);
      this.arrowHead(p, Math.atan2(t.y, t.x), 9, 'rgba(255,255,255,0.35)');
    }
  }

  private drawGates(mode: SessionMode, expected: number): void {
    for (const gate of this.track.gates) {
      const isExpected = mode === 'running' && gate.index === expected;
      const baseColor =
        mode === 'idle'
          ? gate.index === 0
            ? GATE_COLORS.running
            : GATE_COLORS.idle
          : mode === 'invalid'
            ? GATE_COLORS.invalid
            : isExpected
              ? GATE_COLORS.running
              : GATE_COLORS.dim;
      this.drawGate(gate, baseColor, isExpected);
    }
  }

  private drawGate(gate: Gate, color: string, highlight: boolean): void {
    const { ctx } = this;
    // 闸门横梁
    ctx.beginPath();
    ctx.moveTo(gate.a.x, gate.a.y);
    ctx.lineTo(gate.b.x, gate.b.y);
    ctx.strokeStyle = color;
    ctx.lineWidth = highlight ? 6 : 4;
    ctx.globalAlpha = highlight ? 1 : 0.85;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // 端点
    for (const p of [gate.a, gate.b]) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }

    // 方向箭头（画在闸门中点稍偏切线方向）
    const tip = {
      x: gate.center.x + gate.tangent.x * 26,
      y: gate.center.y + gate.tangent.y * 26,
    };
    this.arrowHead(tip, Math.atan2(gate.tangent.y, gate.tangent.x), 11, color);

    // 编号标签
    const labelPos = {
      x: gate.center.x - gate.tangent.x * 30,
      y: gate.center.y - gate.tangent.y * 30,
    };
    ctx.font = 'bold 15px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#0e131b';
    ctx.beginPath();
    ctx.arc(labelPos.x, labelPos.y, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.fillText(gate.name, labelPos.x, labelPos.y + 0.5);
  }

  private arrowHead(tip: Vec2, angle: number, size: number, color: string): void {
    const { ctx } = this;
    const a1 = angle + Math.PI * 0.82;
    const a2 = angle - Math.PI * 0.82;
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(tip.x + size * Math.cos(a1), tip.y + size * Math.sin(a1));
    ctx.lineTo(tip.x + size * Math.cos(a2), tip.y + size * Math.sin(a2));
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  private drawCar(pos: Vec2, angle: number, paused: boolean): void {
    const { ctx } = this;
    ctx.save();
    ctx.translate(pos.x, pos.y);
    ctx.rotate(angle);
    // 车身
    ctx.beginPath();
    ctx.moveTo(14, 0);
    ctx.lineTo(-10, 8);
    ctx.lineTo(-6, 0);
    ctx.lineTo(-10, -8);
    ctx.closePath();
    ctx.fillStyle = paused ? '#f0b429' : '#5aa9ff';
    ctx.fill();
    ctx.strokeStyle = '#dbeafe';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();

    if (paused) {
      ctx.font = '12px ui-monospace, monospace';
      ctx.fillStyle = '#f0b429';
      ctx.textAlign = 'center';
      ctx.fillText('⏸ 已暂停（计时冻结）', pos.x, pos.y - 20);
    }
  }

  private drawGhost(ghost: Ghost, sessionTime: number): void {
    const sample = ghost.sampleAt(sessionTime);
    if (!sample) return;
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.translate(sample.pos.x, sample.pos.y);
    ctx.rotate(sample.angle);
    ctx.beginPath();
    ctx.moveTo(13, 0);
    ctx.lineTo(-9, 7);
    ctx.lineTo(-5, 0);
    ctx.lineTo(-9, -7);
    ctx.closePath();
    ctx.fillStyle = '#b48cff';
    ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 1;

    ctx.font = '11px ui-monospace, monospace';
    ctx.fillStyle = '#b48cff';
    ctx.textAlign = 'center';
    ctx.fillText('幻影', sample.pos.x, sample.pos.y - 16);
  }

  private drawFlashes(flashes: Flash[], now: number): void {
    const { ctx } = this;
    for (const flash of flashes) {
      const age = (now - flash.bornAt) / 1000;
      if (age > 0.9) continue;
      const alpha = 1 - age / 0.9;
      const radius = 10 + age * 26;
      const color =
        flash.kind === 'ok' ? '#37d67a' : flash.kind === 'bad' ? '#ff5d5d' : '#f0b429';
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(flash.pos.x, flash.pos.y, radius, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
}

export function flashKindFor(kind: string): Flash['kind'] {
  if (kind === 'gate-overlap') return 'overlap';
  if (kind === 'gate-hit' || kind === 'lap') return 'ok';
  return 'bad';
}

export const nullVec = (): Vec2 => v(0, 0);
