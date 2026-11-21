import type { Actor, Rect, Snapshot } from '../core/types.ts';
import type { Scenario } from '../core/scenario.ts';
import { VIEWPORT_H, VIEWPORT_W } from '../core/simulation.ts';
import type { CameraRig } from '../core/camera.ts';

export interface Trail {
  actorId: string;
  points: Array<{ x: number; y: number }>;
}

const FPS_COLORS: Record<number, string> = {
  15: '#e03131',
  30: '#f08c00',
  60: '#1c7ed6',
};

export function fpsColor(fps: number): string {
  return FPS_COLORS[fps] ?? '#868e96';
}

function drawShape(
  ctx: CanvasRenderingContext2D,
  actor: Actor,
  x: number,
  y: number,
  alpha = 1,
): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = actor.color;
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (actor.shape === 'circle') {
    ctx.arc(x, y, actor.radius, 0, Math.PI * 2);
  } else if (actor.shape === 'square') {
    ctx.rect(x - actor.radius, y - actor.radius, actor.radius * 2, actor.radius * 2);
  } else {
    const r = actor.radius;
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r * 0.9, y + r * 0.7);
    ctx.lineTo(x - r * 0.9, y + r * 0.7);
    ctx.closePath();
  }
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawWorldChrome(
  ctx: CanvasRenderingContext2D,
  world: Rect,
  toScreen: (x: number, y: number) => [number, number],
  scale: number,
): void {
  const [x0, y0] = toScreen(world.x, world.y);
  const [x1, y1] = toScreen(world.x + world.w, world.y + world.h);

  ctx.save();
  ctx.strokeStyle = 'rgba(140,150,170,0.35)';
  ctx.lineWidth = 1;
  const grid = 100 * scale;
  ctx.beginPath();
  for (let x = x0; x <= x1; x += grid) {
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y1);
  }
  for (let y = y0; y <= y1; y += grid) {
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
  }
  ctx.stroke();

  ctx.strokeStyle = '#adb5bd';
  ctx.lineWidth = 2;
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  ctx.restore();
}

