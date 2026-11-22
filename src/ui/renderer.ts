import type { SimState, Solid, WorldPreset } from '../engine/types';

const KIND_COLORS: Record<Solid['kind'], string> = {
  ground: '#3f4a5c',
  wall: '#4a3f5c',
  ceiling: '#7a4a4a',
  step: '#45584a',
  platform: '#3d6b8f',
};

const EVENT_COLORS: Record<string, string> = {
  land: '#4ade80',
  leave: '#f87171',
  'support-switch': '#fbbf24',
  'head-bump': '#fb7185',
  jump: '#60a5fa',
  'coyote-jump': '#22d3ee',
  'buffered-jump': '#a78bfa',
  'platform-reverse': '#f472b6',
};

/** 纯渲染层：所有实体都是程序绘制的矩形与线条，无外部素材 */
export class Renderer {
  readonly ctx: CanvasRenderingContext2D;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D 上下文不可用');
    this.ctx = ctx;
  }

  configureDpr(width: number, height: number): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  render(state: SimState, preset: WorldPreset, displayFps: 30 | 60, paused: boolean): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, preset.width, preset.height);
    ctx.fillStyle = '#14181f';
    ctx.fillRect(0, 0, preset.width, preset.height);

    this.drawGrid(preset);
    for (const s of state.solids) this.drawSolid(s, state.player.groundId === s.id);
    this.drawPlayer(state);
    this.drawOverlayText(state, displayFps, paused);
  }

  private drawGrid(preset: WorldPreset): void {
    const ctx = this.ctx;
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= preset.width; x += 50) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, preset.height);
      ctx.stroke();
    }
    for (let y = 0; y <= preset.height; y += 50) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(preset.width, y);
      ctx.stroke();
    }
  }

  private drawSolid(s: Solid, isSupport: boolean): void {
    const ctx = this.ctx;
    ctx.fillStyle = KIND_COLORS[s.kind];
    ctx.fillRect(s.x, s.y, s.w, s.h);
    ctx.strokeStyle = isSupport ? '#fbbf24' : 'rgba(255,255,255,0.25)';
    ctx.lineWidth = isSupport ? 3 : 1;
    ctx.strokeRect(s.x + 0.5, s.y + 0.5, s.w - 1, s.h - 1);

    // 移动平台绘制速度箭头，直观看出换向
    if (s.moving) {
      const cx = s.x + s.w / 2;
      const cy = s.y + s.h / 2;
      const v = Math.abs(s.vx) > 0 ? s.vx : s.vy;
      if (Math.abs(v) > 1) {
        const dir = Math.sign(v);
        const horizontal = Math.abs(s.vx) > 0;
        ctx.strokeStyle = '#9ecbff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        if (horizontal) {
          ctx.moveTo(cx - dir * 14, cy);
          ctx.lineTo(cx + dir * 14, cy);
          ctx.lineTo(cx + dir * 8, cy - 4);
          ctx.moveTo(cx + dir * 14, cy);
          ctx.lineTo(cx + dir * 8, cy + 4);
        } else {
          ctx.moveTo(cx, cy - dir * 10);
          ctx.lineTo(cx, cy + dir * 10);
        }
        ctx.stroke();
      }
    }

    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillText(s.label, s.x + 4, s.y + 13);
  }

  private drawPlayer(state: SimState): void {
    const ctx = this.ctx;
    const p = state.player;

    // 角色本体（纯色方块，无美术素材）
    ctx.fillStyle = '#e2e8f0';
    ctx.fillRect(p.x, p.y, p.w, p.h);
    // 碰撞范围外框：始终可见
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2;
    ctx.strokeRect(p.x + 1, p.y + 1, p.w - 2, p.h - 2);

    // 四个接触方向标记：红=接触，灰=未接触
    const badges: Array<[keyof typeof p.contacts, number, number]> = [
      ['left', p.x - 8, p.y + p.h / 2],
      ['right', p.x + p.w + 2, p.y + p.h / 2],
      ['up', p.x + p.w / 2 - 3, p.y - 12],
      ['down', p.x + p.w / 2 - 3, p.y + p.h + 4],
    ];
    for (const [side, bx, by] of badges) {
      ctx.fillStyle = p.contacts[side] ? '#ef4444' : 'rgba(255,255,255,0.25)';
      ctx.fillRect(bx, by, 6, 6);
    }

    // 脚下支撑连线：不只靠动画，明确画出支撑关系
    if (p.grounded && p.groundId) {
      const support = state.solids.find((s) => s.id === p.groundId);
      if (support) {
        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(p.x + p.w / 2, p.y + p.h);
        ctx.lineTo(p.x + p.w / 2, support.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // 土狼 / 缓冲计时条
    if (p.coyoteTimer > 0) {
      ctx.fillStyle = '#22d3ee';
      ctx.fillRect(p.x, p.y - 5, (p.coyoteTimer / state.params.coyoteTime) * p.w, 3);
    }
    if (p.jumpBufferTimer > 0) {
      ctx.fillStyle = '#a78bfa';
      ctx.fillRect(p.x, p.y + p.h + 2, (p.jumpBufferTimer / state.params.jumpBufferTime) * p.w, 3);
    }
  }

  private drawOverlayText(state: SimState, displayFps: 30 | 60, paused: boolean): void {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(8, 8, 226, 64);
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '12px ui-monospace, monospace';
    ctx.fillText(`模拟 60Hz 固定步长  显示 ${displayFps}fps`, 16, 26);
    ctx.fillText(`t=${state.time.toFixed(3)}s  step=${state.step}`, 16, 44);
    ctx.fillText(paused ? '状态: 已暂停（单步逐帧推进）' : '状态: 运行中', 16, 62);
  }

  eventColor(type: string): string {
    return EVENT_COLORS[type] ?? '#94a3b8';
  }
}
