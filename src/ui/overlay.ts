import type { BatchPlan } from '../core/batching';
import type { Camera } from '../core/camera';
import type { Sprite } from '../core/types';

export interface OverlayInput {
  camera: Camera;
  /** 画面右上角的实时读数。 */
  hud: {
    visible: number;
    culled: number;
    batchCalls: number;
    refCalls: number;
    batches: number;
    frameDrawCalls: number;
  };
  /** 反例诊断是否开启（画面上给出提醒）。 */
  breakOrder: boolean;
  deviceWidth: number;
  deviceHeight: number;
  dpr: number;
  sprites: readonly Sprite[];
  plan: BatchPlan;
  selectedSpriteId: number | null;
  hoverSpriteId: number | null;
  /** 需要描边强调的批次（批次列表悬停 / 夹断芯片）。 */
  highlightBatches: ReadonlySet<number>;
  compareMode: number;
  split: number;
}

const PROBE_TONE: Record<string, string> = {
  A: 'rgba(120, 226, 255, 0.95)',
  B: 'rgba(255, 190, 105, 0.95)',
  C: 'rgba(255, 135, 180, 0.95)',
};

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawHud(
  ctx: CanvasRenderingContext2D,
  cssW: number,
  hud: OverlayInput['hud'],
): void {
  const lines = [
    ['入镜', `${hud.visible}`],
    ['合批绘制', `${hud.batchCalls}`],
    ['批次', `${hud.batches}`],
    ['参考绘制', `${hud.refCalls}`],
    ['本帧总调用', `${hud.frameDrawCalls}`],
  ] as const;
  const w = 168;
  const h = 22 + lines.length * 17;
  const x = cssW - w - 14;
  const y = 14;
  ctx.save();
  ctx.fillStyle = 'rgba(7, 11, 17, 0.82)';
  ctx.strokeStyle = 'rgba(70, 92, 118, 0.65)';
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, w, h, 8);
  ctx.fill();
  ctx.stroke();
  ctx.textBaseline = 'middle';
  lines.forEach(([k, v], i) => {
    const ly = y + 20 + i * 17;
    ctx.font = '10px ui-sans-serif, system-ui';
    ctx.fillStyle = 'rgba(150, 168, 190, 0.95)';
    ctx.textAlign = 'left';
    ctx.fillText(k, x + 10, ly);
    ctx.font = '600 11px ui-sans-serif, system-ui';
    ctx.fillStyle = i === 0 ? '#5bd6ff' : i === 1 ? '#ffd166' : '#e2ecf7';
    ctx.textAlign = 'right';
    ctx.fillText(v, x + w - 10, ly);
  });
  ctx.restore();
}

function drawChip(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  bg: string,
  fg: string,
  border: string,
): void {
  ctx.save();
  ctx.font = '11px ui-sans-serif, system-ui';
  const w = ctx.measureText(text).width + 12;
  const h = 18;
  ctx.fillStyle = bg;
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, w, h, 5);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = fg;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 6, y + h / 2 + 0.5);
  ctx.restore();
}

