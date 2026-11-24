// Canvas 渲染：地形、积雪、足迹（含叠踩栈）、玩家、观察范围与推断链。

import type { GameState } from '../core/game.js';
import { SCAN_RADIUS } from '../core/game.js';
import { remainingDepth, visibilityAt } from '../core/snow.js';
import {
  DepthLevel,
  Dir,
  DIR_NAMES,
  Impression,
  Visibility,
  Zone,
} from '../core/types.js';

export const CELL = 44;

const ZONE_COLORS: Record<Zone, string> = {
  [Zone.Block]: '#3a3f4a',
  [Zone.Normal]: '#e8eef5',
  [Zone.Wind]: '#c9d8ea',
  [Zone.Shelter]: '#dcefe0',
};

const ZONE_BORDER: Record<Zone, string> = {
  [Zone.Block]: '#2b2f37',
  [Zone.Normal]: '#cfd9e4',
  [Zone.Wind]: '#9fb6d1',
  [Zone.Shelter]: '#a8ccb1',
};

export interface RenderOptions {
  mode: 'move' | 'mark';
  hover: { x: number; y: number } | null;
}

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建 2D 画布上下文');
    this.ctx = ctx;
  }

  resize(w: number, h: number): void {
    this.canvas.width = w * CELL;
    this.canvas.height = h * CELL;
  }

  cellFromPixel(px: number, py: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.floor(((px - rect.left) / rect.width) * this.canvas.width / CELL);
    const y = Math.floor(((py - rect.top) / rect.height) * this.canvas.height / CELL);
    return { x, y };
  }

  render(game: GameState, opts: RenderOptions): void {
    const { ctx } = this;
    const s = game.scenario;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    for (let y = 0; y < s.height; y++) {
      for (let x = 0; x < s.width; x++) {
        this.drawCell(game, x, y);
      }
    }

    this.drawScanRange(game);
    this.drawChain(game);
    this.drawHover(game, opts);
    this.drawPlayer(game);
    this.drawWindParticles(game);
  }

  private drawCell(game: GameState, x: number, y: number): void {
    const { ctx } = this;
    const zone = game.zoneAt(x, y);
    const px = x * CELL;
    const py = y * CELL;

    ctx.fillStyle = ZONE_COLORS[zone];
    ctx.fillRect(px, py, CELL, CELL);
    ctx.strokeStyle = ZONE_BORDER[zone];
    ctx.lineWidth = 1;
    ctx.strokeRect(px + 0.5, py + 0.5, CELL - 1, CELL - 1);

    if (zone === Zone.Block) {
      ctx.fillStyle = '#4c525f';
      ctx.beginPath();
      ctx.arc(px + CELL * 0.3, py + CELL * 0.35, 5, 0, Math.PI * 2);
      ctx.arc(px + CELL * 0.68, py + CELL * 0.6, 6, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    if (zone === Zone.Wind) {
      ctx.strokeStyle = 'rgba(90,120,160,0.35)';
      ctx.lineWidth = 1.2;
      for (let i = 0; i < 3; i++) {
        const yy = py + 10 + i * 12;
        ctx.beginPath();
        ctx.moveTo(px + 5, yy);
        ctx.lineTo(px + CELL - 5, yy - 3);
        ctx.stroke();
      }
    } else if (zone === Zone.Shelter) {
      ctx.fillStyle = 'rgba(70,120,80,0.5)';
      ctx.font = '10px sans-serif';
      ctx.fillText('背风', px + 4, py + 13);
    }

    // 未观察区域盖一层雾；观察过的格子才画足迹
    const observed = game.isObserved(x, y);
    const stack = game.impressions.get(game.key(x, y));
    if (stack) {
      if (observed) {
        this.drawFootprints(game, stack, px, py);
      } else {
        // 未观察：只给一点点「下面可能有东西」的雪面质感，不泄露信息
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.fillRect(px + 2, py + 2, CELL - 4, CELL - 4);
      }
    }

    if (!observed) {
      ctx.fillStyle = 'rgba(40,50,70,0.10)';
      ctx.fillRect(px, py, CELL, CELL);
    }
  }

  /** 画足迹栈：从旧到新画，新的压在上面；只剩浅痕的画虚圈 */
  private drawFootprints(
    game: GameState,
    stack: Impression[],
    px: number,
    py: number,
  ): void {
    const { ctx } = this;
    for (const imp of stack) {
      const vis = visibilityAt(imp, game.now);
      if (vis === Visibility.Gone) continue;
      const rest = remainingDepth(imp, game.now);
      const cx = px + CELL / 2;
      const cy = py + CELL / 2;
      const r = 7 + rest * 8;

      if (vis === Visibility.Trace) {
        ctx.strokeStyle = 'rgba(70,90,120,0.55)';
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        continue;
      }

      // 完整脚印：椭圆 + 方向箭头
      const alpha = 0.35 + rest * 0.55;
      ctx.fillStyle = `rgba(55,70,95,${alpha})`;
      ctx.beginPath();
      ctx.ellipse(cx, cy, r, r * 0.72, (imp.dir * Math.PI) / 2, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = `rgba(30,42,60,${alpha})`;
      ctx.lineWidth = 1.6;
      const [ax, ay] = dirArrow(imp.dir);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + ax, cy + ay);
      ctx.stroke();
    }

    // 叠踩标记：还有 ≥2 条可见足迹时显示序号点
    const visibleCount = stack.filter(
      (i) => visibilityAt(i, game.now) !== Visibility.Gone,
    ).length;
    if (visibleCount >= 2) {
      ctx.fillStyle = '#b5530f';
      ctx.font = 'bold 11px sans-serif';
      ctx.fillText(`${visibleCount}叠`, px + 3, py + CELL - 4);
    }
  }

  private drawScanRange(game: GameState): void {
    const { ctx } = this;
    ctx.strokeStyle = 'rgba(60,110,180,0.5)';
    ctx.lineWidth = 2;
    const x0 = (game.px - SCAN_RADIUS) * CELL;
    const y0 = (game.py - SCAN_RADIUS) * CELL;
    const size = (SCAN_RADIUS * 2 + 1) * CELL;
    ctx.strokeRect(x0, y0, size, size);
  }

  private drawChain(game: GameState): void {
    const { ctx } = this;
    let prev: { x: number; y: number } | null = null;
    let obsNumber = 0;
    game.chain.forEach((entry, i) => {
      if (entry.kind === 'gap') {
        const next = game.chain[i + 1];
        if (prev && next && next.kind === 'obs') {
          ctx.strokeStyle = 'rgba(200,90,30,0.85)';
          ctx.lineWidth = 2.5;
          ctx.setLineDash([5, 5]);
          ctx.beginPath();
          ctx.moveTo(prev.x * CELL + CELL / 2, prev.y * CELL + CELL / 2);
          ctx.lineTo(next.x * CELL + CELL / 2, next.y * CELL + CELL / 2);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        return;
      }
      if (prev) {
        const last = game.chain[i - 1];
        if (last && last.kind === 'obs') {
          ctx.strokeStyle = 'rgba(200,90,30,0.85)';
          ctx.lineWidth = 2.5;
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(prev.x * CELL + CELL / 2, prev.y * CELL + CELL / 2);
          ctx.lineTo(entry.x * CELL + CELL / 2, entry.y * CELL + CELL / 2);
          ctx.stroke();
        }
      }
      obsNumber++;
      const cx = entry.x * CELL + CELL / 2;
      const cy = entry.y * CELL + CELL / 2;
      ctx.fillStyle = 'rgba(200,90,30,0.92)';
      ctx.beginPath();
      ctx.arc(cx, cy, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(obsNumber), cx, cy + 0.5);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      prev = { x: entry.x, y: entry.y };
    });
  }

  private drawHover(game: GameState, opts: RenderOptions): void {
    if (!opts.hover) return;
    const { x, y } = opts.hover;
    if (game.zoneAt(x, y) === Zone.Block) return;
    const { ctx } = this;
    ctx.strokeStyle =
      opts.mode === 'mark' ? 'rgba(200,90,30,0.9)' : 'rgba(60,110,180,0.9)';
    ctx.lineWidth = 2.5;
    ctx.strokeRect(x * CELL + 2, y * CELL + 2, CELL - 4, CELL - 4);
  }

  private drawPlayer(game: GameState): void {
    const { ctx } = this;
    const cx = game.px * CELL + CELL / 2;
    const cy = game.py * CELL + CELL / 2;
    ctx.fillStyle = '#1f5fbf';
    ctx.beginPath();
    ctx.arc(cx, cy, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#0e3a7d';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#dce8ff';
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawWindParticles(game: GameState): void {
    const { ctx } = this;
    const t = game.now;
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    for (let y = 0; y < game.scenario.height; y++) {
      for (let x = 0; x < game.scenario.width; x++) {
        if (game.zoneAt(x, y) !== Zone.Wind) continue;
        const shift = (t * 1.5 + x * 9 + y * 13) % (CELL - 8);
        ctx.beginPath();
        ctx.moveTo(x * CELL + 4 + shift, y * CELL + 8);
        ctx.lineTo(x * CELL + 10 + shift, y * CELL + 7);
        ctx.stroke();
      }
    }
  }
}

function dirArrow(dir: Dir): [number, number] {
  const len = 12;
  switch (dir) {
    case Dir.N:
      return [0, -len];
    case Dir.E:
      return [len, 0];
    case Dir.S:
      return [0, len];
    case Dir.W:
      return [-len, 0];
  }
}

/** 供侧栏使用的文字描述 */
export function describeDepth(d: DepthLevel): string {
  return d === DepthLevel.Trace
    ? '浅痕（方向/深浅不可读）'
    : d === DepthLevel.Deep
      ? '深'
      : d === DepthLevel.Medium
        ? '中'
        : '浅';
}

export function describeDir(dir: Dir | null): string {
  return dir === null ? '不可读' : DIR_NAMES[dir];
}
