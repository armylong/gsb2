import { idx, roomAt } from '../core/grid';
import type { GameMap, LockAnalysis, Route } from '../core/types';
import { LOCK_COLORS, Tile } from '../core/types';

export interface RenderState {
  map: GameMap;
  analysis: LockAnalysis | null;
  /** 自动播放/手动控制时的玩家位置;null 时只显示起点 */
  player: { x: number; y: number; heldColors: Set<number>; openedDoorIds: Set<number>; pickedKeyIds: Set<number> } | null;
  /** 播放到的路线步数索引(-1 = 未播放) */
  routeCursor: number;
  route: Route | null;
  /** 失效标记:地图被编辑但尚未重新检查(本实现里编辑即重算,保留接口用于异常态) */
  stale: boolean;
  hoverCell: { x: number; y: number } | null;
  selectedKeyId: number | null;
}

const CELL = 15;

export function canvasSize(): { w: number; h: number; cell: number } {
  return { w: 72 * CELL, h: 48 * CELL, cell: CELL };
}

export function eventToCell(e: MouseEvent, canvas: HTMLCanvasElement): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor(((e.clientX - rect.left) / rect.width) * 72);
  const y = Math.floor(((e.clientY - rect.top) / rect.height) * 48);
  return { x, y };
}

function fillCell(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
}

