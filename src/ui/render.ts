import type { Action, DoughState, GameState, LevelSpec, SimulationResult, Zone } from '../game/types';
import type { CatchInfo } from '../game/engine';

// ─── 布局常量 ───
export const W = 1160;
export const H = 780;

const C = {
  bg: '#efe6d3',
  panel: '#fbf5e8',
  panelStroke: '#d8c8a8',
  ink: '#4a3826',
  sub: '#8a7558',
  proof: '#f3c969',
  proofDeep: '#d99e2b',
  rack: '#9fc3d8',
  rackDeep: '#5e8fae',
  oven: '#e08e6e',
  ovenDeep: '#b5522f',
  bench: '#c9a878',
  ok: '#5a8f4a',
  warn: '#c98a1e',
  bad: '#c0453b',
  accent: '#7a5230',
  ghost: '#b9a684',
};

export interface HitTarget {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  kind: 'dough' | 'slot' | 'button' | 'zone' | 'gear' | 'level-card';
  payload?: string;
}

export interface RenderInput {
  screen: 'intro' | 'play';
  levels: LevelSpec[];
  level: LevelSpec;
  state: GameState;
  selectedDoughId: string | null;
  pendingAction: Action;
  pendingText: string;
  simulation: SimulationResult | null;
  canUndo: boolean;
  catchInfos: CatchInfo[];
  message: string | null;
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

function doughColor(zone: Zone): string {
  switch (zone) {
    case 'proof':
      return C.proof;
    case 'rack':
      return C.rack;
    case 'oven':
      return C.oven;
    case 'delivered':
      return C.ok;
    case 'failed':
      return C.bad;
    default:
      return C.bench;
  }
}

const ZONE_NAME: Record<Zone, string> = {
  bench: '案板',
  proof: '温箱',
  rack: '凉架',
  oven: '烤炉',
  delivered: '已交单',
  failed: '退单',
};

// ─── 主入口 ───
export function render(ctx: CanvasRenderingContext2D, input: RenderInput): HitTarget[] {
  const hits: HitTarget[] = [];
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  if (input.screen === 'intro') {
    renderIntro(ctx, input, hits);
  } else {
    renderPlay(ctx, input, hits);
  }
  return hits;
}

// ─── 关卡选择 / 开局预览屏 ───
function renderIntro(ctx: CanvasRenderingContext2D, input: RenderInput, hits: HitTarget[]): void {
  ctx.fillStyle = C.ink;
  ctx.font = 'bold 34px "PingFang SC", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('发面时辰 · 回合制烘焙谜题', W / 2, 64);
  ctx.font = '15px "PingFang SC", sans-serif';
  ctx.fillStyle = C.sub;
  ctx.fillText('每拍只能选一次主要操作；熟度是 0–12 的整数刻度，窗口与截止回合开局即可查看', W / 2, 94);

  input.levels.forEach((lv, i) => {
    const cardW = 500;
    const cardH = 470;
    const x = 80 + i * 540;
    const y = 130;
    ctx.save();
    roundRect(ctx, x, y, cardW, cardH, 14);
    ctx.fillStyle = C.panel;
    ctx.fill();
    ctx.strokeStyle = C.panelStroke;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = C.ink;
    ctx.font = 'bold 22px "PingFang SC", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(lv.title, x + 24, y + 42);

    ctx.font = '14px "PingFang SC", sans-serif';
    ctx.fillStyle = C.sub;
    wrapText(ctx, lv.brief, x + 24, y + 74, cardW - 48, 22);

    // 面团情报表（开始前即可查看起点与合格窗口）
    let ty = y + 170;
    ctx.fillStyle = C.ink;
    ctx.font = 'bold 15px "PingFang SC", sans-serif';
    ctx.fillText('面团情报（开局前公开）', x + 24, ty);
    ty += 12;
    ctx.strokeStyle = C.panelStroke;
    ctx.beginPath();
    ctx.moveTo(x + 24, ty + 8);
    ctx.lineTo(x + cardW - 24, ty + 8);
    ctx.stroke();
    ty += 30;
    for (const d of lv.doughs) {
      ctx.fillStyle = doughColor(d.startZone);
      ctx.beginPath();
      ctx.arc(x + 40, ty - 5, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = C.accent;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = C.ink;
      ctx.font = 'bold 15px "PingFang SC", sans-serif';
      ctx.fillText(d.name, x + 60, ty);
      ctx.font = '14px "PingFang SC", sans-serif';
      ctx.fillStyle = C.sub;
      ctx.fillText(
        `起点 ${ZONE_NAME[d.startZone]} · 初始熟度 ${d.startDoneness} · 窗口 [${d.window[0]}, ${d.window[1]}] · 截止第 ${d.deadline} 拍`,
        x + 110,
        ty,
      );
      ty += 30;
    }

    ty += 8;
    ctx.fillStyle = C.ink;
    ctx.font = '13px "PingFang SC", sans-serif';
    ctx.fillText(`温箱槽位 ${lv.proofSlots} 个 · 档位 0/1/2（每拍 +0/+1/+2）`, x + 24, ty);
    ty += 22;
    ctx.fillText(`凉架每拍 +${lv.rackRate} · 烤炉一次一团，占炉 ${lv.ovenBakeTurns} 拍`, x + 24, ty);
    ty += 22;
    ctx.fillText('结算顺序：换位 → 烤炉 → 温箱 → 凉架（刚换位的在新位置结算）', x + 24, ty);

    // 开始按钮
    const btnY = y + cardH - 62;
    roundRect(ctx, x + 24, btnY, cardW - 48, 42, 10);
    ctx.fillStyle = C.accent;
    ctx.fill();
    ctx.fillStyle = '#fff8ec';
    ctx.font = 'bold 17px "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`开始 ${lv.id} 关`, x + cardW / 2, btnY + 27);
    hits.push({
      id: `start-${lv.id}`,
      x: x + 24,
      y: btnY,
      w: cardW - 48,
      h: 42,
      kind: 'level-card',
      payload: lv.id,
    });
    ctx.restore();
  });

  ctx.textAlign = 'left';
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxW: number,
  lineH: number,
): void {
  let line = '';
  let cy = y;
  for (const ch of text) {
    const test = line + ch;
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, x, cy);
      line = ch;
      cy += lineH;
    } else {
      line = test;
    }
  }
  ctx.fillText(line, x, cy);
}

