import { observeCue } from '../game/engine';
import {
  STATIONS,
  STATION_MAP,
  VIEW_H,
  VIEW_W,
  armTarget,
  eye,
  shoulder,
} from '../game/layout';
import { OBSTACLES, PARKED, blockedBy, obstacleAt } from '../game/obstacles';
import { actions, store } from '../game/store';
import { SYMBOL_MAP } from '../game/symbols';
import type { Cue, ObstacleDef, Pose, StationId } from '../game/types';

export const sceneApi = {
  // 由 mountScene 填充：触发一次前半拍 → 后半拍的扫动动画
  sweep: () => {},
};

interface DragState {
  obstacleId: string;
  pointerId: number;
  offsetX: number;
  offsetY: number;
  pose: Pose;
}

interface SweepState {
  cueId: string;
  start: number;
  duration: number;
}

const LEVEL_STYLE: Record<string, { bg: string; fg: string; text: string }> = {
  both: { bg: '#dcfce7', fg: '#15803d', text: '双清' },
  stitch: { bg: '#f3e8ff', fg: '#7e22ce', text: '分半拼见' },
  one: { bg: '#fef9c3', fg: '#a16207', text: '单旗' },
  none: { bg: '#fee2e2', fg: '#b91c1c', text: '全遮' },
};

