import { RULES } from '../engine/rules';
import { tideLevel, ticksUntilClosed, ticksUntilOpen } from '../engine/tide';
import { carriesHeavy, cellDryAt, edgeUsableAt, moveDuration } from '../engine/engine';
import type { HintPlan } from '../engine/planner';
import type { CellDef, LevelDef, RunStatus } from '../engine/types';
import type { SimState } from '../engine/engine';

export const CANVAS_W = 900;
export const CANVAS_H = 640;
const MARGIN = 90;
const CELL_R = 34;

const COLORS = {
  bg: '#0e1720',
  water: '#1d4e6e',
  waterDeep: '#143750',
  edgeDry: '#d8c9a3',
  edgeFlood: '#3d5a6c',
  edgeHeavyBlock: '#7a4a3a',
  cell: '#243444',
  cellDry: '#3a5a48',
  cellHome: '#5a4a2a',
  text: '#e8eef2',
  dim: '#8aa0ae',
  light: '#f0d878',
  heavy: '#c98a5a',
  danger: '#e0665a',
  hint: '#6fd3c8',
  player: '#e8f4ff',
};

function cellCenter(level: LevelDef, cell: CellDef): { x: number; y: number } {
  const maxX = Math.max(...level.cells.map((c) => c.x));
  const maxY = Math.max(...level.cells.map((c) => c.y));
  const sx = (CANVAS_W - MARGIN * 2) / Math.max(1, maxX);
  const sy = (CANVAS_H - MARGIN * 2) / Math.max(1, maxY);
  return { x: MARGIN + cell.x * sx, y: MARGIN + cell.y * sy };
}

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

function statusColor(status: RunStatus): string {
  switch (status) {
    case 'success':
      return '#7fc48a';
    case 'stranded':
      return COLORS.danger;
    case 'ruined':
      return '#b07cd8';
    default:
      return COLORS.text;
  }
}

