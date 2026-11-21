import type { Snapshot } from '../core/types.ts';
import type { Scenario } from '../core/scenario.ts';
import { VIEWPORT_H, VIEWPORT_W } from '../core/simulation.ts';
import { fpsColor } from './renderer.ts';

export interface ReplayRun {
  fps: number;
  snapshots: Snapshot[];
  visible: boolean;
}

export interface ReplayState {
  scenario: Scenario;
  runs: ReplayRun[];
  /** 当前回放时间(秒) */
  t: number;
}

interface OverviewTransform {
  s: number;
  ox: number;
  oy: number;
  toScreen: (x: number, y: number) => [number, number];
}

function buildTransform(world: { w: number; h: number }): OverviewTransform {
  const pad = 60;
  const s = Math.min(
    (VIEWPORT_W - pad * 2) / world.w,
    (VIEWPORT_H - pad * 2) / world.h,
  );
  const ox = (VIEWPORT_W - world.w * s) / 2;
  const oy = (VIEWPORT_H - world.h * s) / 2;
  return {
    s,
    ox,
    oy,
    toScreen: (x, y) => [ox + x * s, oy + y * s],
  };
}

function findFrame(run: ReplayRun, t: number): Snapshot {
  const arr = run.snapshots;
  let lo = 0;
  let hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(arr[lo - 1].t - t) < Math.abs(arr[lo].t - t)) {
    return arr[lo - 1];
  }
  return arr[lo];
}

/** 回放模式: 世界俯视图, 叠加各帧率下的镜头边框与运动轨迹 */
export function renderReplay(ctx: CanvasRenderingContext2D, state: ReplayState): void {
  const { scenario, runs, t } = state;
  ctx.clearRect(0, 0, VIEWPORT_W, VIEWPORT_H);
  ctx.fillStyle = '#10131a';
  ctx.fillRect(0, 0, VIEWPORT_W, VIEWPORT_H);

  const tr = buildTransform(scenario.world);
  const { toScreen, s } = tr;

  // 世界边界 + 网格
  const [wx, wy] = toScreen(scenario.world.x, scenario.world.y);
  ctx.save();
  ctx.strokeStyle = 'rgba(140,150,170,0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let gx = wx; gx <= wx + scenario.world.w * s; gx += 100 * s) {
    ctx.moveTo(gx, wy);
    ctx.lineTo(gx, wy + scenario.world.h * s);
  }
  for (let gy = wy; gy <= wy + scenario.world.h * s; gy += 100 * s) {
    ctx.moveTo(wx, gy);
    ctx.lineTo(wx + scenario.world.w * s, gy);
  }
  ctx.stroke();
  ctx.strokeStyle = '#adb5bd';
  ctx.lineWidth = 2;
  ctx.strokeRect(wx, wy, scenario.world.w * s, scenario.world.h * s);
  ctx.restore();

  // 预设路径
  for (const a of scenario.actors) {
    ctx.save();
    ctx.strokeStyle = a.color;
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    a.path.forEach((k, i) => {
      const [px, py] = toScreen(k.x, k.y);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
    ctx.restore();
  }

  // 各帧率的镜头边框(含已走过的中心轨迹)
  for (const run of runs) {
    if (!run.visible) continue;
    const color = fpsColor(run.fps);
    const frame = findFrame(run, t);

    // 镜头中心走过的轨迹
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const snap of run.snapshots) {
      if (snap.t > t) break;
      const [px, py] = toScreen(snap.camera.cx, snap.camera.cy);
      if (snap === run.snapshots[0]) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.restore();

    // 当前镜头视口矩形
    const v = frame.camera.view;
    const [vx, vy] = toScreen(v.x, v.y);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.95;
    ctx.lineWidth = frame.camera.limits.length > 0 ? 3.5 : 2;
    if (frame.camera.limits.length > 0) ctx.setLineDash([]);
    else ctx.setLineDash([10, 6]);
    ctx.strokeRect(vx, vy, v.w * s, v.h * s);
    ctx.setLineDash([]);

    // 镜头中心
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1;
    const [cx, cy] = toScreen(frame.camera.cx, frame.camera.cy);
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    // 理想镜头中心(十字)
    const [dx, dy] = toScreen(frame.camera.desiredCx, frame.camera.desiredCy);
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.moveTo(dx - 6, dy);
    ctx.lineTo(dx + 6, dy);
    ctx.moveTo(dx, dy - 6);
    ctx.lineTo(dx, dy + 6);
    ctx.stroke();

    // 帧率标签
    ctx.globalAlpha = 1;
    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = color;
    const tag = `${run.fps}fps${
      frame.camera.limits.length > 0 ? ' ⚠ ' + frame.camera.limits.join(',') : ''
    }`;
    ctx.fillText(tag, vx + 4, vy - 6);
    ctx.restore();
  }

  // 角色当前位置(取 60fps 参考帧; 位置只取决于路径, 各帧率一致)
  const ref = runs.find((r) => r.fps === 60) ?? runs[0];
  const refFrame = findFrame(ref, t);
  for (const snap of refFrame.actors) {
    const actor = scenario.actors.find((a) => a.id === snap.id)!;
    const [px, py] = toScreen(snap.x, snap.y);
    ctx.save();
    ctx.fillStyle = actor.color;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (actor.shape === 'circle') {
      ctx.arc(px, py, Math.max(6, actor.radius * s), 0, Math.PI * 2);
    } else if (actor.shape === 'square') {
      const r = Math.max(5, actor.radius * s);
      ctx.rect(px - r, py - r, r * 2, r * 2);
    } else {
      const r = Math.max(6, actor.radius * s);
      ctx.moveTo(px, py - r);
      ctx.lineTo(px + r * 0.9, py + r * 0.7);
      ctx.lineTo(px - r * 0.9, py + r * 0.7);
      ctx.closePath();
    }
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#e9ecef';
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(actor.id, px, py - Math.max(8, actor.radius * s) - 4);
    ctx.restore();
  }

  // 时间轴信息
  ctx.save();
  ctx.fillStyle = '#ced4da';
  ctx.font = '13px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(`回放时间 t = ${t.toFixed(2)}s`, 16, 24);
  ctx.restore();
}