// ─── 操作台 ───
function renderPlay(ctx: CanvasRenderingContext2D, input: RenderInput, hits: HitTarget[]): void {
  const { state, level } = input;

  // 顶栏
  ctx.fillStyle = C.panel;
  roundRect(ctx, 16, 14, W - 32, 58, 12);
  ctx.fill();
  ctx.strokeStyle = C.panelStroke;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = C.ink;
  ctx.font = 'bold 20px "PingFang SC", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(level.title, 34, 50);
  ctx.font = '16px "PingFang SC", sans-serif';
  ctx.fillStyle = C.accent;
  ctx.fillText(`第 ${state.turn} 拍`, 250, 50);
  ctx.fillStyle = C.sub;
  ctx.fillText(`温箱档位 ${state.gear}（每拍 +${level.gearRates[state.gear]}）`, 340, 50);

  // 档位按钮（辅助操作，随时可调，不消耗主要操作）
  [0, 1, 2].forEach((g) => {
    const bx = 620 + g * 74;
    const active = state.gear === g;
    roundRect(ctx, bx, 24, 62, 38, 8);
    ctx.fillStyle = active ? C.proofDeep : '#fff8ec';
    ctx.fill();
    ctx.strokeStyle = C.panelStroke;
    ctx.stroke();
    ctx.fillStyle = active ? '#fff' : C.ink;
    ctx.font = 'bold 15px "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${g} 档`, bx + 31, 48);
    hits.push({ id: `gear-${g}`, x: bx, y: 24, w: 62, h: 38, kind: 'gear', payload: String(g) });
  });
  ctx.textAlign = 'left';

  topButton(ctx, hits, 'btn-undo', '撤销本拍 (U)', 900, 24, 110, 38, input.canUndo);
  topButton(ctx, hits, 'btn-reset', '重置 (R)', 1018, 24, 110, 38, true);

  // 左：工位区
  renderZones(ctx, input, hits);

  // 右：订单与赶单分析
  renderOrders(ctx, input, hits);

  // 底栏：操作计划 + 按钮
  renderDock(ctx, input, hits);

  // 日志（左下角小面板）
  renderLog(ctx, input);

  // 模拟浮层
  if (input.simulation) {
    renderSimulation(ctx, input, input.simulation);
  }

  // 结束横幅
  if (state.status !== 'playing') {
    renderEndBanner(ctx, state.status === 'won');
  } else if (input.message) {
    ctx.fillStyle = 'rgba(192,69,59,0.92)';
    roundRect(ctx, W / 2 - 260, 88, 520, 34, 8);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '14px "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(input.message, W / 2, 110);
    ctx.textAlign = 'left';
  }
}

