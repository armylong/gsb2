import { colorCss } from '../core/palette';
import type { CellAssessment, Coord, Evaluation, GameState, LevelDef, Orientation } from '../core/types';
import type { StampPreview } from '../core/game';
import { mapHoles } from '../core/geometry';
import { colorOfLayers, indexOf } from '../core/game';

export interface BoardView {
  game: GameState;
  evaluation: Evaluation;
  stencilId: string;
  orientation: Orientation;
  pivot: Coord;
  /** 鼠标所在格；null 表示未悬停。 */
  hover: Coord | null;
  /** 点击选中的格子，用于详情面板。 */
  selected: Coord | null;
  /** 是否显示样图提示层。 */
  showPlan: boolean;
  /** 当前鼠标位置的盖印预览。 */
  preview: StampPreview | null;
  /** 是否给预览孔位填色（仅悬停、定格预演或演示时）；否则只画虚线足迹。 */
  fillPreview: boolean;
  /** 不落墨的预演闪光：显示这一印盖下后的颜色。 */
  demoPreview: boolean;
  /** 失败判定的高亮（仅在判定失败或定格预演时开启）。 */
  emphasizeErrors: boolean;
  /** 是否画模板定位点准星。 */
  showPivot: boolean;
}

export interface BoardMetrics {
  cell: number;
  margin: number;
  width: number;
  height: number;
  dpr: number;
}