export function render(ctx: CanvasRenderingContext2D, st: RenderState): void {
  const { map, analysis } = st;
  ctx.clearRect(0, 0, 72 * CELL, 48 * CELL);
  ctx.fillStyle = '#0e1015';
  ctx.fillRect(0, 0, 72 * CELL, 48 * CELL);

  const startComp = analysis ? analysis.components[idx(map.start.x, map.start.y, map.width)] : -1;

  // ---- 1. 地形层 + 可达性染色 ----
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const t = map.tiles[idx(x, y, map.width)];
      if (t === Tile.Wall) continue;
      const base = t === Tile.Floor ? '#2b3140' : '#3a4254';
      fillCell(ctx, x, y, base);
      if (analysis) {
        const ci = idx(x, y, map.width);
        if (!analysis.terrainReachable.has(ci)) {
          ctx.fillStyle = 'rgba(229,72,77,0.30)'; // 地形断开:红
          ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
        } else if (!analysis.reachable.has(ci)) {
          ctx.fillStyle = 'rgba(229,161,60,0.28)'; // 锁挡住:琥珀
          ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
        } else {
          ctx.fillStyle = 'rgba(53,167,92,0.14)'; // 实际可达:淡绿
          ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
        }
      }
    }
  }

  // ---- 2. 房间边框与名称 ----
  ctx.lineWidth = 1;
  for (const r of map.rooms) {
    const disconnected = analysis ? analysis.components[idx(r.x, r.y, map.width)] !== startComp : false;
    ctx.strokeStyle = disconnected ? 'rgba(229,72,77,0.9)' : 'rgba(154,163,181,0.55)';
    ctx.strokeRect(r.x * CELL + 0.5, r.y * CELL + 0.5, r.w * CELL - 1, r.h * CELL - 1);
    ctx.fillStyle = disconnected ? '#ff9b9e' : '#c7cddb';
    ctx.font = 'bold 10px sans-serif';
    ctx.fillText(r.name, r.x * CELL + 3, r.y * CELL + 11);
  }

  // ---- 3. 病因相关房间高亮描边 ----
  if (analysis?.failure) {
    for (const rid of analysis.failure.roomIds) {
      const r = map.rooms.find((rm) => rm.id === rid);
      if (!r) continue;
      ctx.strokeStyle = 'rgba(229,72,77,0.95)';
      ctx.lineWidth = 2.5;
      ctx.strokeRect(r.x * CELL - 1, r.y * CELL - 1, r.w * CELL + 2, r.h * CELL + 2);
      ctx.lineWidth = 1;
    }
  }

  // ---- 4. 路线(播放前显示完整路线,播放中显示已走部分) ----
  if (st.route && st.route.steps.length > 1) {
    const upto = st.routeCursor >= 0 ? Math.min(st.routeCursor, st.route.steps.length - 1) : st.route.steps.length - 1;
    ctx.strokeStyle = st.routeCursor >= 0 ? 'rgba(156,193,255,0.95)' : 'rgba(156,193,255,0.45)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (let i = 0; i <= upto; i++) {
      const s = st.route.steps[i];
      const px = s.x * CELL + CELL / 2;
      const py = s.y * CELL + CELL / 2;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  // ---- 5. 门 ----
  for (const d of map.doors) {
    const opened = st.player?.openedDoorIds.has(d.id) ?? false;
    const px = d.x * CELL;
    const py = d.y * CELL;
    if (d.color === null || opened) {
      // 无锁/已打开:空心框
      ctx.strokeStyle = d.color === null ? '#8b93a5' : LOCK_COLORS[d.color!].stroke;
      ctx.strokeRect(px + 2, py + 2, CELL - 4, CELL - 4);
      continue;
    }
    const c = LOCK_COLORS[d.color];
    ctx.fillStyle = c.fill;
    ctx.fillRect(px + 1.5, py + 1.5, CELL - 3, CELL - 3);
    // 锁孔
    ctx.fillStyle = '#10131a';
    ctx.beginPath();
    ctx.arc(px + CELL / 2, py + CELL / 2 + 1, 1.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(px + CELL / 2 - 1, py + CELL / 2 + 1, 2, 3.5);
  }
  // 阻塞门脉冲圈
  if (analysis?.failure) {
    for (const b of analysis.failure.blockers) {
      ctx.strokeStyle = '#ff5f63';
      ctx.lineWidth = 2;
      ctx.strokeRect(b.x * CELL - 1, b.y * CELL - 1, CELL + 2, CELL + 2);
      ctx.lineWidth = 1;
    }
  }

  // ---- 6. 钥匙 ----
  for (const k of map.keys) {
    const picked = st.player?.pickedKeyIds.has(k.id) ?? false;
    const c = LOCK_COLORS[k.color];
    const cx = k.x * CELL + CELL / 2;
    const cy = k.y * CELL + CELL / 2;
    ctx.globalAlpha = picked ? 0.25 : 1;
    ctx.strokeStyle = c.stroke;
    ctx.fillStyle = c.fill;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(cx - 2, cy, 3.2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + 1, cy);
    ctx.lineTo(cx + 5.5, cy);
    ctx.lineTo(cx + 5.5, cy + 2.5);
    ctx.moveTo(cx + 3.5, cy);
    ctx.lineTo(cx + 3.5, cy + 2);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.globalAlpha = 1;
    if (st.selectedKeyId === k.id) {
      ctx.strokeStyle = '#fff';
      ctx.strokeRect(k.x * CELL - 1, k.y * CELL - 1, CELL + 2, CELL + 2);
    }
  }

  // ---- 7. 起点与出口 ----
  drawMarker(ctx, map.start.x, map.start.y, '#35a75c', 'S');
  drawMarker(ctx, map.exit.x, map.exit.y, '#e5a13c', 'E');

  // ---- 8. 玩家标记 ----
  if (st.player) {
    const cx = st.player.x * CELL + CELL / 2;
    const cy = st.player.y * CELL + CELL / 2;
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#10131a';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  // ---- 9. 悬停格 ----
  if (st.hoverCell) {
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.strokeRect(st.hoverCell.x * CELL + 0.5, st.hoverCell.y * CELL + 0.5, CELL - 1, CELL - 1);
  }
}

function drawMarker(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, label: string): void {
  const cx = x * CELL + CELL / 2;
  const cy = y * CELL + CELL / 2;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, 6, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.fillStyle = color;
  ctx.font = 'bold 9px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(label, cx, cy + 3);
  ctx.textAlign = 'left';
}

/** 悬停格的文字说明(供 tooltip) */
export function describeCell(map: GameMap, analysis: LockAnalysis | null, x: number, y: number): string {
  const parts: string[] = [];
  const rid = roomAt(map, x, y);
  parts.push(rid !== -1 ? `格子 (${x},${y}) · 房间 R${rid}` : `格子 (${x},${y})`);
  const t = map.tiles[idx(x, y, map.width)];
  parts.push(t === Tile.Wall ? '地形:墙' : t === Tile.Floor ? '地形:房间地板' : '地形:通道');
  const door = map.doors.find((d) => d.x === x && d.y === y);
  if (door) {
    parts.push(
      door.color === null
        ? `门 #${door.id}:无锁敞开`
        : `门 #${door.id}:${LOCK_COLORS[door.color].name}色锁(通道 #${door.corridorId})`,
    );
  }
  const key = map.keys.find((k) => k.x === x && k.y === y);
  if (key) parts.push(`钥匙 #${key.id}:${LOCK_COLORS[key.color].name}色`);
  const corr = map.corridors.find((c) => c.cells.some((p) => p.x === x && p.y === y));
  if (corr && t === Tile.Corridor) parts.push(`通道 #${corr.id}(R${corr.roomA}↔R${corr.roomB})${corr.removed ? ' · 已移除' : ''}`);
  if (analysis) {
    const ci = idx(x, y, map.width);
    if (analysis.terrainReachable.has(ci)) {
      parts.push(analysis.reachable.has(ci) ? '忽略锁:可达 · 实际:可达' : '忽略锁:可达 · 实际:被锁挡住');
    } else {
      parts.push('忽略锁:不可达(地形断开)');
    }
  }
  return parts.join('<br>');
}