export function mountScene(canvas: HTMLCanvasElement): () => void {
  const wrap = canvas.parentElement!;
  const ctx = canvas.getContext('2d')!;
  let cssW = VIEW_W;
  let cssH = VIEW_H;
  let raf = 0;
  let hoverId: string | null = null;
  let hoverStation: StationId | null = null;
  let drag: DragState | null = null;
  let sweep: SweepState | null = null;

  sceneApi.sweep = () => {
    const s = store.state;
    const cue = s.cursor > 0 ? s.cues[s.cursor - 1] : null;
    if (!cue) {
      store.notify('先走到有遮挡变化的一拍，再演示扫动', 'warn');
      return;
    }
    sweep = { cueId: cue.id, start: performance.now(), duration: 1100 };
  };

  const resize = () => {
    // 只用 clientWidth（不含 .canvas-wrap 的 1px 边框）；
    // 显示尺寸完全交给 CSS width:100% / height:auto，避免写显式 px 造成 ResizeObserver 正反馈。
    const w = wrap.clientWidth || VIEW_W;
    cssW = w;
    cssH = (cssW * VIEW_H) / VIEW_W;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  };
  const ro = new ResizeObserver(resize);
  ro.observe(wrap);
  resize();

  const toLogic = (ev: PointerEvent): Pose => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((ev.clientX - rect.left) / rect.width) * VIEW_W,
      y: ((ev.clientY - rect.top) / rect.height) * VIEW_H,
    };
  };

  const activeCue = (): Cue | null => {
    const s = store.state;
    return s.cursor > 0 ? s.cues[s.cursor - 1] ?? null : null;
  };

  const editablePoses = (cue: Cue | null): Record<string, Pose> =>
    cue ? cue.layouts[store.state.editHalf] : PARKED;

  canvas.addEventListener('pointerdown', (ev) => {
    const p = toLogic(ev);
    const cue = activeCue();
    if (!cue) return;
    const poses = editablePoses(cue);
    const id = obstacleAt(p.x, p.y, poses);
    if (id) {
      const pose = poses[id];
      drag = {
        obstacleId: id,
        pointerId: ev.pointerId,
        offsetX: p.x - pose.x,
        offsetY: p.y - pose.y,
        pose: { ...pose },
      };
      canvas.setPointerCapture(ev.pointerId);
      canvas.style.cursor = 'grabbing';
      return;
    }
    // 点站台：聚焦该台视线与收条
    for (const st of STATIONS) {
      const sh = shoulder(st.id);
      if (Math.hypot(p.x - sh.x, p.y - (sh.y - 20)) < 64) {
        store.set({ observerFilter: st.id, editorStation: st.id });
        return;
      }
    }
  });

  canvas.addEventListener('pointermove', (ev) => {
    const p = toLogic(ev);
    if (drag && drag.pointerId === ev.pointerId) {
      drag.pose = {
        x: Math.max(24, Math.min(VIEW_W - 24, p.x - drag.offsetX)),
        y: Math.max(40, Math.min(VIEW_H - 16, p.y - drag.offsetY)),
      };
      actions.markDragTouched();
      return;
    }
    const cue = activeCue();
    hoverId = cue ? obstacleAt(p.x, p.y, editablePoses(cue)) : null;
    hoverStation = null;
    for (const st of STATIONS) {
      const sh = shoulder(st.id);
      if (Math.hypot(p.x - sh.x, p.y - (sh.y - 20)) < 64) {
        hoverStation = st.id;
        break;
      }
    }
    canvas.style.cursor = hoverId ? 'grab' : hoverStation ? 'pointer' : 'default';
  });

  const endDrag = (ev: PointerEvent) => {
    if (drag && drag.pointerId === ev.pointerId) {
      const cue = activeCue();
      if (cue) {
        actions.commitDrag(cue.id, store.state.editHalf, drag.obstacleId, drag.pose);
      }
      try {
        canvas.releasePointerCapture(ev.pointerId);
      } catch {
        /* noop */
      }
      drag = null;
      canvas.style.cursor = 'grab';
    }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  const render = (now: number) => {
    const s = store.state;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const scale = cssW / VIEW_W;
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
    ctx.clearRect(0, 0, VIEW_W, VIEW_H);

    const cue = activeCue();

    // 扫动动画状态
    let sweepT: number | null = null;
    if (sweep && cue && sweep.cueId === cue.id) {
      const t = Math.min(1, (now - sweep.start) / sweep.duration);
      sweepT = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      if (t >= 1) sweep = null;
    } else if (sweep && (!cue || sweep.cueId !== cue.id)) {
      sweep = null;
    }

    drawBackground(ctx, now);
    drawRidges(ctx);

    if (cue) drawSightlines(ctx, cue, s.observerFilter, s.editHalf);

    for (const st of STATIONS) {
      const isSender = cue?.sender === st.id;
      const symbolId = isSender && cue ? cue.symbolId : 'end';
      drawStation(ctx, st.id, symbolId, isSender, now, hoverStation === st.id);
    }

    // 障碍物：扫动中用插值，否则画当前编辑半拍 + 另一半虚影
    if (cue && sweepT !== null) {
      for (const def of OBSTACLES) {
        const a = cue.layouts[0][def.id] ?? PARKED[def.id];
        const b = cue.layouts[1][def.id] ?? PARKED[def.id];
        drawObstacle(ctx, def, {
          x: a.x + (b.x - a.x) * sweepT,
          y: a.y + (b.y - a.y) * sweepT,
        }, false, hoverId === def.id && !drag);
      }
    } else {
      const otherHalf = (1 - s.editHalf) as 0 | 1;
      const ghostPoses = cue?.layouts[otherHalf] ?? null;
      if (ghostPoses) {
        for (const def of OBSTACLES) drawObstacle(ctx, def, ghostPoses[def.id], true, false);
      }
      const poses = cue ? cue.layouts[s.editHalf] : PARKED;
      for (const def of OBSTACLES) {
        const pose =
          drag?.obstacleId === def.id
            ? drag.pose
            : (poses[def.id] ?? PARKED[def.id]);
        drawObstacle(ctx, def, pose, false, hoverId === def.id || drag?.obstacleId === def.id);
      }
    }

    if (cue) drawObservationChips(ctx, cue);
    else drawIdleHint(ctx);

    raf = requestAnimationFrame(render);
  };
  raf = requestAnimationFrame(render);

  return () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
  };
}

// ---------------- 背景 ----------------

