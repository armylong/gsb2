import type { Character, World } from './sim/types.js';
import { GRAB_RANGE, HAND_OFFSET, ledgeCorner } from './sim/physics.js';
import type { SampleDef } from './sim/samples.js';

const STATE_COLOR: Record<string, string> = {
  ground: '#4da3ff',
  air: '#7ce7f4',
  wallslide: '#ffa940',
  ledge: '#ffe14d',
  mantle: '#d98cff',
};

const STATE_LABEL: Record<string, string> = {
  ground: '站立 ground',
  air: '空中 air',
  wallslide: '贴墙滑落 wallslide',
  ledge: '抓边悬挂 ledge',
  mantle: '翻身 mantle',
};

export interface RenderInfo {
  replay: { def: SampleDef; t: number } | null;
}

export function render(ctx: CanvasRenderingContext2D, world: World, c: Character, info: RenderInfo): void {
  const { width, height } = ctx.canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#14181f';
  ctx.fillRect(0, 0, width, height);

  // ---- 平台与障碍 ----
  for (const p of world.platforms) {
    ctx.fillStyle = p.grabbable ? '#2e4d3a' : '#3a3f4a';
    ctx.fillRect(p.x, p.y, p.w, p.h);
    if (p.grabbable) {
      ctx.fillStyle = '#58d68d';
      ctx.fillRect(p.x, p.y, p.w, 3); // 可抓顶面高亮
    }
  }
  // 顶部障碍画警示斜纹
  const obs = world.platforms.find((p) => p.id === 'obstacle');
  if (obs) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(obs.x, obs.y, obs.w, obs.h);
    ctx.clip();
    ctx.strokeStyle = 'rgba(255,90,90,0.6)';
    ctx.lineWidth = 2;
    for (let x = obs.x - obs.h; x < obs.x + obs.w + obs.h; x += 12) {
      ctx.beginPath();
      ctx.moveTo(x, obs.y + obs.h);
      ctx.lineTo(x + obs.h, obs.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---- 可抓范围可视化: 每个可抓顶角画绿色圆环 ----
  const handX = c.facing > 0 ? c.x + c.w : c.x;
  const handY = c.y + HAND_OFFSET;
  for (const p of world.platforms) {
    if (!p.grabbable) continue;
    for (const side of ['left', 'right'] as const) {
      const corner = ledgeCorner(p, side);
      const inRange = Math.abs(handX - corner.x) <= GRAB_RANGE && Math.abs(handY - corner.y) <= GRAB_RANGE;
      ctx.beginPath();
      ctx.arc(corner.x, corner.y, GRAB_RANGE, 0, Math.PI * 2);
      ctx.strokeStyle = inRange ? 'rgba(120,255,150,0.95)' : 'rgba(90,220,130,0.35)';
      ctx.lineWidth = inRange ? 2.5 : 1.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(corner.x, corner.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#58d68d';
      ctx.fill();
    }
  }

  // ---- 抓住的具体边缘: 黄色粗线段 + 标注 ----
  if (c.state === 'ledge' && c.ledge) {
    const plat = world.platforms.find((p) => p.id === c.ledge!.platId)!;
    const corner = ledgeCorner(plat, c.ledge.side);
    const segDir = c.ledge.side === 'left' ? 1 : -1;
    ctx.strokeStyle = '#ffe14d';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(corner.x, corner.y - 2);
    ctx.lineTo(corner.x + segDir * 34, corner.y - 2);
    ctx.stroke();
    ctx.fillStyle = '#ffe14d';
    ctx.font = '12px monospace';
    ctx.fillText(`抓住: ${plat.id} ${c.ledge.side === 'left' ? '左角' : '右角'}`, corner.x + segDir * 40, corner.y - 8);
  }

  // ---- 角色 ----
  ctx.fillStyle = STATE_COLOR[c.state] ?? '#fff';
  ctx.fillRect(c.x, c.y, c.w, c.h);
  // 空中画手部点, 便于对照可抓范围
  if (c.state === 'air' || c.state === 'wallslide') {
    ctx.beginPath();
    ctx.arc(handX, handY, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }
  // 朝向眼睛
  ctx.fillStyle = '#14181f';
  ctx.fillRect(c.facing > 0 ? c.x + c.w - 8 : c.x + 4, c.y + 8, 4, 4);

  // ---- HUD ----
  ctx.font = '14px monospace';
  ctx.fillStyle = STATE_COLOR[c.state] ?? '#fff';
  ctx.fillText(`状态: ${STATE_LABEL[c.state] ?? c.state}`, 12, 24);
  ctx.fillStyle = '#9aa4b2';
  ctx.font = '12px monospace';
  ctx.fillText('←→/AD 移动  Space/W 跳(贴墙时蹬墙跳)  S/↓ 松手  R 复位  1..5 回放样例', 12, height - 12);

  if (c.mantleBlockedFlash > 0) {
    ctx.fillStyle = '#ff5a5a';
    ctx.font = 'bold 15px monospace';
    ctx.fillText('顶部空间不足, 无法翻上 —— 保持悬挂', c.x - 60, c.y - 16);
  }

  if (info.replay) {
    ctx.fillStyle = '#ffd166';
    ctx.font = '13px monospace';
    ctx.fillText(`回放样例: ${info.replay.def.name}  t=${info.replay.t.toFixed(2)}s / ${info.replay.def.duration}s`, 12, 44);
    ctx.fillStyle = '#9aa4b2';
    ctx.fillText(info.replay.def.desc, 12, 62);
  }
}
