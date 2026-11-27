import type { Board, ChannelDef, LocationDef, State } from '../engine/types';
import { locationById } from '../engine/engine';
import { anchorPx, effectiveBounds, makeViewport, pt, px, py, rectPx, type Viewport } from './viewport';
import { drawAnimal } from './animals';
import { clamp, lerp, roundRect, rng, shade, withAlpha } from './util';

export interface RenderOpts {
  readonly time: number;
  /** 每只动物的「显示位置」可以是插值出来的浑浊坐标，用于游动动画。 */
  readonly positions: Readonly<Record<string, { x: number; y: number }>>;
  /** 高亮的地点 / 动物。 */
  readonly highlightLocations?: ReadonlySet<string>;
  readonly highlightAnimals?: ReadonlySet<string>;
  /** 被标为「非法 / 排除」的地点。 */
  readonly dimLocations?: ReadonlySet<string>;
  /** 水道上的流动速度倍率（回放时更快）。 */
  readonly flow?: number;
  /** 预览前一步：整体压一点蓝，表示这不是当前的盘。 */
  readonly preview?: boolean;
}

const PALETTE = {
  deep: '#14343a',
  deep2: '#0e262c',
  water: '#1d4a52',
  waterLight: '#2f6c74',
  foam: '#bfe3df',
  sand: '#e7d9b8',
  sandDark: '#cbb98f',
  lawn: '#a9cf83',
  lawnDark: '#7fae5d',
  island: '#dfe3cd',
  islandDark: '#b8c0a4',
  ink: '#1b2b26',
  gold: '#e6b455',
  red: '#cf5f4a',
  blue: '#4b8fb5',
};

export function drawScene(
  ctx: CanvasRenderingContext2D,
  board: Board,
  state: State,
  opts: RenderOpts,
  width: number,
  height: number,
) {
  // 注意：ctx 已按 devicePixelRatio 做过缩放，这里必须用 CSS 尺寸，
  // 不能用 ctx.canvas.width（那是设备像素）。
  const b = effectiveBounds(board.locations);
  const v = makeViewport(width, height, b.cols, b.rows, 26);
  drawWater(ctx, v, opts, width, height);
  drawChannels(ctx, board, v, opts);
  for (const loc of board.locations) drawLocation(ctx, board, loc, v, opts);
  drawGrassLinks(ctx, board, v);
  drawOccupants(ctx, board, state, v, opts);

  if (opts.preview) {
    // 预览蒙版：暗示「这是候选的前一步，不是已经走过的盘」
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = withAlpha('#3f7fbf', 0.1);
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = withAlpha('#7fb6e8', 0.5);
    ctx.lineWidth = 2;
    ctx.setLineDash([10, 8]);
    roundRect(ctx, 6, 6, width - 12, height - 12, 18);
    ctx.stroke();
    ctx.restore();
  }
}

/* ------------------------------------------------------------------ */

function drawWater(
  ctx: CanvasRenderingContext2D,
  v: Viewport,
  opts: RenderOpts,
  width: number,
  height: number,
) {
  const g = ctx.createLinearGradient(0, v.oy, 0, v.oy + v.h);
  g.addColorStop(0, PALETTE.deep);
  g.addColorStop(0.55, PALETTE.water);
  g.addColorStop(1, PALETTE.deep2);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);

  // 水纹：几条缓慢移动的正弦线
  const t = opts.time * 0.35;
  ctx.save();
  ctx.globalAlpha = 0.16;
  ctx.strokeStyle = PALETTE.foam;
  ctx.lineWidth = Math.max(1, v.tile * 0.012);
  for (let i = 0; i < 26; i++) {
    const y = v.oy + ((i * 37 + t * 14) % (v.h + 60)) - 30;
    ctx.beginPath();
    const amp = v.tile * (0.03 + (i % 3) * 0.012);
    for (let x = v.ox; x <= v.ox + v.w; x += v.tile * 0.3) {
      const yy = y + Math.sin((x / v.tile) * 0.9 + i + t * 0.6) * amp;
      if (x === v.ox) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    }
    ctx.stroke();
  }
  ctx.restore();

  // 浮萍点点
  const rand = rng(9001);
  ctx.save();
  for (let i = 0; i < 40; i++) {
    const x = v.ox + rand() * v.w;
    const y = v.oy + rand() * v.h;
    const r = v.tile * (0.02 + rand() * 0.035);
    ctx.globalAlpha = 0.1 + rand() * 0.12;
    ctx.fillStyle = rand() > 0.5 ? '#7fb27a' : '#4f8f77';
    ctx.beginPath();
    ctx.arc(x + Math.sin(opts.time * 0.3 + i) * v.tile * 0.03, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // 四周暗角
  const vg = ctx.createRadialGradient(
    v.ox + v.w / 2,
    v.oy + v.h / 2,
    v.w * 0.25,
    v.ox + v.w / 2,
    v.oy + v.h / 2,
    v.w * 0.8,
  );
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(4,16,18,0.55)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, width, height);
}