export function drawOverlay(canvas: HTMLCanvasElement, input: OverlayInput): void {
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (cssW === 0 || cssH === 0) return;
  const wantW = Math.round(cssW * input.dpr);
  const wantH = Math.round(cssH * input.dpr);
  if (canvas.width !== wantW || canvas.height !== wantH) {
    canvas.width = wantW;
    canvas.height = wantH;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(input.dpr, 0, 0, input.dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const { camera, deviceWidth, deviceHeight, dpr } = input;
  const toCss = (wx: number, wy: number): [number, number] => [
    ((wx - camera.cx) * camera.zoom + deviceWidth / 2) / dpr,
    ((wy - camera.cy) * camera.zoom + deviceHeight / 2) / dpr,
  ];
  const cssRect = (sprite: Sprite): { x: number; y: number; w: number; h: number } => {
    const [cx, cy] = toCss(sprite.x, sprite.y);
    const w = (sprite.w * camera.zoom) / dpr;
    const h = (sprite.h * camera.zoom) / dpr;
    return { x: cx - w / 2, y: cy - h / 2, w, h };
  };
  const visibleSet = new Set(input.plan.visible);

  // 1. 强调批次描边。
  if (input.highlightBatches.size > 0) {
    ctx.save();
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = 'rgba(255, 209, 102, 0.95)';
    ctx.setLineDash([5, 4]);
    for (const si of input.plan.visible) {
      if (!input.highlightBatches.has(input.plan.batchOfSprite[si]!)) continue;
      const r = cssRect(input.sprites[si]!);
      if (r.w < 9 || r.h < 9) continue;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
    }
    ctx.restore();
  }

  // 2. 选中的精灵（点选或从批次列表反查）。
  if (input.selectedSpriteId !== null) {
    const si = input.sprites.findIndex((s) => s.id === input.selectedSpriteId);
    if (si >= 0) {
      const sprite = input.sprites[si]!;
      const r = cssRect(sprite);
      const inScene = visibleSet.has(si);
      ctx.save();
      ctx.lineWidth = inScene ? 2 : 1.5;
      ctx.strokeStyle = inScene ? 'rgba(255,255,255,0.92)' : 'rgba(255,110,110,0.9)';
      ctx.shadowColor = 'rgba(0,0,0,0.75)';
      ctx.shadowBlur = 8;
      roundRect(ctx, r.x - 3, r.y - 3, r.w + 6, r.h + 6, 6);
      ctx.stroke();
      ctx.restore();
      const batch = input.plan.batchOfSprite[si]!;
      const tag = inScene
        ? `${sprite.label} · ${sprite.blend === 'alpha' ? '普通' : '叠加'} · L${sprite.layer + 1} · 批次 #${batch}`
        : `${sprite.label} · 已离开画面（不计入统计）`;
      drawChip(
        ctx,
        Math.max(4, r.x - 3),
        Math.max(4, r.y - 24),
        tag,
        'rgba(18,24,33,0.95)',
        inScene ? '#e8f2ff' : '#ffb3b3',
        inScene ? '#4b6b8a' : '#7d3b3b',
      );
    }
  }

  // 3. 悬停对象。
  if (input.hoverSpriteId !== null && input.hoverSpriteId !== input.selectedSpriteId) {
    const sprite = input.sprites.find((s) => s.id === input.hoverSpriteId);
    if (sprite) {
      const r = cssRect(sprite);
      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(210, 228, 245, 0.6)';
      roundRect(ctx, r.x - 2, r.y - 2, r.w + 4, r.h + 4, 5);
      ctx.stroke();
      ctx.restore();
    }
  }

  // 4. 探针把手 + 画面外贴边标记。
  const offscreen: Sprite[] = [];
  for (let si = 0; si < input.sprites.length; si++) {
    const sprite = input.sprites[si]!;
    if (!sprite.draggable) continue;
    if (!visibleSet.has(si)) {
      offscreen.push(sprite);
      continue;
    }
    const r = cssRect(sprite);
    const tone = PROBE_TONE[sprite.label] ?? 'rgba(255,255,255,0.9)';
    ctx.save();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = tone;
    ctx.setLineDash([7, 5]);
    roundRect(ctx, r.x, r.y, r.w, r.h, 10);
    ctx.stroke();
    ctx.setLineDash([]);
    const arm = Math.min(16, r.w * 0.16, r.h * 0.16);
    ctx.lineWidth = 3;
    for (const [sx, sy] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const) {
      const px = r.x + sx * r.w;
      const py = r.y + sy * r.h;
      const dx = sx === 0 ? 1 : -1;
      const dy = sy === 0 ? 1 : -1;
      ctx.beginPath();
      ctx.moveTo(px + dx * 4 + dx * arm, py + dy * 4);
      ctx.lineTo(px + dx * 4, py + dy * 4);
      ctx.lineTo(px + dx * 4, py + dy * 4 + dy * arm);
      ctx.stroke();
    }
    ctx.restore();
    // 选中的探针已有独立标签，避免重复。
    if (sprite.id !== input.selectedSpriteId) {
      drawChip(
        ctx,
        r.x + 8,
        r.y + 8,
        `${sprite.label} · ${sprite.blend === 'alpha' ? '普通透明' : '叠加发光'} · 第 ${sprite.layer + 1} 层`,
        'rgba(12,17,24,0.84)',
        tone,
        'rgba(90,110,130,0.6)',
      );
    }
  }

  for (const sprite of offscreen) {
    const [cx, cy] = toCss(sprite.x, sprite.y);
    const x = Math.max(30, Math.min(cssW - 30, cx));
    const y = Math.max(24, Math.min(cssH - 24, cy));
    const tone = PROBE_TONE[sprite.label] ?? '#fff';
    ctx.save();
    ctx.fillStyle = 'rgba(12,17,24,0.92)';
    ctx.strokeStyle = tone;
    ctx.lineWidth = 1.4;
    roundRect(ctx, x - 20, y - 16, 40, 32, 8);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = tone;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '600 13px ui-sans-serif, system-ui';
    ctx.fillText(sprite.label, x, y - 4);
    ctx.font = '9px ui-sans-serif, system-ui';
    ctx.fillText('离开画面', x, y + 9);
    ctx.restore();
  }

  // 5. 反例模式横幅：提醒右侧合批路径已故意乱序。
  if (input.breakOrder) {
    ctx.save();
    ctx.fillStyle = 'rgba(90, 20, 26, 0.88)';
    ctx.strokeStyle = 'rgba(255, 123, 123, 0.8)';
    ctx.lineWidth = 1;
    const w = Math.min(cssW - 32, 430);
    roundRect(ctx, 16, 16, w, 34, 8);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ffd0d0';
    ctx.font = '12px ui-sans-serif, system-ui';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('反例诊断：合批侧在同层内按混合重排，批次更少但覆盖次序已被破坏', 28, 33);
    ctx.restore();
  }

  // 6. 差异模式的读法提示。
  if (input.compareMode === 3) {
    drawChip(
      ctx,
      10,
      8,
      '差异图：黑 = 两条路径该像素完全一致',
      'rgba(12,17,24,0.86)',
      '#dbe8f5',
      'rgba(90,110,130,0.6)',
    );
  }

  // 7. 实时读数（缩放/平移时不用低头看侧栏）。
  drawHud(ctx, cssW, input.hud);

  // 8. 滑动对照分割线。
  if (input.compareMode === 2) {
    const x = Math.round(input.split * cssW) + 0.5;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, cssH);
    ctx.stroke();
    ctx.setLineDash([]);
    drawChip(
      ctx,
      Math.max(6, Math.min(cssW - 190, x + 10)),
      8,
      '左侧 参考 · 右侧 合批',
      'rgba(12,17,24,0.86)',
      '#dbe8f5',
      'rgba(90,110,130,0.6)',
    );
    ctx.restore();
  }
}
