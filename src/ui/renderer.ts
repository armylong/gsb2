import type { Board } from '../engine/board';
import type { GameState, Mode } from '../engine/state';
import type { Cell, Direction } from '../types';

const CELL = 64;
const PAD = 24;

const COLORS = {
  bg: '#11151c',
  hidden: '#1d2430',
  hiddenLine: '#2c3647',
  wall: '#4b5568',
  wallTop: '#5d6a82',
  solid: '#3f7d5a',
  empty: '#8a3b3b',
  entry: '#4ea1ff',
  exit: '#ffb84e',
  lineProbe: '#7cc7ff',
  adjProbe: '#c79bff',
  coverage: 'rgba(124, 199, 255, 0.16)',
  coverageAdj: 'rgba(199, 155, 255, 0.18)',
  path: '#ffd166',
  safe: '#5fd38d',
  void: '#ff6b6b',
  unknown: '#e0c35c',
  hint: '#ffffff',
  text: '#e8edf5',
  hover: 'rgba(255,255,255,0.12)',
  bad: '#ff5a5a',
};

const DIR_TRI: Record<Direction, string> = {
  up: '▲',
  down: '▼',
  left: '◀',
  right: '▶',
};

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  readonly cellPx: number;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建 canvas 2d 上下文');
    this.ctx = ctx;
    this.cellPx = CELL;
  }

  sizeFor(rows: number, cols: number): { w: number; h: number } {
    return { w: cols * CELL + PAD * 2, h: rows * CELL + PAD * 2 };
  }

  /** 像素坐标 -> 格坐标 */
  pick(x: number, y: number): Cell | null {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    const px = (x - rect.left) * scaleX;
    const py = (y - rect.top) * scaleY;
    const c = Math.floor((px - PAD) / CELL);
    const r = Math.floor((py - PAD) / CELL);
    return { r, c };
  }

  cellXY(r: number, c: number): { x: number; y: number } {
    return { x: PAD + c * CELL, y: PAD + r * CELL };
  }

  render(
    state: GameState,
    board: Board,
    mode: Mode,
    hover: Cell | null,
    hintCell: Cell | null,
  ): void {
    const { ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = this.sizeFor(board.rows, board.cols);
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, w, h);

    const selected = state.records.find((r) => r.id === state.selectedRecordId);

    // 1) 先画选中读数的覆盖区（在格底色之下，方便重看历史结果）
    if (selected) {
      ctx.fillStyle = selected.type === 'line' ? COLORS.coverage : COLORS.coverageAdj;
      for (const p of selected.cells) this.fillCell(p.r, p.c);
    }

    // 2) 格子
    for (let r = 0; r < board.rows; r++) {
      for (let c = 0; c < board.cols; c++) {
        this.drawCell(state, board, r, c);
      }
    }

    // 3) 入口 / 出口（可进入的边）
    this.drawPort(state.level.entry, COLORS.entry, '入');
    this.drawPort(state.level.exit, COLORS.exit, '出');

    // 4) 通路
    this.drawPath(state);

    // 5) 探头与读数徽标
    for (const rec of state.records) this.drawProbe(rec);

    // 6) 标记
    for (const [key, marker] of state.markers) {
      const [r, c] = key.split(',').map(Number);
      this.drawMarker(r, c, marker);
    }

    // 7) 提示高亮
    if (hintCell && board.isOpen(hintCell.r, hintCell.c)) {
      const { x, y } = this.cellXY(hintCell.r, hintCell.c);
      ctx.strokeStyle = COLORS.hint;
      ctx.lineWidth = 3;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(x + 3, y + 3, CELL - 6, CELL - 6);
      ctx.setLineDash([]);
    }

    // 8) 悬停预览
    if (hover && board.isOpen(hover.r, hover.c) && !state.revealed) {
      this.drawHover(state, board, mode, hover);
    }
  }

  private fillCell(r: number, c: number): void {
    const { x, y } = this.cellXY(r, c);
    this.ctx.fillRect(x + 1, y + 1, CELL - 2, CELL - 2);
  }

  private drawCell(state: GameState, board: Board, r: number, c: number): void {
    const { ctx } = this;
    const { x, y } = this.cellXY(r, c);
    ctx.strokeStyle = COLORS.hiddenLine;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, CELL - 1, CELL - 1);

    if (board.isWall(r, c)) {
      ctx.fillStyle = COLORS.wall;
      ctx.fillRect(x + 2, y + 2, CELL - 4, CELL - 4);
      ctx.fillStyle = COLORS.wallTop;
      ctx.fillRect(x + 2, y + 2, CELL - 4, 8);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      for (let i = 0; i < 3; i++) ctx.fillRect(x + 10, y + 18 + i * 13, CELL - 20, 3);
      return;
    }

    if (state.revealed) {
      // 交卷后才展示底图
      const solid = board.kind(r, c) === 'solid';
      ctx.fillStyle = solid ? COLORS.solid : COLORS.empty;
      ctx.fillRect(x + 2, y + 2, CELL - 4, CELL - 4);
      ctx.fillStyle = COLORS.text;
      ctx.font = 'bold 18px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(solid ? '实' : '空', x + CELL / 2, y + CELL / 2);
    } else {
      ctx.fillStyle = COLORS.hidden;
      ctx.fillRect(x + 2, y + 2, CELL - 4, CELL - 4);
      ctx.strokeStyle = COLORS.hiddenLine;
      ctx.strokeRect(x + 2.5, y + 2.5, CELL - 5, CELL - 5);
    }
  }

  private drawPort(cell: Cell, color: string, label: string): void {
    const { ctx } = this;
    const { x, y } = this.cellXY(cell.r, cell.c);
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.strokeRect(x + 3, y + 3, CELL - 6, CELL - 6);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x + 12, y + 12, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0b0e14';
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + 12, y + 12.5);
  }

  private drawPath(state: GameState): void {
    const { ctx } = this;
    if (state.path.length === 0) return;
    ctx.strokeStyle = COLORS.path;
    ctx.lineWidth = 6;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    state.path.forEach((p, i) => {
      const { x, y } = this.cellXY(p.r, p.c);
      const cx = x + CELL / 2;
      const cy = y + CELL / 2;
      if (i === 0) ctx.moveTo(cx, cy);
      else ctx.lineTo(cx, cy);
    });
    ctx.stroke();
    for (const p of state.path) {
      const { x, y } = this.cellXY(p.r, p.c);
      ctx.fillStyle = COLORS.path;
      ctx.beginPath();
      ctx.arc(x + CELL / 2, y + CELL / 2, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawProbe(rec: {
    id: number;
    r: number;
    c: number;
    type: 'line' | 'adjacency';
    dir?: Direction;
    reading: number;
  }): void {
    const { ctx } = this;
    const { x, y } = this.cellXY(rec.r, rec.c);
    const color = rec.type === 'line' ? COLORS.lineProbe : COLORS.adjProbe;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x + CELL - 14, y + 14, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0b0e14';
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const symbol = rec.type === 'line' ? DIR_TRI[rec.dir ?? 'right'] : '邻';
    ctx.fillText(symbol, x + CELL - 14, y + 14.5);

    // 读数徽标放在格中心偏下
    ctx.fillStyle = 'rgba(11,14,20,0.85)';
    const text = rec.type === 'line' ? `${rec.reading}` : rec.reading === 1 ? '有洞' : '安全';
    ctx.font = 'bold 13px system-ui, sans-serif';
    const tw = ctx.measureText(text).width + 12;
    ctx.fillRect(x + CELL / 2 - tw / 2, y + CELL - 22, tw, 17);
    ctx.fillStyle = color;
    ctx.fillText(text, x + CELL / 2, y + CELL - 13.5);
  }

  private drawMarker(r: number, c: number, marker: string): void {
    const { ctx } = this;
    const { x, y } = this.cellXY(r, c);
    const color =
      marker === 'safe' ? COLORS.safe : marker === 'void' ? COLORS.void : COLORS.unknown;
    const label = marker === 'safe' ? '安' : marker === 'void' ? '洞' : '?';
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x + 14, y + CELL - 14, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0b0e14';
    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + 14, y + CELL - 13.5);
  }

  private drawHover(state: GameState, board: Board, mode: Mode, hover: Cell): void {
    const { ctx } = this;
    const { x, y } = this.cellXY(hover.r, hover.c);
    ctx.fillStyle = COLORS.hover;
    ctx.fillRect(x + 2, y + 2, CELL - 4, CELL - 4);

    if (mode === 'line') {
      // 预览这条方向探测将覆盖哪些格（撞墙即停）
      const cells = board.lineCells(hover.r, hover.c, state.direction);
      ctx.fillStyle = COLORS.coverage;
      for (const p of cells) this.fillCell(p.r, p.c);
      ctx.fillStyle = COLORS.lineProbe;
      ctx.font = 'bold 16px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(DIR_TRI[state.direction], x + CELL / 2, y + CELL / 2);
    } else if (mode === 'adjacency') {
      const cells = board.adjacencyCells(hover.r, hover.c);
      ctx.fillStyle = COLORS.coverageAdj;
      for (const p of cells) this.fillCell(p.r, p.c);
      ctx.fillStyle = COLORS.adjProbe;
      ctx.font = 'bold 14px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('邻', x + CELL / 2, y + CELL / 2);
    } else if (mode === 'path') {
      ctx.strokeStyle = COLORS.path;
      ctx.lineWidth = 3;
      ctx.strokeRect(x + 4, y + 4, CELL - 8, CELL - 8);
    } else {
      const color =
        mode === 'mark-safe' ? COLORS.safe : mode === 'mark-void' ? COLORS.void : COLORS.unknown;
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.strokeRect(x + 4, y + 4, CELL - 8, CELL - 8);
    }
  }

  /** 交卷失败时把踩空的格标红闪一下 */
  drawFailureCell(cell: Cell): void {
    const { ctx } = this;
    const { x, y } = this.cellXY(cell.r, cell.c);
    ctx.strokeStyle = COLORS.bad;
    ctx.lineWidth = 5;
    ctx.strokeRect(x + 3, y + 3, CELL - 6, CELL - 6);
  }
}