function topButton(
  ctx: CanvasRenderingContext2D,
  hits: HitTarget[],
  id: string,
  label: string,
  x: number,
  y: number,
  w: number,
  h: number,
  enabled: boolean,
): void {
  roundRect(ctx, x, y, w, h, 8);
  ctx.fillStyle = enabled ? C.accent : C.ghost;
  ctx.fill();
  ctx.fillStyle = '#fff8ec';
  ctx.font = 'bold 14px "PingFang SC", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(label, x + w / 2, y + h / 2 + 5);
  ctx.textAlign = 'left';
  if (enabled) hits.push({ id, x, y, w, h, kind: 'button' });
}

// ─── 三个工位 ───
function renderZones(ctx: CanvasRenderingContext2D, input: RenderInput, hits: HitTarget[]): void {
  const { state, level } = input;
  const top = 92;

  // 温箱
  const px = 24;
  const pw = 420;
  const ph = 250;
  zoneFrame(ctx, px, top, pw, ph, '温箱（同档每拍给箱内各团 +档位值）', C.proof, C.proofDeep);
  const slotW = (pw - 56) / level.proofSlots;
  state.proofSlots.forEach((slot, i) => {
    const sx = px + 24 + i * (slotW + 8);
    const sy = top + 56;
    roundRect(ctx, sx, sy, slotW, 160, 12);
    ctx.fillStyle = '#fdf0cf';
    ctx.fill();
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = C.proofDeep;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = C.sub;
    ctx.font = '13px "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`槽位 ${i + 1}`, sx + slotW / 2, sy + 22);
    const d = slot.doughId ? state.doughs.find((x) => x.id === slot.doughId) : null;
    if (d) drawDough(ctx, hits, d, sx + slotW / 2, sy + 96, 34, input, level.maxDoneness);
    else {
      hits.push({ id: `zone-proof-${i}`, x: sx, y: sy, w: slotW, h: 160, kind: 'zone', payload: 'proof' });
      ctx.fillStyle = C.ghost;
      ctx.font = '13px "PingFang SC", sans-serif';
      ctx.fillText('空槽 · 选中面团后点此入箱', sx + slotW / 2, sy + 96);
    }
  });

  // 凉架
  const rx = 24;
  const ry = top + ph + 16;
  const rh = 180;
  zoneFrame(ctx, rx, ry, pw, rh, `凉架（每拍 +${level.rackRate}，比温箱慢）`, C.rack, C.rackDeep);
  const rackDoughs = state.doughs.filter((d) => d.zone === 'rack');
  if (rackDoughs.length === 0) {
    roundRect(ctx, rx + 24, ry + 52, pw - 48, 104, 12);
    ctx.fillStyle = '#eef4f8';
    ctx.fill();
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = C.rackDeep;
    ctx.stroke();
    ctx.setLineDash([]);
    hits.push({ id: 'zone-rack', x: rx + 24, y: ry + 52, w: pw - 48, h: 104, kind: 'zone', payload: 'rack' });
    ctx.fillStyle = C.ghost;
    ctx.font = '13px "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('空凉架 · 选中面团后点此上架', rx + pw / 2, ry + 108);
  } else {
    const step = (pw - 48) / rackDoughs.length;
    rackDoughs.forEach((d, i) => {
      drawDough(ctx, hits, d, rx + 24 + step * (i + 0.5), ry + 108, 32, input, level.maxDoneness);
    });
  }

  // 烤炉（右上）
  const ox = 468;
  const ow = 300;
  const oh = 250;
  zoneFrame(ctx, ox, top, ow, oh, `烤炉（一次一团，占炉 ${level.ovenBakeTurns} 拍，炉内熟度冻结）`, C.oven, C.ovenDeep);
  roundRect(ctx, ox + 24, top + 56, ow - 48, 160, 12);
  ctx.fillStyle = '#fbe4da';
  ctx.fill();
  ctx.setLineDash([6, 5]);
  ctx.strokeStyle = C.ovenDeep;
  ctx.stroke();
  ctx.setLineDash([]);
  const ovenDough = state.ovenDoughId ? state.doughs.find((d) => d.id === state.ovenDoughId) : null;
  if (ovenDough) {
    drawDough(ctx, hits, ovenDough, ox + ow / 2, top + 128, 38, input, level.maxDoneness);
    ctx.fillStyle = C.ovenDeep;
    ctx.font = 'bold 15px "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`烘烤中 · 剩余 ${ovenDough.ovenRemaining} 拍`, ox + ow / 2, top + 196);
  } else {
    hits.push({ id: 'zone-oven', x: ox + 24, y: top + 56, w: ow - 48, h: 160, kind: 'zone', payload: 'oven' });
    ctx.fillStyle = C.ghost;
    ctx.font = '13px "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('烤炉空闲 · 选中面团后点此入炉', ox + ow / 2, top + 140);
  }

  // 案板（右中，未入任何工位的面团在这）
  const bx = 468;
  const by = top + oh + 16;
  const bh = 180;
  zoneFrame(ctx, bx, by, ow, bh, '案板（未入工位，每拍熟度不变）', C.bench, '#9a7a4e');
  const benchDoughs = state.doughs.filter((d) => d.zone === 'bench');
  if (benchDoughs.length === 0) {
    ctx.fillStyle = C.ghost;
    ctx.font = '13px "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('案板已空', bx + ow / 2, by + 108);
  } else {
    const step = (ow - 40) / benchDoughs.length;
    benchDoughs.forEach((d, i) => {
      drawDough(ctx, hits, d, bx + 20 + step * (i + 0.5), by + 104, 30, input, level.maxDoneness);
    });
  }
}