function drawPaths(
  ctx: CanvasRenderingContext2D,
  scenario: Scenario,
  toScreen: (x: number, y: number) => [number, number],
): void {
  for (const a of scenario.actors) {
    ctx.save();
    ctx.strokeStyle = a.color;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 8]);
    ctx.beginPath();
    a.path.forEach((k, i) => {
      const [sx, sy] = toScreen(k.x, k.y);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    ctx.stroke();
    ctx.setLineDash([]);
    // 关键帧点
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = a.color;
    for (const k of a.path) {
      const [sx, sy] = toScreen(k.x, k.y);
      ctx.beginPath();
      ctx.arc(sx, sy, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

export interface LiveOverlay {
  camera: CameraRig;
  scenario: Scenario;
  trails: Trail[];
  snapshot: Snapshot;
  dragId: string | null;
}

/** 实时模式: 以镜头视口渲染(带安全区、轨迹、裁切箭头、限制徽标) */
export function renderLive(ctx: CanvasRenderingContext2D, ov: LiveOverlay): void {
  const { camera, scenario, trails, snapshot, dragId } = ov;
  ctx.clearRect(0, 0, VIEWPORT_W, VIEWPORT_H);
  ctx.fillStyle = '#10131a';
  ctx.fillRect(0, 0, VIEWPORT_W, VIEWPORT_H);

  const k = 1 / camera.zoom;
  ctx.save();
  ctx.translate(VIEWPORT_W / 2, VIEWPORT_H / 2);
  ctx.scale(k, k);
  ctx.translate(-camera.cx, -camera.cy);

  const toScreen = (x: number, y: number): [number, number] => [
    (x - camera.cx) * k + VIEWPORT_W / 2,
    (y - camera.cy) * k + VIEWPORT_H / 2,
  ];

  drawWorldChrome(ctx, scenario.world, toScreen, k);
  drawPaths(ctx, scenario, toScreen);

  // 运动轨迹
  for (const trail of trails) {
    const actor = scenario.actors.find((a) => a.id === trail.actorId)!;
    if (trail.points.length < 2) continue;
    ctx.save();
    ctx.strokeStyle = actor.color;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 3;
    ctx.beginPath();
    trail.points.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();
    ctx.restore();
  }

  // 角色
  for (const snap of snapshot.actors) {
    const actor = scenario.actors.find((a) => a.id === snap.id)!;
    const followed = snapshot.camera.followIds.includes(snap.id);
    drawShape(ctx, actor, snap.x, snap.y);
    if (followed) {
      ctx.save();
      ctx.strokeStyle = '#ffd43b';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(snap.x, snap.y, actor.radius + 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    if (dragId === snap.id) {
      ctx.save();
      ctx.strokeStyle = '#ffffff';
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.arc(snap.x, snap.y, actor.radius + 12, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    ctx.save();
    ctx.fillStyle = '#e9ecef';
    ctx.font = 'bold 18px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(actor.id, snap.x, snap.y + 6);
    ctx.restore();
  }
  ctx.restore();

  // 安全区框(屏幕空间)
  const cfg = camera.config;
  const mx = VIEWPORT_W * cfg.safeMargin.x;
  const my = VIEWPORT_H * cfg.safeMargin.y;
  ctx.save();
  ctx.strokeStyle = 'rgba(77,232,144,0.9)';
  ctx.lineWidth = 2;
  ctx.setLineDash([10, 8]);
  ctx.strokeRect(mx, my, VIEWPORT_W - mx * 2, VIEWPORT_H - my * 2);
  ctx.fillStyle = 'rgba(77,232,144,0.8)';
  ctx.font = '13px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('安全区', mx + 6, my - 6);
  ctx.restore();

  // 被裁角色: 屏幕边缘箭头 + 触发的限制
  for (const clip of snapshot.camera.clips) {
    const actorSnap = snapshot.actors.find((a) => a.id === clip.actorId)!;
    const actor = scenario.actors.find((a) => a.id === clip.actorId)!;
    const sp = camera.worldToScreen({ x: actorSnap.x, y: actorSnap.y });
    const edgeX = Math.max(24, Math.min(VIEWPORT_W - 24, sp.x));
    const edgeY = Math.max(40, Math.min(VIEWPORT_H - 24, sp.y));
    ctx.save();
    ctx.fillStyle = '#ff6b6b';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(edgeX, edgeY, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#10131a';
    ctx.font = 'bold 14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(actor.id, edgeX, edgeY + 1);
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#ff8787';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(`裁切: ${clip.sides.join('/')}`, edgeX + 16, edgeY + 4);
    ctx.restore();
  }

  // 限制徽标
  const limits = snapshot.camera.limits;
  ctx.save();
  ctx.font = 'bold 14px system-ui, sans-serif';
  ctx.textAlign = 'right';
  const labels: Record<string, string> = {
    MIN_ZOOM: '已到最大放大 (MIN_ZOOM)',
    MAX_ZOOM: '间距超镜头能力 (MAX_ZOOM)',
    PAN_LIMIT_X: '水平平移触界 (PAN_LIMIT_X)',
    PAN_LIMIT_Y: '垂直平移触界 (PAN_LIMIT_Y)',
  };
  limits.forEach((r, i) => {
    const y = 28 + i * 24;
    const text = labels[r];
    const w = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(224,49,49,0.85)';
    ctx.fillRect(VIEWPORT_W - w - 20, y - 16, w + 16, 21);
    ctx.fillStyle = '#fff';
    ctx.fillText(text, VIEWPORT_W - 12, y);
  });
  ctx.restore();

  // 视口外的世界范围提示(平移范围边界在世界中的位置)
  ctx.save();
  ctx.strokeStyle = 'rgba(255,212,59,0.5)';
  ctx.setLineDash([4, 6]);
  ctx.lineWidth = 1.5;
  const b = cfg.panBounds;
  const [bx0, by0] = [
    (b.x - camera.cx) * k + VIEWPORT_W / 2,
    (b.y - camera.cy) * k + VIEWPORT_H / 2,
  ];
  const [bx1, by1] = [
    (b.x + b.w - camera.cx) * k + VIEWPORT_W / 2,
    (b.y + b.h - camera.cy) * k + VIEWPORT_H / 2,
  ];
  ctx.strokeRect(bx0, by0, bx1 - bx0, by1 - by0);
  ctx.restore();
}