export function computeMetrics(level: LevelDef, availableWidth: number, availableHeight = Infinity): BoardMetrics {
  // 窄屏优先铺满宽度；宽松的桌面布局才按高度收，保证整盘尽量在一屏内。
  const compact = availableWidth < 560;
  const marginCells = compact ? 0.85 : 1.15;
  const widthTarget = Math.min(Math.max(availableWidth, 300), 760);
  const widthCell = widthTarget / (level.width + marginCells * 2);
  const heightCell = Number.isFinite(availableHeight) && !compact
    ? Math.max(availableHeight, 260) / (level.height + marginCells * 2)
    : Infinity;
  const cell = Math.max(24, Math.floor(Math.min(widthCell, heightCell)));
  const margin = Math.round(cell * marginCells);
  return {
    cell,
    margin,
    width: cell * level.width + margin * 2,
    height: cell * level.height + margin * 2,
    dpr: Math.min(window.devicePixelRatio || 1, 2.5),
  };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function paperTexture(ctx: CanvasRenderingContext2D, m: BoardMetrics, level: LevelDef): void {
  ctx.fillStyle = colorCss(level, level.paperColor);
  ctx.fillRect(0, 0, m.width, m.height);

  const g = ctx.createLinearGradient(0, 0, m.width, m.height);
  g.addColorStop(0, 'rgba(255,255,255,0.35)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.05)');
  g.addColorStop(1, 'rgba(88,63,35,0.08)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, m.width, m.height);

  // 固定种子的细碎纸纹，重绘时不会闪烁。
  let seed = 20260214;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  ctx.save();
  for (let i = 0; i < 900; i += 1) {
    const x = rand() * m.width;
    const y = rand() * m.height;
    const a = 0.02 + rand() * 0.05;
    ctx.fillStyle = rand() > 0.5 ? `rgba(120,92,55,${a})` : `rgba(255,255,255,${a * 1.6})`;
    ctx.fillRect(x, y, 1.2, 1.2);
  }
  ctx.restore();
}

function drawCoordinates(ctx: CanvasRenderingContext2D, m: BoardMetrics, level: LevelDef): void {
  ctx.save();
  ctx.fillStyle = 'rgba(74, 57, 35, 0.42)';
  ctx.font = `${Math.max(9, Math.round(m.cell * 0.24))}px "Avenir Next", "PingFang SC", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let x = 0; x < level.width; x += 1) {
    ctx.fillText(String.fromCharCode(65 + x), m.margin + x * m.cell + m.cell / 2, m.margin * 0.55);
  }
  for (let y = 0; y < level.height; y += 1) {
    ctx.fillText(String(y + 1), m.margin * 0.55, m.margin + y * m.cell + m.cell / 2);
  }
  ctx.restore();
}

function cellRect(m: BoardMetrics, c: Coord): { x: number; y: number; w: number; h: number } {
  return { x: m.margin + c.x * m.cell, y: m.margin + c.y * m.cell, w: m.cell, h: m.cell };
}

function iconText(ctx: CanvasRenderingContext2D, symbol: string, cx: number, cy: number, size: number, color: string): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.font = `${size}px "PingFang SC", "Avenir Next", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(symbol, cx, cy);
  ctx.restore();
}

function drawPlanMarks(
  ctx: CanvasRenderingContext2D,
  m: BoardMetrics,
  level: LevelDef,
  assessment: CellAssessment,
  showPlan: boolean,
): void {
  const rect = cellRect(m, { x: assessment.x, y: assessment.y });
  const pad = Math.max(2, m.cell * 0.055);
  if (assessment.requirement === 'clean') {
    if (!showPlan) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x + pad, rect.y + pad, rect.w - pad * 2, rect.h - pad * 2);
    ctx.clip();
    ctx.strokeStyle = 'rgba(89, 70, 44, 0.13)';
    ctx.lineWidth = 1;
    const step = Math.max(5, m.cell * 0.15);
    for (let d = -rect.h; d < rect.w; d += step) {
      ctx.beginPath();
      ctx.moveTo(rect.x + d, rect.y + rect.h);
      ctx.lineTo(rect.x + d + rect.h, rect.y);
      ctx.stroke();
    }
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = 'rgba(89, 70, 44, 0.2)';
    ctx.setLineDash([2, 3]);
    ctx.lineWidth = 1;
    ctx.strokeRect(rect.x + pad, rect.y + pad, rect.w - pad * 2, rect.h - pad * 2);
    ctx.restore();
    return;
  }
  if (assessment.requirement === 'exact' && assessment.targetColor && showPlan) {
    const target = level.palette.find((p) => p.id === assessment.targetColor);
    if (!target) return;
    ctx.save();
    // 样图的“淡印”底色：真正的墨层会完全覆盖它。
    ctx.globalAlpha = 0.075;
    ctx.fillStyle = target.css;
    ctx.fillRect(rect.x + 1, rect.y + 1, rect.w - 2, rect.h - 2);
    ctx.globalAlpha = 1;
    // 右下角的目标色小样与符号。
    const size = Math.max(9, Math.round(m.cell * 0.26));
    const bx = rect.x + rect.w - pad - size;
    const by = rect.y + rect.h - pad - size;
    ctx.beginPath();
    roundRect(ctx, bx, by, size, size, size * 0.24);
    ctx.fillStyle = 'rgba(255, 252, 245, 0.9)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(74, 57, 35, 0.28)';
    ctx.lineWidth = 0.8;
    ctx.stroke();
    ctx.fillStyle = target.css;
    ctx.font = `${Math.round(size * 0.72)}px "PingFang SC", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(target.symbol, bx + size / 2, by + size / 2 + 0.5);
    ctx.restore();
  }
}

function drawBadge(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, fill: string, text: string, textColor: string): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 1;
  ctx.stroke();
  iconText(ctx, text, cx, cy + 0.5, r * 1.15, textColor);
  ctx.restore();
}

export function drawBoard(canvas: HTMLCanvasElement, m: BoardMetrics, level: LevelDef, view: BoardView): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const pixelWidth = Math.round(m.width * m.dpr);
  const pixelHeight = Math.round(m.height * m.dpr);
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  canvas.style.width = `${m.width}px`;
  canvas.style.height = `${m.height}px`;
  ctx.setTransform(m.dpr, 0, 0, m.dpr, 0, 0);
  ctx.clearRect(0, 0, m.width, m.height);

  paperTexture(ctx, m, level);
  drawCoordinates(ctx, m, level);

  const stencil = level.stencils.find((s) => s.id === view.stencilId);
  const previewHoles = view.preview?.holes ?? null;
  const previewIndex = new Map<string, { masked: boolean; onBoard: boolean; afterColor: string | null; clean: boolean }>();
  if (previewHoles) {
    for (const hole of previewHoles) {
      previewIndex.set(`${hole.target.x},${hole.target.y}`, {
        masked: hole.masked,
        onBoard: hole.onBoard,
        afterColor: hole.afterColor,
        clean: hole.clean,
      });
    }
  }

  // 棋盘底格
  for (let y = 0; y < level.height; y += 1) {
    for (let x = 0; x < level.width; x += 1) {
      const idx = indexOf(level, x, y);
      const cell = view.game.cells[idx]!;
      const assessment = view.evaluation.cells[idx]!;
      const color = colorOfLayers(level, cell.layers);
      const entry = level.palette.find((p) => p.id === color)!;
      const rect = cellRect(m, { x, y });
      const inset = 1;
      ctx.fillStyle = entry.css;
      ctx.fillRect(rect.x + inset, rect.y + inset, rect.w - inset * 2, rect.h - inset * 2);

      // 轻微的手工套印错位感：只在有色格上叠一层极淡的同色偏移。
      if (cell.layers.length > 0) {
        ctx.save();
        ctx.globalAlpha = 0.16;
        ctx.fillStyle = colorCss(level, color);
        ctx.beginPath();
        ctx.arc(rect.x + rect.w * 0.36, rect.y + rect.h * 0.34, rect.w * 0.46, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      if (entry.inkOn === 'light') {
        ctx.fillStyle = 'rgba(255,255,255,0.16)';
        ctx.fillRect(rect.x + 1, rect.y + 1, rect.w - 2, 1);
      }

      drawPlanMarks(ctx, m, level, assessment, view.showPlan);

      // 当前颜色符号（色弱辅助）
      if (cell.layers.length > 0) {
        const size = Math.max(9, Math.round(m.cell * 0.26));
        iconText(ctx, entry.symbol, rect.x + rect.w * 0.24, rect.y + rect.h * 0.24, size, entry.inkOn === 'light' ? 'rgba(255,255,255,0.72)' : 'rgba(46,32,18,0.55)');
      }

      ctx.strokeStyle = 'rgba(69, 52, 31, 0.16)';
      ctx.lineWidth = 1;
      ctx.strokeRect(rect.x + inset, rect.y + inset, rect.w - inset * 2, rect.h - inset * 2);

      // 挡墨纸
      if (view.game.mask[idx]) {
        ctx.save();
        ctx.fillStyle = 'rgba(246, 240, 224, 0.88)';
        ctx.fillRect(rect.x + 1, rect.y + 1, rect.w - 2, rect.h - 2);
        ctx.strokeStyle = 'rgba(107, 86, 57, 0.5)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(rect.x + 4, rect.y + 4, rect.w - 8, rect.h - 8);
        ctx.restore();
        iconText(ctx, '▨', rect.x + rect.w / 2, rect.y + rect.h / 2, Math.max(12, m.cell * 0.38), 'rgba(89, 69, 43, 0.62)');
      }

      // 盖印预览：本次孔位与盖上去后的颜色
      const hole = previewIndex.get(`${x},${y}`);
      if (hole && hole.onBoard) {
        ctx.save();
        if (hole.masked) {
          ctx.strokeStyle = 'rgba(74, 57, 35, 0.62)';
          ctx.setLineDash([3, 3]);
          ctx.lineWidth = 1.4;
          ctx.strokeRect(rect.x + 4, rect.y + 4, rect.w - 8, rect.h - 8);
          iconText(ctx, '挡', rect.x + rect.w / 2, rect.y + rect.h / 2, Math.max(10, m.cell * 0.26), 'rgba(74,57,35,0.7)');
        } else {
          const after = hole.afterColor ? level.palette.find((p) => p.id === hole.afterColor) : null;
          if (view.fillPreview && after) {
            ctx.globalAlpha = view.demoPreview ? 0.94 : 0.62;
            ctx.fillStyle = after.css;
            ctx.fillRect(rect.x + 2, rect.y + 2, rect.w - 4, rect.h - 4);
            ctx.globalAlpha = 1;
          }
          ctx.strokeStyle = hole.clean ? '#b1432f' : view.fillPreview ? 'rgba(255,255,255,0.95)' : 'rgba(183, 87, 58, 0.85)';
          ctx.lineWidth = hole.clean ? 2.4 : view.fillPreview ? 2 : 1.4;
          ctx.setLineDash(view.fillPreview ? [] : [4, 3]);
          roundRect(ctx, rect.x + 3, rect.y + 3, rect.w - 6, rect.h - 6, 3);
          ctx.stroke();
          ctx.setLineDash([]);
          if (view.fillPreview && after) {
            const size = Math.max(9, Math.round(m.cell * 0.26));
            iconText(ctx, hole.clean ? '✕' : after.symbol, rect.x + rect.w / 2, rect.y + rect.h / 2, size + (hole.clean ? 4 : 0), hole.clean ? '#fff4ef' : after.inkOn === 'light' ? '#fff8f0' : '#33261a');
          }
        }
        ctx.restore();
      }
    }
  }

  // 出界孔：贴在纸边外侧的窄条里，避免遮住行列坐标。
  if (stencil) {
    const holeCoords = mapHoles(stencil, view.pivot, view.orientation);
    const boardLeft = m.margin;
    const boardTop = m.margin;
    const boardRight = m.margin + m.cell * level.width;
    const boardBottom = m.margin + m.cell * level.height;
    const size = Math.max(9, m.cell * 0.3);
    const band = Math.max(2, m.margin * 0.14);
    const seen = new Set<string>();
    for (const h of holeCoords) {
      if (h.x >= 0 && h.y >= 0 && h.x < level.width && h.y < level.height) continue;
      const raw = cellRect(m, h);
      const rawCx = raw.x + raw.w / 2;
      const rawCy = raw.y + raw.h / 2;
      let x: number;
      let y: number;
      if (rawCx < boardLeft) x = band;
      else if (rawCx > boardRight) x = m.width - band - size;
      else x = Math.min(Math.max(rawCx - size / 2, band), m.width - band - size);
      if (rawCy < boardTop) y = band;
      else if (rawCy > boardBottom) y = m.height - band - size;
      else y = Math.min(Math.max(rawCy - size / 2, band), m.height - band - size);
      const key = `${Math.round(x)},${Math.round(y)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = 'rgba(158, 72, 52, 0.85)';
      ctx.setLineDash([3, 2]);
      ctx.lineWidth = 1.2;
      roundRect(ctx, x, y, size, size, 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(158, 72, 52, 0.95)';
      ctx.lineWidth = 1.4;
      const inset = size * 0.28;
      ctx.beginPath();
      ctx.moveTo(x + inset, y + inset);
      ctx.lineTo(x + size - inset, y + size - inset);
      ctx.moveTo(x + size - inset, y + inset);
      ctx.lineTo(x + inset, y + size - inset);
      ctx.stroke();
      ctx.restore();
    }
  }

  // 错误标记：错色与沾墨保留格
  if (view.emphasizeErrors) {
    for (const cell of view.evaluation.cells) {
      const isMismatch = cell.requirement === 'exact' && !cell.exact;
      const isDirty = cell.requirement === 'clean' && cell.cleanViolated;
      if (!isMismatch && !isDirty) continue;
      const rect = cellRect(m, cell);
      ctx.save();
      ctx.strokeStyle = isDirty ? '#a3261b' : '#b3642a';
      ctx.lineWidth = 2.2;
      ctx.setLineDash(isDirty ? [] : [5, 3]);
      roundRect(ctx, rect.x + 2, rect.y + 2, rect.w - 4, rect.h - 4, 3);
      ctx.stroke();
      ctx.restore();
      if (isDirty) {
        drawBadge(ctx, rect.x + rect.w - 10, rect.y + 10, Math.max(7, m.cell * 0.15), '#a3261b', '✕', '#fff4ef');
      }
    }
  }

  // 选中与悬停
  if (view.selected) {
    const rect = cellRect(m, view.selected);
    ctx.save();
    ctx.strokeStyle = 'rgba(58, 92, 112, 0.9)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 3]);
    ctx.strokeRect(rect.x + 1, rect.y + 1, rect.w - 2, rect.h - 2);
    ctx.restore();
  }
  if (view.hover) {
    const rect = cellRect(m, view.hover);
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 2;
    ctx.strokeRect(rect.x + 1, rect.y + 1, rect.w - 2, rect.h - 2);
    ctx.restore();
  }

  // 模板定位点十字准星
  if (view.showPivot) {
    const rect = cellRect(m, view.pivot);
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(3, m.cell * 0.09), 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(52,42,28,0.55)';
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(5, m.cell * 0.14), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // 纸边压痕
  ctx.save();
  ctx.strokeStyle = 'rgba(60, 44, 24, 0.15)';
  ctx.lineWidth = 1;
  ctx.strokeRect(m.margin, m.margin, m.cell * level.width, m.cell * level.height);
  ctx.restore();

}

/** 墨色卡与模板卡上的小图标。 */
export function drawStencilIcon(canvas: HTMLCanvasElement, level: LevelDef, stencilId: string, orientation: Orientation, pivot = { x: 0, y: 0 }, accent = '#3b2f21'): void {
  const stencil = level.stencils.find((s) => s.id === stencilId);
  const ctx = canvas.getContext('2d');
  if (!stencil || !ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const size = 58;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  const cells = mapHoles(stencil, { x: 0, y: 0 }, orientation).map((c) => ({ x: c.x + pivot.x, y: c.y + pivot.y }));
  const minX = Math.min(...cells.map((c) => c.x));
  const maxX = Math.max(...cells.map((c) => c.x));
  const minY = Math.min(...cells.map((c) => c.y));
  const maxY = Math.max(...cells.map((c) => c.y));
  const cols = maxX - minX + 1;
  const rows = maxY - minY + 1;
  const cellSize = Math.min(44 / cols, 44 / rows, 12);
  const ox = (size - cols * cellSize) / 2;
  const oy = (size - rows * cellSize) / 2;
  ctx.fillStyle = accent;
  for (const c of cells) {
    const x = ox + (c.x - minX) * cellSize;
    const y = oy + (c.y - minY) * cellSize;
    roundRect(ctx, x + 1, y + 1, cellSize - 2, cellSize - 2, 2);
    ctx.fill();
  }
  if (cells.some((c) => c.x === 0 && c.y === 0)) {
    ctx.strokeStyle = '#f4ead5';
    ctx.lineWidth = 1.2;
    const x = ox + (0 - minX) * cellSize + cellSize / 2;
    const y = oy + (0 - minY) * cellSize + cellSize / 2;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(2, cellSize * 0.17), 0, Math.PI * 2);
    ctx.stroke();
  }
}

export function drawCellSwatch(canvas: HTMLCanvasElement, level: LevelDef, color: string): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const size = 26;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  const entry = level.palette.find((p) => p.id === color);
  if (!entry) return;
  roundRect(ctx, 1, 1, size - 2, size - 2, 5);
  ctx.fillStyle = entry.css;
  ctx.fill();
  ctx.strokeStyle = 'rgba(48,35,20,0.25)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = entry.inkOn === 'light' ? 'rgba(255,255,255,0.85)' : 'rgba(43,32,18,0.72)';
  ctx.font = `${Math.round(size * 0.5)}px "PingFang SC", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(entry.symbol, size / 2, size / 2 + 0.5);
}


/** 样图缩略图：给玩家一张可对照的“成品小样”。 */
export function drawPlanThumbnail(canvas: HTMLCanvasElement, level: LevelDef, evaluation?: Evaluation): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const size = Math.round(Math.min(22, 150 / level.width));
  const gap = 2;
  const pad = 8;
  const width = level.width * (size + gap) - gap + pad * 2;
  const height = level.height * (size + gap) - gap + pad * 2;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.42)';
  roundRect(ctx, 0, 0, width, height, 8);
  ctx.fill();
  for (let y = 0; y < level.height; y += 1) {
    for (let x = 0; x < level.width; x += 1) {
      const token = level.plan[y]![x]!;
      const px = pad + x * (size + gap);
      const py = pad + y * (size + gap);
      const assessment = evaluation?.cells[y * level.width + x];
      ctx.save();
      roundRect(ctx, px, py, size, size, 4);
      if (token === 'free') {
        ctx.fillStyle = 'rgba(255, 251, 242, 0.9)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(96, 74, 45, 0.1)';
        ctx.lineWidth = 1;
        ctx.stroke();
      } else if (token === 'clean') {
        ctx.fillStyle = '#f6efdf';
        ctx.fill();
        ctx.strokeStyle = 'rgba(96, 74, 45, 0.22)';
        ctx.setLineDash([2, 2]);
        ctx.stroke();
        ctx.clip();
        ctx.strokeStyle = 'rgba(96, 74, 45, 0.16)';
        for (let d = -size; d < size * 2; d += 5) {
          ctx.beginPath();
          ctx.moveTo(px + d, py + size);
          ctx.lineTo(px + d + size, py);
          ctx.stroke();
        }
      } else {
        const entry = level.palette.find((p) => p.id === token)!;
        ctx.fillStyle = entry.css;
        ctx.fill();
        ctx.strokeStyle = 'rgba(48, 35, 20, 0.18)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = entry.inkOn === 'light' ? 'rgba(255,255,255,0.82)' : 'rgba(43,32,18,0.62)';
        ctx.font = `${Math.round(size * 0.52)}px "PingFang SC", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(entry.symbol, px + size / 2, py + size / 2 + 0.5);
      }
      ctx.restore();
      if (assessment) {
        const wrong = (assessment.requirement === 'exact' && !assessment.exact) || assessment.cleanViolated;
        if (wrong) {
          ctx.save();
          ctx.strokeStyle = '#a3261b';
          ctx.lineWidth = 1.6;
          roundRect(ctx, px + 0.5, py + 0.5, size - 1, size - 1, 4);
          ctx.stroke();
          ctx.restore();
        }
      }
    }
  }
}