function zoneFrame(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  title: string,
  color: string,
  deep: string,
): void {
  roundRect(ctx, x, y, w, h, 14);
  ctx.fillStyle = C.panel;
  ctx.fill();
  ctx.strokeStyle = C.panelStroke;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = color;
  roundRect(ctx, x, y, 8, h, 4);
  ctx.fill();
  ctx.fillStyle = deep;
  ctx.font = 'bold 15px "PingFang SC", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(title, x + 20, y + 30);
}

// ─── 面团（含熟度刻度条与窗口标记） ───
function drawDough(
  ctx: CanvasRenderingContext2D,
  hits: HitTarget[],
  d: DoughState,
  cx: number,
  cy: number,
  r: number,
  input: RenderInput,
  maxDoneness: number,
): void {
  const selected = input.selectedDoughId === d.id;
  // 计划移动的目标面团给虚线高亮
  const planned =
    input.simulation === null &&
    input.pendingAction.type === 'move' &&
    input.pendingAction.doughId === d.id;

  ctx.save();
  if (selected || planned) {
    ctx.beginPath();
    ctx.arc(cx, cy, r + 8, 0, Math.PI * 2);
    ctx.strokeStyle = selected ? C.accent : C.proofDeep;
    ctx.lineWidth = 3;
    ctx.setLineDash(selected ? [] : [5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = doughColor(d.zone);
  ctx.fill();
  ctx.strokeStyle = C.accent;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = C.ink;
  ctx.font = 'bold 17px "PingFang SC", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(d.id, cx, cy + 6);
  ctx.restore();

  // 熟度刻度条（0–maxDoneness），窗口区间着色
  const barW = 84;
  const barH = 8;
  const barX = cx - barW / 2;
  const barY = cy + r + 10;
  const [lo, hi] = d.window;
  ctx.fillStyle = '#e6dac2';
  roundRect(ctx, barX, barY, barW, barH, 4);
  ctx.fill();
  const wx = barX + (lo / maxDoneness) * barW;
  const ww = ((hi - lo) / maxDoneness) * barW;
  ctx.fillStyle = 'rgba(90,143,74,0.55)';
  roundRect(ctx, wx, barY, ww, barH, 4);
  ctx.fill();
  const curW = Math.max(3, (d.doneness / maxDoneness) * barW);
  ctx.fillStyle = d.doneness < lo ? C.warn : d.doneness > hi ? C.bad : C.ok;
  roundRect(ctx, barX, barY, curW, barH, 4);
  ctx.fill();
  ctx.fillStyle = C.ink;
  ctx.font = '12px "PingFang SC", sans-serif';
  ctx.fillText(`熟度 ${d.doneness} / 窗口[${lo},${hi}]`, cx, barY + 22);
  ctx.textAlign = 'left';

  if (d.zone !== 'delivered' && d.zone !== 'failed' && d.zone !== 'oven') {
    hits.push({ id: `dough-${d.id}`, x: cx - r - 10, y: cy - r - 10, w: 2 * r + 20, h: 2 * r + 44, kind: 'dough', payload: d.id });
  }
}

// ─── 订单面板（含赶单分析） ───
function renderOrders(ctx: CanvasRenderingContext2D, input: RenderInput, _hits: HitTarget[]): void {
  const x = 792;
  const y = 92;
  const w = W - x - 16;
  const h = 446;
  roundRect(ctx, x, y, w, h, 14);
  ctx.fillStyle = C.panel;
  ctx.fill();
  ctx.strokeStyle = C.panelStroke;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = C.ink;
  ctx.font = 'bold 16px "PingFang SC", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('订单与赶单分析', x + 18, y + 30);

  const catchMap = new Map(input.catchInfos.map((c) => [c.doughId, c]));
  let cy = y + 56;
  for (const d of input.state.doughs) {
    const cardH = 118;
    roundRect(ctx, x + 14, cy, w - 28, cardH, 10);
    ctx.fillStyle = '#fff8ec';
    ctx.fill();
    ctx.strokeStyle = C.panelStroke;
    ctx.stroke();

    ctx.fillStyle = doughColor(d.zone);
    ctx.beginPath();
    ctx.arc(x + 36, cy + 30, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = C.accent;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = C.ink;
    ctx.font = 'bold 16px "PingFang SC", sans-serif';
    ctx.fillText(`${d.name} 的单`, x + 56, cy + 36);

    ctx.font = '13px "PingFang SC", sans-serif';
    ctx.fillStyle = C.sub;
    ctx.fillText(`窗口 [${d.window[0]}, ${d.window[1]}] · 截止第 ${d.deadline} 拍交单`, x + 56, cy + 58);
    ctx.fillText(`当前熟度 ${d.doneness} · 位置 ${ZONE_NAME[d.zone]}`, x + 56, cy + 78);

    // 状态徽标
    const info = catchMap.get(d.id);
    let label: string;
    let color: string;
    if (d.zone === 'delivered') {
      label = '已合格交单';
      color = C.ok;
    } else if (d.zone === 'failed') {
      label = '已退单';
      color = C.bad;
    } else if (info?.status === 'impossible') {
      label = '已赶不上';
      color = C.bad;
    } else if (info?.status === 'tight') {
      label = '档期紧张';
      color = C.warn;
    } else {
      label = '赶得上';
      color = C.ok;
    }
    const badgeW = 96;
    roundRect(ctx, x + w - badgeW - 28, cy + 20, badgeW, 28, 14);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 13px "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(label, x + w - badgeW - 28 + badgeW / 2, cy + 39);
    ctx.textAlign = 'left';

    if (info && d.zone !== 'delivered' && d.zone !== 'failed') {
      ctx.fillStyle = C.sub;
      ctx.font = '12px "PingFang SC", sans-serif';
      wrapText(ctx, info.detail, x + 20, cy + 98, w - 40, 15);
    }
    cy += cardH + 10;
  }

  // 交单记录（成功/失败分别留痕，互不覆盖）
  cy += 4;
  ctx.fillStyle = C.ink;
  ctx.font = 'bold 14px "PingFang SC", sans-serif';
  ctx.fillText('交单记录', x + 18, cy);
  cy += 8;
  if (input.state.deliveries.length === 0) {
    ctx.fillStyle = C.ghost;
    ctx.font = '12px "PingFang SC", sans-serif';
    ctx.fillText('（暂无）', x + 18, cy + 18);
  } else {
    for (const r of input.state.deliveries) {
      cy += 18;
      const map = { success: ['✔ 成功', C.ok], early: ['✖ 夹生退单', C.bad], late: ['✖ 烤过退单', C.bad], overdue: ['✖ 超时退单', C.warn] } as const;
      const [txt, col] = map[r.result];
      ctx.fillStyle = col;
      ctx.font = 'bold 12px "PingFang SC", sans-serif';
      ctx.fillText(`${txt}`, x + 18, cy);
      ctx.fillStyle = C.sub;
      ctx.font = '12px "PingFang SC", sans-serif';
      ctx.fillText(`${r.doughId} 团 · 第${r.turn}拍 · 熟度${r.doneness}`, x + 92, cy);
    }
  }
}

// ─── 底栏：本拍计划与操作按钮 ───
function renderDock(ctx: CanvasRenderingContext2D, input: RenderInput, hits: HitTarget[]): void {
  const x = 24;
  const y = 640;
  const w = W - 48;
  roundRect(ctx, x, y, w, 124, 14);
  ctx.fillStyle = C.panel;
  ctx.fill();
  ctx.strokeStyle = C.panelStroke;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.fillStyle = C.ink;
  ctx.font = 'bold 15px "PingFang SC", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(input.pendingText, x + 20, y + 32);
  ctx.fillStyle = C.sub;
  ctx.font = '13px "PingFang SC", sans-serif';
  ctx.fillText('点面团选中，再点温箱/凉架/烤炉工位制定主要操作；每拍仅一次主要操作，调档不占次数。', x + 20, y + 54);

  dockButton(ctx, hits, 'btn-pass', '空拍', x + 20, y + 70, 90, 38, C.ghost);
  dockButton(ctx, hits, 'btn-sim', '模拟这一拍 (S)', x + 124, y + 70, 170, 38, C.rackDeep);
  dockButton(ctx, hits, 'btn-commit', '提交并结算 (空格)', x + 308, y + 70, 190, 38, C.accent);
  dockButton(ctx, hits, 'btn-back', '返回选关', x + 512, y + 70, 130, 38, C.ghost);

  // 结算顺序提示
  ctx.fillStyle = C.sub;
  ctx.font = '12px "PingFang SC", sans-serif';
  ctx.fillText('结算顺序：① 换位 → ② 烤炉倒数/交单 → ③ 温箱按档加熟度 → ④ 凉架慢速加熟度', x + 670, y + 94);
}

function dockButton(
  ctx: CanvasRenderingContext2D,
  hits: HitTarget[],
  id: string,
  label: string,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
): void {
  roundRect(ctx, x, y, w, h, 10);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.fillStyle = '#fff8ec';
  ctx.font = 'bold 14px "PingFang SC", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(label, x + w / 2, y + h / 2 + 5);
  ctx.textAlign = 'left';
  hits.push({ id, x, y, w, h, kind: 'button' });
}

// ─── 日志（右栏底部浮窗，显示最近 7 条） ───
function renderLog(ctx: CanvasRenderingContext2D, input: RenderInput): void {
  const lines = input.state.log.slice(-7);
  const x = 792;
  const y = 548;
  const w = W - x - 16;
  const h = 80;
  roundRect(ctx, x, y, w, h, 12);
  ctx.fillStyle = 'rgba(251,245,232,0.96)';
  ctx.fill();
  ctx.strokeStyle = C.panelStroke;
  ctx.stroke();
  ctx.fillStyle = C.ink;
  ctx.font = 'bold 13px "PingFang SC", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('操作日志（最近 7 条）', x + 14, y + 20);
  ctx.font = '11.5px "PingFang SC", sans-serif';
  lines.forEach((l, i) => {
    ctx.fillStyle = l.kind === 'result' ? C.bad : l.kind === 'tick' ? C.sub : C.ink;
    const text = `T${l.turn} ${l.text}`;
    ctx.fillText(text.length > 34 ? text.slice(0, 34) + '…' : text, x + 14, y + 38 + i * 13);
  });
}

// ─── 模拟浮层 ───
let simCloseRect = { x: 0, y: 0, w: 0, h: 0 };
export function getSimCloseRect(): { x: number; y: number; w: number; h: number } {
  return simCloseRect;
}

function renderSimulation(ctx: CanvasRenderingContext2D, input: RenderInput, sim: SimulationResult): void {
  const x = 140;
  const y = 110;
  const w = W - 280;
  const h = 480;
  ctx.fillStyle = 'rgba(74,56,38,0.45)';
  ctx.fillRect(0, 0, W, H);
  roundRect(ctx, x, y, w, h, 16);
  ctx.fillStyle = C.panel;
  ctx.fill();
  ctx.strokeStyle = C.accent;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = C.ink;
  ctx.font = 'bold 20px "PingFang SC", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`模拟预览：第 ${input.state.turn} 拍提交后会发生什么（尚未生效）`, x + 24, y + 38);

  if (sim.rejected) {
    ctx.fillStyle = C.bad;
    ctx.font = '15px "PingFang SC", sans-serif';
    wrapText(ctx, `操作被拒绝：${sim.rejected}`, x + 24, y + 80, w - 48, 24);
  } else {
    // 熟度前后对照
    const before = new Map(input.state.doughs.map((d) => [d.id, d]));
    let ey = y + 78;
    ctx.fillStyle = C.sub;
    ctx.font = '13px "PingFang SC", sans-serif';
    ctx.fillText('面团熟度变化：', x + 24, ey);
    ey += 24;
    for (const after of sim.state.doughs) {
      const b = before.get(after.id)!;
      const delta = after.doneness - b.doneness;
      const zoneChange = after.zone !== b.zone ? `（${ZONE_NAME[b.zone]} → ${ZONE_NAME[after.zone]}）` : `（${ZONE_NAME[after.zone]}）`;
      ctx.fillStyle = delta > 0 ? C.warn : C.ink;
      ctx.font = '14px "PingFang SC", sans-serif';
      ctx.fillText(
        `${after.name}：熟度 ${b.doneness} → ${after.doneness}${delta ? `（+${delta}）` : '（不变）'} ${zoneChange}`,
        x + 40,
        ey,
      );
      ey += 24;
    }

    // 事件流（按结算顺序）
    ey += 8;
    ctx.fillStyle = C.ink;
    ctx.font = 'bold 14px "PingFang SC", sans-serif';
    ctx.fillText('结算事件流（顺序即实际结算顺序）：', x + 24, ey);
    ey += 26;
    ctx.font = '13px "PingFang SC", sans-serif';
    for (const ev of sim.events) {
      ctx.fillStyle = ev.kind === 'delivery' ? C.accent : C.sub;
      ctx.fillText('· ' + eventText(ev), x + 40, ey);
      ey += 22;
      if (ey > y + h - 60) {
        ctx.fillStyle = C.ghost;
        ctx.fillText('…', x + 40, ey);
        break;
      }
    }
  }

  const closeX = x + w - 150;
  const closeY = y + h - 52;
  simCloseRect = { x: closeX, y: closeY, w: 126, h: 36 };
  roundRect(ctx, closeX, closeY, 126, 36, 9);
  ctx.fillStyle = C.accent;
  ctx.fill();
  ctx.fillStyle = '#fff8ec';
  ctx.font = 'bold 15px "PingFang SC", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('关闭预览', closeX + 63, closeY + 23);
  ctx.textAlign = 'left';
}

function eventText(ev: SimulationResult['events'][number]): string {
  switch (ev.kind) {
    case 'move':
      return `换位：${ev.doughId} 团 ${ZONE_NAME[ev.from]} → ${ZONE_NAME[ev.to]}`;
    case 'pass':
      return '空拍：不移动任何面团';
    case 'oven-tick':
      return `烤炉倒数：${ev.doughId} 团剩余 ${ev.remaining} 拍`;
    case 'bake-done':
      return `烤炉完成：${ev.doughId} 团出炉，准备交单`;
    case 'delivery': {
      const map = { success: '成功', early: '夹生退单（太早）', late: '烤过退单（超窗口）', overdue: '超时退单（超截止）' } as const;
      return `交单判定：${ev.delivery.doughId} 团 → ${map[ev.delivery.result]}，熟度 ${ev.delivery.doneness}`;
    }
    case 'proof-tick':
      return `温箱结算：${ev.doughId} 团 +${ev.amount} → ${ev.doneness}`;
    case 'rack-tick':
      return `凉架结算：${ev.doughId} 团 +${ev.amount} → ${ev.doneness}`;
  }
}

// ─── 结束横幅 ───
function renderEndBanner(ctx: CanvasRenderingContext2D, won: boolean): void {
  ctx.fillStyle = 'rgba(74,56,38,0.5)';
  ctx.fillRect(0, 0, W, H);
  const bw = 420;
  const bh = 200;
  const x = W / 2 - bw / 2;
  const y = H / 2 - bh / 2;
  roundRect(ctx, x, y, bw, bh, 16);
  ctx.fillStyle = C.panel;
  ctx.fill();
  ctx.strokeStyle = won ? C.ok : C.bad;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = won ? C.ok : C.bad;
  ctx.font = 'bold 30px "PingFang SC", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(won ? '通关！' : '本关失败', W / 2, y + 66);
  ctx.fillStyle = C.sub;
  ctx.font = '15px "PingFang SC", sans-serif';
  ctx.fillText(won ? '所有订单都在窗口内准时交单' : '可撤销回到整回合开始重试，或重置本关', W / 2, y + 100);
  roundRect(ctx, x + 40, y + 130, 160, 42, 10);
  ctx.fillStyle = C.accent;
  ctx.fill();
  ctx.fillStyle = '#fff8ec';
  ctx.font = 'bold 15px "PingFang SC", sans-serif';
  ctx.fillText('撤销 (U)', x + 120, y + 157);
  roundRect(ctx, x + 220, y + 130, 160, 42, 10);
  ctx.fillStyle = C.ghost;
  ctx.fill();
  ctx.fillText('重置 (R)', x + 300, y + 157);
  ctx.textAlign = 'left';
}