function drawLocation(
  ctx: CanvasRenderingContext2D,
  board: Board,
  loc: LocationDef,
  v: Viewport,
  opts: RenderOpts,
) {
  const r = rectPx(v, loc);
  const isLawn = loc.kind === 'lawn';
  const highlighted = opts.highlightLocations?.has(loc.id) ?? false;
  const dimmed = opts.dimLocations?.has(loc.id) ?? false;
  const inset = v.tile * 0.13;

  ctx.save();
  ctx.globalAlpha = dimmed ? 0.42 : 1;

  // 水位线阴影
  ctx.save();
  ctx.globalAlpha *= 0.35;
  ctx.fillStyle = '#061a1c';
  roundRect(ctx, r.x + inset, r.y + inset + v.tile * 0.06, r.w - inset * 2, r.h - inset * 2 + v.tile * 0.12, v.tile * 0.3);
  ctx.fill();
  ctx.restore();

  // 岛体
  const base = isLawn ? PALETTE.lawn : PALETTE.island;
  const grad = ctx.createLinearGradient(r.x, r.y, r.x, r.y + r.h);
  grad.addColorStop(0, shade(base, 0.12));
  grad.addColorStop(1, shade(base, -0.12));
  ctx.fillStyle = grad;
  roundRect(ctx, r.x + inset, r.y + inset, r.w - inset * 2, r.h - inset * 2, v.tile * 0.28);
  ctx.fill();

  // 顶部亮边
  ctx.strokeStyle = withAlpha('#ffffff', isLawn ? 0.28 : 0.35);
  ctx.lineWidth = Math.max(1, v.tile * 0.035);
  roundRect(ctx, r.x + inset, r.y + inset, r.w - inset * 2, r.h - inset * 2, v.tile * 0.28);
  ctx.stroke();

  // 边缘阴影
  ctx.strokeStyle = withAlpha(isLawn ? PALETTE.lawnDark : PALETTE.islandDark, 0.7);
  ctx.lineWidth = Math.max(1, v.tile * 0.02);
  roundRect(ctx, r.x + inset + 2, r.y + inset + 2, r.w - inset * 2 - 4, r.h - inset * 2 - 4, v.tile * 0.24);
  ctx.stroke();

  if (isLawn) {
    // 草纹
    const rand = rng(loc.id.charCodeAt(1) * 977 + 13);
    ctx.strokeStyle = withAlpha(PALETTE.lawnDark, 0.55);
    ctx.lineWidth = Math.max(1, v.tile * 0.02);
    for (let i = 0; i < 14; i++) {
      const x = r.x + inset + v.tile * 0.15 + rand() * (r.w - inset * 2 - v.tile * 0.3);
      const y = r.y + inset + v.tile * 0.15 + rand() * (r.h - inset * 2 - v.tile * 0.35);
      const h = v.tile * (0.06 + rand() * 0.06);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x + h * 0.4, y - h, x + h * 0.9, y - h * 1.1);
      ctx.stroke();
    }
    // 小野花
    for (let i = 0; i < 4; i++) {
      const x = r.x + inset + v.tile * 0.2 + rand() * (r.w - inset * 2 - v.tile * 0.4);
      const y = r.y + inset + v.tile * 0.2 + rand() * (r.h - inset * 2 - v.tile * 0.4);
      ctx.fillStyle = ['#f6e7a8', '#f2c6b4', '#e9f0d0'][i % 3]!;
      ctx.beginPath();
      ctx.arc(x, y, v.tile * 0.028, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    // 岛上沙纹
    const rand = rng(loc.id.charCodeAt(1) * 131 + 7);
    ctx.strokeStyle = withAlpha(PALETTE.sandDark, 0.22);
    ctx.lineWidth = Math.max(1, v.tile * 0.015);
    for (let i = 0; i < 5; i++) {
      const y = r.y + inset + v.tile * 0.2 + rand() * (r.h - inset * 2 - v.tile * 0.4);
      ctx.beginPath();
      ctx.moveTo(r.x + inset + v.tile * 0.14, y);
      ctx.quadraticCurveTo(r.x + r.w / 2, y + v.tile * 0.03, r.x + r.w - inset - v.tile * 0.14, y - v.tile * 0.01);
      ctx.stroke();
    }
    // 岛上的小石子
    for (let i = 0; i < 3; i++) {
      const x = r.x + inset + v.tile * 0.18 + rand() * (r.w - inset * 2 - v.tile * 0.36);
      const y = r.y + inset + v.tile * 0.18 + rand() * (r.h - inset * 2 - v.tile * 0.36);
      ctx.fillStyle = withAlpha(PALETTE.sandDark, 0.45);
      ctx.beginPath();
      ctx.ellipse(x, y, v.tile * 0.05, v.tile * 0.035, rand(), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 高亮圈
  if (highlighted) {
    const pulse = 0.5 + 0.5 * Math.sin(opts.time * 3.2);
    ctx.strokeStyle = withAlpha(PALETTE.gold, 0.5 + pulse * 0.45);
    ctx.lineWidth = Math.max(2, v.tile * 0.055);
    roundRect(ctx, r.x + inset, r.y + inset, r.w - inset * 2, r.h - inset * 2, v.tile * 0.28);
    ctx.stroke();
  }

  // 名称牌
  const label = loc.name;
  const fs = clamp(v.tile * 0.15, 10, 17);
  ctx.font = `600 ${fs}px "PingFang SC", "Noto Sans SC", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const metrics = ctx.measureText(label);
  const padX = fs * 0.55;
  const bw = metrics.width + padX * 2;
  const bh = fs * 1.75;
  const bx = r.x + r.w / 2 - bw / 2;
  const by = r.y + r.h - inset - bh * 0.72;
  ctx.fillStyle = withAlpha(isLawn ? '#3c5a2a' : '#2f3d31', 0.7);
  roundRect(ctx, bx, by, bw, bh, bh / 2);
  ctx.fill();
  ctx.fillStyle = '#f3f0e2';
  ctx.fillText(label, r.x + r.w / 2, by + bh / 2 + fs * 0.04);

  ctx.restore();
  void board;
}

function drawChannels(
  ctx: CanvasRenderingContext2D,
  board: Board,
  v: Viewport,
  opts: RenderOpts,
) {
  const flow = opts.flow ?? 1;
  for (const ch of board.channels) drawChannel(ctx, ch, v, opts.time * flow);
}

function drawChannel(
  ctx: CanvasRenderingContext2D,
  ch: ChannelDef,
  v: Viewport,
  time: number,
) {
  if (ch.points.length < 2) return;
  const pts = ch.points.map((p) => pt(v, p));
  const width = v.tile * 0.24;

  const path = new Path2D();
  path.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length; i++) path.lineTo(pts[i]!.x, pts[i]!.y);

  // 水道底色
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = withAlpha('#0a2226', 0.75);
  ctx.lineWidth = width + v.tile * 0.12;
  ctx.stroke(path);

  const g = ctx.createLinearGradient(pts[0]!.x, pts[0]!.y, pts[pts.length - 1]!.x, pts[pts.length - 1]!.y);
  g.addColorStop(0, withAlpha(PALETTE.waterLight, 0.85));
  g.addColorStop(1, withAlpha('#69b3ae', 0.95));
  ctx.strokeStyle = g;
  ctx.lineWidth = width;
  ctx.stroke(path);

  // 中线光带
  ctx.strokeStyle = withAlpha('#dafaf4', 0.22);
  ctx.lineWidth = Math.max(1, width * 0.22);
  ctx.stroke(path);

  // 流动的小亮点：沿折线按弧长前进
  ctx.globalCompositeOperation = 'lighter';
  const segs = segmentList(pts);
  const total = segs.reduce((n, s) => n + s.len, 0);
  const count = Math.max(2, Math.round(total / (v.tile * 0.5)));
  for (let i = 0; i < count; i++) {
    const phase = ((time * 0.35 + i / count) % 1 + 1) % 1;
    const p = pointAt(segs, total, phase);
    const r = v.tile * (0.03 + 0.012 * Math.sin(time * 2 + i));
    ctx.fillStyle = withAlpha('#c8fff2', 0.5);
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';

  // 箭头（单向）
  const last = pts[pts.length - 1]!;
  const prev = pts[pts.length - 2]!;
  const ang = Math.atan2(last.y - prev.y, last.x - prev.x);
  const ah = v.tile * 0.16;
  ctx.save();
  ctx.translate(last.x, last.y);
  ctx.rotate(ang);
  ctx.fillStyle = withAlpha('#e8fff8', 0.95);
  ctx.beginPath();
  ctx.moveTo(ah * 0.6, 0);
  ctx.lineTo(-ah * 0.35, -ah * 0.5);
  ctx.lineTo(-ah * 0.05, 0);
  ctx.lineTo(-ah * 0.35, ah * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // 起点水口：一个小环，表示「从这里出发」
  const first = pts[0]!;
  const ang0 = Math.atan2(prev.y - last.y, prev.x - last.x);
  ctx.save();
  ctx.translate(first.x, first.y);
  ctx.rotate(ang0 + Math.PI);
  ctx.strokeStyle = withAlpha('#bfe3df', 0.5);
  ctx.lineWidth = Math.max(1, v.tile * 0.028);
  ctx.beginPath();
  ctx.arc(0, 0, v.tile * 0.14, -Math.PI * 0.6, Math.PI * 0.6);
  ctx.stroke();
  ctx.restore();

  // 单向标志：沿水道中央放一个小三角
  const mid = pointAt(segs, total, 0.55);
  ctx.save();
  ctx.translate(mid.x, mid.y);
  const tang = tangentAt(segs, total, 0.55);
  ctx.rotate(Math.atan2(tang.y, tang.x));
  ctx.fillStyle = withAlpha('#eafff9', 0.7);
  const ms = v.tile * 0.075;
  ctx.beginPath();
  ctx.moveTo(ms, 0);
  ctx.lineTo(-ms * 0.7, -ms * 0.62);
  ctx.lineTo(-ms * 0.7, ms * 0.62);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  ctx.restore();
}

interface Seg {
  a: { x: number; y: number };
  b: { x: number; y: number };
  len: number;
}

function segmentList(pts: { x: number; y: number }[]): Seg[] {
  const out: Seg[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    out.push({ a, b, len: Math.hypot(b.x - a.x, b.y - a.y) });
  }
  return out;
}

function pointAt(segs: Seg[], total: number, t: number) {
  let d = t * total;
  for (const s of segs) {
    if (d <= s.len || s === segs[segs.length - 1]) {
      const k = s.len === 0 ? 0 : d / s.len;
      return { x: lerp(s.a.x, s.b.x, clamp(k, 0, 1)), y: lerp(s.a.y, s.b.y, clamp(k, 0, 1)) };
    }
    d -= s.len;
  }
  const last = segs[segs.length - 1]!;
  return last.b;
}

function tangentAt(segs: Seg[], total: number, t: number) {
  let d = t * total;
  for (const s of segs) {
    if (d <= s.len) {
      const len = s.len || 1;
      return { x: (s.b.x - s.a.x) / len, y: (s.b.y - s.a.y) / len };
    }
    d -= s.len;
  }
  const last = segs[segs.length - 1]!;
  const len = last.len || 1;
  return { x: (last.b.x - last.a.x) / len, y: (last.b.y - last.a.y) / len };
}

function drawGrassLinks(
  ctx: CanvasRenderingContext2D,
  board: Board,
  v: Viewport,
) {
  // 岛与草坪之间的虚线「退路」
  ctx.save();
  ctx.setLineDash([v.tile * 0.09, v.tile * 0.11]);
  ctx.strokeStyle = withAlpha(PALETTE.lawnDark, 0.5);
  ctx.lineWidth = Math.max(1, v.tile * 0.03);
  for (const [from, to] of Object.entries(board.grassFrom)) {
    const a = anchorPx(v, locationById(board, from));
    const b = anchorPx(v, locationById(board, to));
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawOccupants(
  ctx: CanvasRenderingContext2D,
  board: Board,
  state: State,
  v: Viewport,
  opts: RenderOpts,
) {
  const radius = v.tile * 0.34;
  for (const animal of board.animals) {
    const locId = state[animal.id];
    if (!locId) continue;
    const cur = opts.positions[animal.id] ?? anchorPx(v, locationById(board, locId));
    const highlighted = opts.highlightAnimals?.has(animal.id) ?? false;
    // 未参与本回合的动物稍微压暗
    const involved =
      opts.highlightAnimals === undefined || opts.highlightAnimals.size === 0 || highlighted;
    drawAnimal(ctx, animal, cur.x, cur.y, radius, {
      t: opts.time,
      alpha: involved ? 1 : 0.72,
      glow: highlighted ? 0.9 : 0,
    });
    // 编号徽章
    const bx = cur.x + radius * 0.78;
    const by = cur.y - radius * 0.78;
    const br = radius * 0.3;
    ctx.save();
    ctx.fillStyle = animal.ink;
    ctx.strokeStyle = '#f6f1df';
    ctx.lineWidth = Math.max(1, radius * 0.075);
    ctx.beginPath();
    ctx.arc(bx, by, br, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#f6f1df';
    ctx.font = `700 ${Math.round(br * 1.15)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(animal.number), bx, by + br * 0.06);
    ctx.restore();
  }
}

export { PALETTE, px, py };