function drawBackground(ctx: CanvasRenderingContext2D, now: number) {
  const sky = ctx.createLinearGradient(0, 0, 0, VIEW_H);
  sky.addColorStop(0, '#eef4ff');
  sky.addColorStop(0.45, '#f6f1e7');
  sky.addColorStop(1, '#e7e0cf');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);

  // 太阳
  ctx.save();
  ctx.globalAlpha = 0.8;
  const sun = ctx.createRadialGradient(830, 96, 8, 830, 96, 70);
  sun.addColorStop(0, '#fde68a');
  sun.addColorStop(1, 'rgba(253,230,138,0)');
  ctx.fillStyle = sun;
  ctx.beginPath();
  ctx.arc(830, 96, 70, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#f59e0b';
  ctx.beginPath();
  ctx.arc(830, 96, 26, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // 远处缓慢漂移的薄云（纯装饰，不参与遮挡）
  ctx.save();
  ctx.globalAlpha = 0.5;
  const drift = (now / 90) % (VIEW_W + 260);
  drawCloudShape(ctx, { x: ((drift + 120) % (VIEW_W + 260)) - 130, y: 84 }, 0.7, '#ffffff');
  drawCloudShape(ctx, { x: ((drift * 0.7 + 520) % (VIEW_W + 260)) - 130, y: 150 }, 0.5, '#ffffff');
  ctx.restore();
}

function drawRidges(ctx: CanvasRenderingContext2D) {
  const layers = [
    { color: '#c7d2c4', base: 300, amp: 70, seed: 1 },
    { color: '#a8bba4', base: 360, amp: 90, seed: 4 },
    { color: '#829981', base: 470, amp: 70, seed: 8 },
  ];
  for (const l of layers) {
    ctx.fillStyle = l.color;
    ctx.beginPath();
    ctx.moveTo(0, VIEW_H);
    ctx.lineTo(0, l.base);
    for (let x = 0; x <= VIEW_W; x += 40) {
      const y =
        l.base -
        Math.sin(x / 130 + l.seed) * l.amp * 0.5 -
        Math.sin(x / 60 + l.seed * 2) * l.amp * 0.18;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(VIEW_W, VIEW_H);
    ctx.closePath();
    ctx.fill();
  }
}

// ---------------- 视线 ----------------

function drawSightlines(
  ctx: CanvasRenderingContext2D,
  cue: Cue,
  filter: StationId | 'all',
  half: 0 | 1,
) {
  const observers = (Object.keys(STATION_MAP) as StationId[]).filter((o) => o !== cue.sender);
  for (const ob of observers) {
    const alpha = filter === 'all' ? 0.5 : filter === ob ? 1 : 0.1;
    const e = eye(ob);
    const sym = SYMBOL_MAP[cue.symbolId];
    ([0, 1] as const).forEach((arm) => {
      const dir = sym.pair[arm];
      const t = armTarget(cue.sender, dir);
      const poses = cue.layouts[half];
      const blocked = halfBlocked(e, t, poses);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = blocked ? '#dc2626' : '#16a34a';
      ctx.lineWidth = filter === ob ? 2.2 : 1.4;
      ctx.setLineDash(blocked ? [3, 5] : [7, 6]);
      ctx.beginPath();
      ctx.moveTo(e.x, e.y);
      ctx.lineTo(t.x, t.y);
      ctx.stroke();
      ctx.setLineDash([]);
      if (blocked && alpha > 0.3) {
        const bx = e.x + (t.x - e.x) * 0.55;
        const by = e.y + (t.y - e.y) * 0.55;
        ctx.fillStyle = '#dc2626';
        ctx.font = 'bold 15px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText('✕', bx, by + 5);
      }
      ctx.restore();
    });
  }
}

function halfBlocked(e: Pose, t: Pose, poses: Record<string, Pose>): boolean {
  return OBSTACLES.some((def) => {
    const p = poses[def.id];
    return p ? blockedBy(e, t, p, def) : false;
  });
}

// ---------------- 站台与旗人 ----------------

function drawStation(
  ctx: CanvasRenderingContext2D,
  id: StationId,
  symbolId: string,
  active: boolean,
  now: number,
  hover: boolean,
) {
  const st = STATION_MAP[id];
  const sh = shoulder(id);

  // 山脊台面
  ctx.save();
  ctx.fillStyle = '#6b4f3a';
  ctx.beginPath();
  ctx.ellipse(st.x, st.y + 26, 92, 18, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#8a6a4d';
  ctx.fillRect(st.x - 78, st.y + 8, 156, 18);
  ctx.fillStyle = '#5b412f';
  for (const dx of [-60, -20, 20, 60]) ctx.fillRect(st.x + dx - 4, st.y + 24, 8, 34);
  ctx.restore();

  if (hover) {
    ctx.save();
    ctx.strokeStyle = '#0ea5e9';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.ellipse(st.x, st.y - 30, 58, 78, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // 身体（披风）
  ctx.save();
  const robe = active ? '#334155' : '#64748b';
  ctx.fillStyle = robe;
  ctx.beginPath();
  ctx.moveTo(sh.x - 17, sh.y + 4);
  ctx.quadraticCurveTo(sh.x, sh.y - 8, sh.x + 17, sh.y + 4);
  ctx.lineTo(sh.x + 24, st.y + 12);
  ctx.lineTo(sh.x - 24, st.y + 12);
  ctx.closePath();
  ctx.fill();
  // 头
  ctx.fillStyle = '#e8b98d';
  ctx.beginPath();
  ctx.arc(sh.x, sh.y - 22, 11, 0, Math.PI * 2);
  ctx.fill();
  // 斗笠
  ctx.fillStyle = '#7c5a36';
  ctx.beginPath();
  ctx.ellipse(sh.x, sh.y - 29, 18, 6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(sh.x - 9, sh.y - 37, 18, 9);
  ctx.beginPath();
  ctx.ellipse(sh.x, sh.y - 37, 9, 4, 0, Math.PI, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // 双臂 + 旗
  const sym = SYMBOL_MAP[symbolId] ?? SYMBOL_MAP.end;
  const breathe = active ? Math.sin(now / 500) * 1.2 : 0;
  (['#dc2626', '#2563eb'] as const).forEach((color, arm) => {
    const dir = sym.pair[arm as 0 | 1];
    const t = armTarget(id, dir);
    const sx = sh.x;
    const sy = sh.y + breathe;
    ctx.save();
    ctx.strokeStyle = '#1f2937';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(sx, sy + 2);
    ctx.lineTo(t.x, t.y);
    ctx.stroke();
    // 旗面
    const angle = Math.atan2(t.y - sy, t.x - sx);
    ctx.translate(t.x, t.y);
    ctx.rotate(angle);
    ctx.fillStyle = color;
    ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(2, -8);
    ctx.lineTo(24, 0);
    ctx.lineTo(2, 9);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.9)';
    ctx.font = 'bold 10px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(arm === 0 ? '朱' : '青', 10, 4);
    ctx.restore();
  });

  // 站名（避开台面与木腿）
  ctx.save();
  ctx.fillStyle = 'rgba(15,23,42,.85)';
  ctx.font = 'bold 17px "PingFang SC", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(st.name, st.x, st.y + 76);
  if (active) {
    ctx.fillStyle = '#b45309';
    ctx.font = '12px "PingFang SC", system-ui, sans-serif';
    ctx.fillText(`正在举「${sym.label}」`, st.x, st.y + 94);
  }
  ctx.restore();
}

// ---------------- 观测分级牌 ----------------

function drawObservationChips(ctx: CanvasRenderingContext2D, cue: Cue) {
  for (const ob of STATIONS) {
    if (ob.id === cue.sender) continue;
    const o = observeCue(cue, ob.id);
    const style = LEVEL_STYLE[o.level];
    const x = ob.x;
    const y = ob.y - 118;
    const w = 84;
    const h = 24;
    ctx.save();
    ctx.fillStyle = style.bg;
    ctx.strokeStyle = style.fg;
    ctx.lineWidth = 1.4;
    roundRect(ctx, x - w / 2, y - h / 2, w, h, 12);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = style.fg;
    ctx.font = 'bold 13px "PingFang SC", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(style.text, x, y + 1);
    ctx.restore();
  }
}

function drawIdleHint(ctx: CanvasRenderingContext2D) {
  ctx.save();
  ctx.fillStyle = 'rgba(15,23,42,.55)';
  ctx.font = '16px "PingFang SC", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('点「下一拍」开始；开演后可拖动云 / 雾 / 屏 / 盾改写当前半拍的视线', VIEW_W / 2, 40);
  ctx.restore();
}

// ---------------- 遮挡物 ----------------

function drawObstacle(
  ctx: CanvasRenderingContext2D,
  def: ObstacleDef,
  p: Pose,
  ghost: boolean,
  highlight: boolean,
) {
  ctx.save();
  if (ghost) ctx.globalAlpha = 0.28;
  if (def.shape.kind === 'cloud') {
    drawCloudShape(ctx, p, 1, ghost ? '#94a3b8' : '#ffffff');
    if (!ghost) {
      ctx.fillStyle = '#64748b';
      ctx.font = '11px "PingFang SC", system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(def.name, p.x, p.y + 38);
    }
  } else if (def.shape.kind === 'veil') {
    const r = def.shape.r;
    const g = ctx.createRadialGradient(p.x, p.y, 6, p.x, p.y, r + 14);
    g.addColorStop(0, ghost ? '#e2e8f0' : 'rgba(241,245,249,.96)');
    g.addColorStop(1, 'rgba(148,163,184,.55)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r + 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#475569';
    ctx.font = 'bold 15px "PingFang SC", system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('雾', p.x, p.y + 1);
  } else if (def.shape.kind === 'shield') {
    const r = def.shape.r;
    ctx.fillStyle = ghost ? '#d6d3d1' : '#b45309';
    ctx.strokeStyle = '#78350f';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#fde68a';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fill();
  } else {
    const { w, h } = def.shape;
    const g = ctx.createLinearGradient(p.x, p.y - h / 2, p.x, p.y + h / 2);
    g.addColorStop(0, '#b07a45');
    g.addColorStop(1, '#7c4a21');
    ctx.fillStyle = g;
    roundRect(ctx, p.x - w / 2, p.y - h / 2, w, h, 8);
    ctx.fill();
    ctx.strokeStyle = '#5b3413';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(60,32,10,.6)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(p.x - w / 2 + 12, p.y);
    ctx.lineTo(p.x + w / 2 - 12, p.y);
    ctx.moveTo(p.x, p.y - h / 2 + 4);
    ctx.lineTo(p.x, p.y + h / 2 - 4);
    ctx.stroke();
    ctx.fillStyle = '#f3e9d2';
    ctx.font = 'bold 13px "PingFang SC", system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('移动木屏', p.x, p.y + 1);
  }

  if (highlight && !ghost) {
    ctx.strokeStyle = '#0ea5e9';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([4, 4]);
    const r =
      def.shape.kind === 'screen'
        ? Math.max(def.shape.w, def.shape.h) / 2 + 10
        : (def.shape as { r?: number }).r ?? 46;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r + 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
}

function drawCloudShape(
  ctx: CanvasRenderingContext2D,
  p: Pose,
  scale: number,
  color: string,
) {
  const def = OBSTACLES[0];
  if (def.shape.kind !== 'cloud') return;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.scale(scale, scale);
  ctx.fillStyle = color;
  ctx.strokeStyle = '#c3cedd';
  ctx.lineWidth = 1.5;
  for (const c of def.shape.circles) {
    ctx.beginPath();
    ctx.arc(c.dx, c.dy, c.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, h);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