export function drawScene(
  ctx: CanvasRenderingContext2D,
  state: SimState,
  level: LevelDef,
  hint: HintPlan | null,
  showHint: boolean,
): void {
  const t = state.tick;
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // 背景水位带：用整体蓝色深浅提示当前潮位
  const levelNow = tideLevel(t, level.tidePeriod);
  const waterAlpha = 0.08 + (levelNow / 4) * 0.22;
  ctx.fillStyle = `rgba(29,78,110,${waterAlpha})`;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  const heavy = carriesHeavy(state);
  const hintCells = new Set<string>();
  const hintEdges = new Set<string>();
  if (showHint && hint) {
    let cur = state.cellId;
    for (const step of hint.steps) {
      if (step.type === 'move' && step.targetCell) {
        hintEdges.add([cur, step.targetCell].sort().join('-'));
        hintCells.add(step.targetCell);
        cur = step.targetCell;
      }
    }
  }

  // —— 先画路 ——
  for (const edge of level.edges) {
    const a = level.cells.find((c) => c.id === edge.a)!;
    const b = level.cells.find((c) => c.id === edge.b)!;
    const pa = cellCenter(level, a);
    const pb = cellCenter(level, b);
    const usable = edgeUsableAt(level, edge, heavy, t);
    const heavyBlocked = heavy && edge.height <= RULES.HEAVY_MIN_EDGE_HEIGHT;
    const edgeKey = [edge.a, edge.b].sort().join('-');
    const hinted = hintEdges.has(edgeKey);

    ctx.save();
    ctx.lineWidth = hinted ? 7 : 5;
    if (hinted) {
      ctx.strokeStyle = COLORS.hint;
      ctx.shadowColor = COLORS.hint;
      ctx.shadowBlur = 10;
    } else if (heavyBlocked) {
      ctx.strokeStyle = COLORS.edgeHeavyBlock;
      ctx.setLineDash([7, 6]);
    } else if (usable) {
      ctx.strokeStyle = COLORS.edgeDry;
    } else {
      ctx.strokeStyle = COLORS.edgeFlood;
      ctx.setLineDash([4, 7]);
    }
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
    ctx.restore();

    // 路中段标签：高程 + 到下次封路 / 重新露出的时间
    const mx = (pa.x + pb.x) / 2;
    const my = (pa.y + pb.y) / 2;
    const closes = ticksUntilClosed(t, edge.height, level.tidePeriod);
    const opens = ticksUntilOpen(t, edge.height, level.tidePeriod);
    let tag: string;
    if (heavyBlocked) tag = `h${edge.height} 负重禁行`;
    else if (closes !== null && closes > 0) tag = `h${edge.height} 还剩${fmt(Math.ceil(closes))}刻封`;
    else if (opens !== null && opens > 0) tag = `h${edge.height} ${fmt(Math.ceil(opens))}刻后露`;
    else tag = `h${edge.height}`;
    drawPill(ctx, mx, my - 12, tag, usable && !heavyBlocked ? COLORS.edgeDry : COLORS.dim, hinted);
    if (edge.note) drawPill(ctx, mx, my + 10, edge.note, COLORS.dim, false, 11);
  }

  // —— 再画格子 ——
  for (const cell of level.cells) {
    const p = cellCenter(level, cell);
    const dry = cellDryAt(level, cell.id, t);
    const isHome = cell.id === level.home;
    const hinted = hintCells.has(cell.id);

    ctx.save();
    if (hinted) {
      ctx.shadowColor = COLORS.hint;
      ctx.shadowBlur = 14;
    }
    ctx.fillStyle = isHome ? COLORS.cellHome : dry ? COLORS.cellDry : COLORS.cell;
    ctx.beginPath();
    ctx.arc(p.x, p.y, CELL_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = hinted ? COLORS.hint : COLORS.dim;
    ctx.stroke();
    ctx.restore();

    // 格子编号 / 名称 / 高程
    ctx.fillStyle = COLORS.text;
    ctx.font = 'bold 15px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${cell.name} ${cell.id}`, p.x, p.y - 8);
    ctx.font = '12px sans-serif';
    ctx.fillStyle = COLORS.dim;
    ctx.fillText(`高程 h${cell.height}`, p.x, p.y + 8);

    // 每格能看见的水位 + 到下次封路时间（取该格相邻路中最快封的）
    const visible = fmt(Math.round(levelNow * 10) / 10);
    const incident = level.edges.filter((e) => e.a === cell.id || e.b === cell.id);
    const closeVals = incident
      .map((e) => ticksUntilClosed(t, e.height, level.tidePeriod))
      .filter((v): v is number => v !== null && v > 0);
    const nextClose = closeVals.length ? Math.min(...closeVals) : null;
    ctx.font = '12px sans-serif';
    ctx.fillStyle = dry ? COLORS.text : COLORS.danger;
    const closeText = nextClose === null ? '无路将封' : `${Math.ceil(nextClose)}刻后封路`;
    ctx.fillText(`水位${visible} · ${dry ? closeText : '已上水'}`, p.x, p.y + CELL_R + 16);

    // 信片
    const cards = level.postcards.filter((pc) => state.loose[pc.id] === cell.id);
    cards.forEach((pc, i) => {
      const cx = p.x + (i === 0 ? -12 : 12);
      const cy = p.y - CELL_R - 6;
      ctx.fillStyle = pc.kind === 'light' ? COLORS.light : COLORS.heavy;
      ctx.fillRect(cx - 8, cy - 6, 16, 12);
      ctx.strokeStyle = COLORS.bg;
      ctx.strokeRect(cx - 8, cy - 6, 16, 12);
      ctx.fillStyle = COLORS.bg;
      ctx.font = 'bold 10px sans-serif';
      ctx.fillText(pc.kind === 'light' ? '轻' : '重', cx, cy + 4);
    });
    if (isHome) {
      ctx.fillStyle = COLORS.light;
      ctx.font = '12px sans-serif';
      ctx.fillText('📮 信箱', p.x, p.y + CELL_R + 32);
    }
  }

  // —— 爬虫（在当前格上） ——
  const curCell = level.cells.find((c) => c.id === state.cellId)!;
  const pp = cellCenter(level, curCell);
  ctx.save();
  ctx.fillStyle = COLORS.player;
  ctx.shadowColor = '#9fd0ff';
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.arc(pp.x, pp.y, 9, 0, Math.PI * 2);
  ctx.fill();
  // 携带指示
  if (state.carried.length) {
    ctx.fillStyle = state.carried.some((id) => level.postcards.find((p) => p.id === id)?.kind === 'heavy')
      ? COLORS.heavy
      : COLORS.light;
    ctx.beginPath();
    ctx.arc(pp.x + 10, pp.y - 10, 5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // —— 状态角标 ——
  ctx.textAlign = 'left';
  ctx.font = 'bold 16px sans-serif';
  ctx.fillStyle = statusColor(state.status);
  const statusText: Record<RunStatus, string> = {
    running: `进行中 t=${t}`,
    success: `交件成功 · 总耗时 ${state.tick} 刻`,
    stranded: `被困失败 · t=${t}`,
    ruined: `信片损毁 · t=${t}`,
  };
  ctx.fillText(statusText[state.status], 20, 30);
  ctx.font = '12px sans-serif';
  ctx.fillStyle = COLORS.dim;
  ctx.fillText(
    `跨格${moveDuration(state)}刻/格（负重${RULES.HEAVY_MOVE_TICKS}） · 连续受淹${state.wetTicks}/${RULES.STRANDED_WET_TICKS} · 打断${state.interruptCount}次 · 累计等待${state.waitedTicks}刻`,
    20,
    52,
  );
}

function drawPill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  color: string,
  strong: boolean,
  fontSize = 12,
): void {
  ctx.save();
  ctx.font = `${strong ? 'bold ' : ''}${fontSize}px sans-serif`;
  const w = ctx.measureText(text).width + 10;
  ctx.fillStyle = 'rgba(14,23,32,0.82)';
  ctx.fillRect(x - w / 2, y - 9, w, 16);
  ctx.strokeStyle = strong ? color : 'transparent';
  ctx.strokeRect(x - w / 2, y - 9, w, 16);
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.fillText(text, x, y + 3);
  ctx.restore();
}

/** 点击命中检测：返回格子 id 或 null */
export function pickCell(level: LevelDef, x: number, y: number): string | null {
  for (const cell of level.cells) {
    const p = cellCenter(level, cell);
    if (Math.hypot(x - p.x, y - p.y) <= CELL_R + 6) return cell.id;
  }
  return null;
}

/** 顶部潮汐曲线小图 */
export function drawTideStrip(ctx: CanvasRenderingContext2D, level: LevelDef, tick: number, x: number, y: number, w: number, h: number): void {
  ctx.save();
  ctx.fillStyle = 'rgba(14,23,32,0.9)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = COLORS.dim;
  ctx.strokeRect(x, y, w, h);
  ctx.beginPath();
  const period = level.tidePeriod;
  for (let i = 0; i <= period; i++) {
    const px = x + (i / period) * w;
    const lv = tideLevel(i, period);
    const py = y + h - 6 - (lv / 4) * (h - 12);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.strokeStyle = COLORS.water;
  ctx.lineWidth = 2;
  ctx.stroke();
  // 当前时刻游标
  const cx = x + ((tick % period) / period) * w;
  ctx.strokeStyle = COLORS.player;
  ctx.beginPath();
  ctx.moveTo(cx, y);
  ctx.lineTo(cx, y + h);
  ctx.stroke();
  ctx.fillStyle = COLORS.dim;
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('潮位 0→4', x + 4, y + 12);
  ctx.fillText(`周期${period}刻`, x + w - 52, y + 12);
  ctx.restore();
}
