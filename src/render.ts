import { Game } from './game.js';
import { LevelDef, ParadeDef, Layout } from './model.js';
import { checkSight, signAnchorAt, boatPosAt } from './sim.js';
import { Vec } from './geom.js';

const WATER_TOP = 40, SHORE_Y = 400;

export function drawScene(ctx: CanvasRenderingContext2D, level: LevelDef, parade: ParadeDef, game: Game): void {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  // 背景:水面 + 岸
  const wg = ctx.createLinearGradient(0, WATER_TOP, 0, SHORE_Y);
  wg.addColorStop(0, '#0b2545'); wg.addColorStop(1, '#134074');
  ctx.fillStyle = wg; ctx.fillRect(0, 0, W, SHORE_Y);
  ctx.fillStyle = '#3d3355'; ctx.fillRect(0, SHORE_Y, W, H - SHORE_Y);
  ctx.fillStyle = '#544a6e'; ctx.fillRect(0, SHORE_Y, W, 10);

  const round = game.round;
  const t = game.phase === 'edit' ? 0 : game.t;
  const layout = game.phase === 'edit' ? game.staged : game.committed;

  // 航路
  ctx.setLineDash([6, 6]);
  for (const b of parade.boats) {
    const r = round.routes[b.id];
    if (!r) continue;
    ctx.strokeStyle = b.color + '66'; ctx.lineWidth = 2;
    ctx.beginPath();
    r.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // 立柱
  for (const p of level.pillars) {
    ctx.fillStyle = '#6c5b7b';
    ctx.beginPath(); ctx.arc(p.pos.x, p.pos.y, p.r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#2c2540';
    ctx.beginPath(); ctx.arc(p.pos.x, p.pos.y, p.r * 0.55, 0, Math.PI * 2); ctx.fill();
    label(ctx, `柱 ${p.height}m`, p.pos.x, p.pos.y + p.r + 12, '#cbb8ff');
  }

  // 导览牌(位置按剧本,场中可能挪动)
  const sa = signAnchorAt(round, t);
  const sp = level.sign.anchors[sa];
  ctx.fillStyle = '#c0a060';
  ctx.strokeStyle = '#7a6230'; ctx.lineWidth = 3;
  roundRect(ctx, sp.x - 26, sp.y - 16, 52, 32, 6);
  ctx.fill(); ctx.stroke();
  label(ctx, `导览牌 ${level.sign.height}m`, sp.x, sp.y + 30, '#ffe9a8');

  // 座孔
  for (const h of level.holes) {
    ctx.strokeStyle = '#8f86a8'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(h.pos.x, h.pos.y, 16, 0, Math.PI * 2); ctx.stroke();
  }

  // 船
  for (const b of parade.boats) {
    const pos = boatPosAt(round, b.id, b.speed, t);
    if (!pos) continue;
    drawBoat(ctx, pos, b.height, b.color, b.name);
  }

  // 关键时刻横幅
  for (const m of round.keyMoments) {
    if (game.phase === 'playing' && Math.abs(t - m.t) < 0.5) {
      ctx.fillStyle = '#ffd166';
      ctx.font = 'bold 18px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`★ 关键时刻:${m.label}`, W / 2, 24);
    }
  }

  // 被观察观众的视锥与视线
  if (game.inspectedViewer) {
    const viewer = level.viewers.find(v => v.id === game.inspectedViewer)!;
    const chair = layout.chairs.find(c => c.viewerId === viewer.id);
    if (chair) drawSightlines(ctx, level, parade, layout, round, viewer.id, chair.holeId, chair.facing, t);
  }

  // 椅子(编辑态画暂存布置,演出态画生效布置)
  drawChairs(ctx, level, game, layout, t);

  // 编辑态:已生效→暂存的移动箭头
  if (game.phase === 'edit') {
    for (let i = 0; i < game.staged.chairs.length; i++) {
      const a = game.committed.chairs[i], b = game.staged.chairs[i];
      if (a.holeId === b.holeId) continue;
      const ha = level.holes.find(h => h.id === a.holeId)!.pos;
      const hb = level.holes.find(h => h.id === b.holeId)!.pos;
      ctx.strokeStyle = '#ffd166aa'; ctx.lineWidth = 2; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(ha.x, ha.y); ctx.lineTo(hb.x, hb.y); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // 同孔冲突提示
  if (game.phase === 'edit') {
    const seen = new Map<string, number>();
    for (const c of game.staged.chairs) seen.set(c.holeId, (seen.get(c.holeId) ?? 0) + 1);
    for (const [holeId, n] of seen) {
      if (n > 1) {
        const p = level.holes.find(h => h.id === holeId)!.pos;
        ctx.strokeStyle = '#ff5555'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(p.x, p.y, 24, 0, Math.PI * 2); ctx.stroke();
        label(ctx, '同孔冲突!', p.x, p.y - 30, '#ff8888');
      }
    }
  }
}

function drawChairs(ctx: CanvasRenderingContext2D, level: LevelDef, game: Game, layout: Layout, _t: number): void {
  for (const c of layout.chairs) {
    const hole = level.holes.find(h => h.id === c.holeId)!;
    const { x, y } = hole.pos;
    const selected = game.selectedChair === c.id;
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = selected ? '#ffd166' : '#9d8cff';
    ctx.strokeStyle = selected ? '#b58a00' : '#5a4fa0';
    ctx.lineWidth = 2;
    roundRect(ctx, -13, -13, 26, 26, 6);
    ctx.fill(); ctx.stroke();
    // 朝向箭头
    ctx.strokeStyle = '#222'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(c.facing) * 18, Math.sin(c.facing) * 18); ctx.stroke();
    ctx.restore();
    if (c.viewerId) {
      const vw = level.viewers.find(v => v.id === c.viewerId)!;
      label(ctx, vw.name, x, y + 32, game.inspectedViewer === vw.id ? '#ffd166' : '#e8e4ff');
    }
  }
}

function drawSightlines(
  ctx: CanvasRenderingContext2D, level: LevelDef, parade: ParadeDef, layout: Layout,
  round: ParadeDef['rounds'][number], viewerId: string, holeId: string, facing: number, t: number,
): void {
  const viewer = level.viewers.find(v => v.id === viewerId)!;
  const chair = layout.chairs.find(c => c.viewerId === viewerId)!;
  const eye = level.holes.find(h => h.id === holeId)!.pos;

  // 视锥
  ctx.fillStyle = '#ffffff10';
  ctx.beginPath();
  ctx.moveTo(eye.x, eye.y);
  ctx.arc(eye.x, eye.y, 120, facing - viewer.fovHalf, facing + viewer.fovHalf);
  ctx.closePath(); ctx.fill();

  for (const b of parade.boats) {
    const s = checkSight(level, layout, round, parade, viewer, chair, b.id, t);
    if (!s.boatPos) continue;
    ctx.strokeStyle = s.visible ? '#5ee06a' : '#ff5a5a';
    ctx.lineWidth = s.visible ? 2.5 : 1.5;
    if (!s.visible) ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(eye.x, eye.y); ctx.lineTo(s.boatPos.x, s.boatPos.y); ctx.stroke();
    ctx.setLineDash([]);
    // 遮挡物高亮
    for (const bl of s.blockers) {
      let p: Vec | null = null;
      if (bl.type === 'pillar') p = level.pillars.find(x => x.id === bl.id)!.pos;
      else if (bl.type === 'sign') p = level.sign.anchors[signAnchorAt(round, t)];
      else {
        const oc = layout.chairs.find(c => c.viewerId === bl.id);
        if (oc) p = level.holes.find(h => h.id === oc.holeId)!.pos;
      }
      if (p) {
        ctx.strokeStyle = '#ff9f1c'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(p.x, p.y, 20, 0, Math.PI * 2); ctx.stroke();
        label(ctx, `被挡:${bl.label}`, p.x, p.y - 26, '#ff9f1c');
      }
    }
  }
}

function drawBoat(ctx: CanvasRenderingContext2D, pos: Vec, height: number, color: string, name: string): void {
  const mast = height * 16;
  ctx.save();
  ctx.translate(pos.x, pos.y);
  // 船体
  ctx.fillStyle = '#3a2c18';
  ctx.beginPath(); ctx.ellipse(0, 0, 30, 10, 0, 0, Math.PI * 2); ctx.fill();
  // 桅杆 + 灯笼
  ctx.strokeStyle = '#8a6a3a'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -mast); ctx.stroke();
  const glow = ctx.createRadialGradient(0, -mast, 2, 0, -mast, 22);
  glow.addColorStop(0, color); glow.addColorStop(1, 'transparent');
  ctx.fillStyle = glow;
  ctx.beginPath(); ctx.arc(0, -mast, 22, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(0, -mast, 7, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  label(ctx, `${name} ${height}m`, pos.x, pos.y + 24, color);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string): void {
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#000a';
  ctx.fillText(text, x + 1, y + 1);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}
