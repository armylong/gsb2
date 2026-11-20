import type { PoseKind } from '../engine/types';

export interface PoseParams {
  visual: PoseKind;
  /** 0..1 当前动作进度 */
  progress: number;
  /** 局部运行时间 */
  elapsedMs: number;
  /** 预览帧不会显示攻击窗口等运行时特效 */
  showRuntimeFx: boolean;
  windowOpen: boolean;
}

interface Vec {
  x: number;
  y: number;
}

const COLORS: Record<PoseKind, { accent: string; glow: string; label: string }> = {
  idle: { accent: '#7dd3fc', glow: 'rgba(125,211,252,0.16)', label: '待机' },
  run: { accent: '#86efac', glow: 'rgba(134,239,172,0.16)', label: '跑步' },
  attack: { accent: '#fca5a5', glow: 'rgba(252,165,165,0.16)', label: '攻击' },
  hurt: { accent: '#f0abfc', glow: 'rgba(240,171,252,0.18)', label: '受击' },
  victory: { accent: '#fde68a', glow: 'rgba(253,230,138,0.18)', label: '胜利' },
};

function polar(origin: Vec, angleDeg: number, length: number): Vec {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x: origin.x + Math.sin(rad) * length,
    y: origin.y + Math.cos(rad) * length,
  };
}

function limb(
  ctx: CanvasRenderingContext2D,
  a: Vec,
  b: Vec,
  c: Vec,
  color: string,
  width: number,
) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.lineTo(c.x, c.y);
  ctx.stroke();
}

/**
 * 把设计坐标映射到画布: 设计空间 x∈[-170,170], y∈[-170,60], 角色脚下为 y≈28。
 * 保持比例并居中, 头顶与地面都留出边距。
 */
export function stageTransform(width: number, height: number): { scale: number; ox: number; oy: number } {
  const scale = Math.min(width / 340, height / 250) * 0.9;
  // 设计空间中心 y = -55, 映射到画布中心
  return { scale, ox: width / 2, oy: height / 2 + 55 * scale };
}

export function drawStage(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, '#0b1220');
  gradient.addColorStop(1, '#111b2e');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  const { scale, ox, oy } = stageTransform(width, height);
  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(scale, scale);

  // 地面网格从脚下开始, 帮助看出跑动
  ctx.strokeStyle = 'rgba(148,163,184,0.13)';
  ctx.lineWidth = 1;
  for (let i = 1; i <= 5; i += 1) {
    ctx.beginPath();
    ctx.moveTo(-170, 30 + i * 7);
    ctx.lineTo(170, 30 + i * 7);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(148,163,184,0.32)';
  ctx.beginPath();
  ctx.moveTo(-170, 30);
  ctx.lineTo(170, 30);
  ctx.stroke();
  ctx.restore();
}

export function drawCharacter(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  params: PoseParams,
) {
  const { scale, ox, oy } = stageTransform(width, height);
  const palette = COLORS[params.visual];
  const t = params.elapsedMs / 1000;
  const p = Math.min(1, Math.max(0, params.progress));

  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(scale, scale);

  // 角色周围的状态光晕
  const glow = ctx.createRadialGradient(0, -60, 20, 0, -60, 170);
  glow.addColorStop(0, palette.glow);
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(-190, -200, 380, 320);

  // 影子
  ctx.fillStyle = 'rgba(2,6,23,0.55)';
  ctx.beginPath();
  ctx.ellipse(0, 30, 42, 8, 0, 0, Math.PI * 2);
  ctx.fill();

  let hip: Vec = { x: 0, y: -44 };
  let shoulder: Vec = { x: 0, y: -116 };
  let head: Vec = { x: 0, y: -150 };
  let lean = 0;
  let bob = 0;
  let legL = 12;
  let legR = -12;
  let kneeL = 8;
  let kneeR = -8;
  let armL = 12;
  let armR = -12;
  let foreL = 8;
  let foreR = -8;
  let swordAngle = 40;
  let showSword = false;
  let shake = 0;
  let stride = 0;

  switch (params.visual) {
    case 'idle': {
      bob = Math.sin((t / 1.4) * Math.PI * 2) * 2.4;
      shoulder = { x: 0, y: -116 + bob };
      head = { x: 0, y: -150 + bob };
      armL = 13 + Math.sin((t / 1.4) * Math.PI * 2) * 3;
      armR = -13 - Math.sin((t / 1.4) * Math.PI * 2) * 3;
      kneeL = 6;
      kneeR = -6;
      stride = 2;
      break;
    }
    case 'run': {
      const phase = p * Math.PI * 2;
      lean = -0.22;
      bob = Math.abs(Math.sin(phase)) * 6 - 3;
      hip = { x: -8, y: -44 + bob };
      shoulder = { x: -15, y: -116 + bob };
      head = { x: -19, y: -150 + bob };
      legL = Math.sin(phase) * 46;
      legR = Math.sin(phase + Math.PI) * 46;
      kneeL = legL + 30;
      kneeR = legR + 30;
      armL = Math.sin(phase + Math.PI) * 52;
      armR = Math.sin(phase) * 52;
      foreL = armL + 30;
      foreR = armR + 30;
      stride = 8;
      break;
    }
    case 'attack': {
      const windup = smoothstep(0, 0.3, p);
      const strike = smoothstep(0.3, 0.52, p);
      const recover = smoothstep(0.62, 1, p);
      lean = -0.12 - strike * 0.2 + recover * 0.08;
      hip = { x: -2 - strike * 12, y: -44 };
      shoulder = { x: -8 - strike * 18, y: -116 };
      head = { x: -12 - strike * 22, y: -150 };
      legL = 30 + strike * 22;
      legR = -28 - strike * 14;
      kneeL = legL + 4;
      kneeR = legR - 18;
      armL = 20 - windup * 26 + strike * 30;
      armR = 24 + windup * 26 - strike * 96;
      foreL = armL + 26;
      foreR = armR - 26;
      swordAngle = 74 + windup * 30 - strike * 146;
      showSword = true;
      stride = 6;
      break;
    }
    case 'hurt': {
      shake = Math.sin(t * 58) * 3.4 * Math.max(0, 1 - p * 2);
      const recoil = Math.sin(Math.min(1, p * 1.4) * Math.PI) * 12;
      lean = 0.3 + recoil * 0.008;
      hip = { x: 8, y: -43 };
      shoulder = { x: 15, y: -114 };
      head = { x: 23, y: -146 };
      legL = 30;
      legR = -20;
      kneeL = 18;
      kneeR = -30;
      armL = -40;
      armR = 42;
      foreL = -66;
      foreR = 70;
      stride = 10;
      break;
    }
    case 'victory': {
      const bounce = Math.abs(Math.sin(p * Math.PI * 2)) * 5;
      bob = -bounce;
      shoulder = { x: 0, y: -116 + bob };
      head = { x: 0, y: -150 + bob };
      const wave = Math.sin(t * 4) * 8;
      armL = 156 + wave;
      armR = -156 - wave;
      foreL = 174 + wave;
      foreR = -174 - wave;
      legL = 18;
      legR = -18;
      stride = 4;
      break;
    }
  }

  ctx.save();
  ctx.translate(shake, bob * 0.4);
  ctx.rotate(lean * 0.22);

  const stroke = '#e8eefc';
  const accent = palette.accent;
  const lineWidth = 8;
  const backStroke = '#6b7a96';

  // 后侧腿
  const kneeBack = polar(hip, legR, 36);
  const footBack = polar(kneeBack, kneeR, 36);
  limb(ctx, hip, kneeBack, footBack, backStroke, lineWidth - 1.5);
  drawFoot(ctx, kneeBack, footBack, backStroke, stride);

  // 后侧手臂
  const shoulderBack = shoulder;
  const elbowBack = polar(shoulderBack, armR, 30);
  const handBack = polar(elbowBack, foreR, 28);
  limb(ctx, shoulderBack, elbowBack, handBack, backStroke, lineWidth - 1.5);

  // 躯干: 几何梯形块, 比细线更易辨认朝向
  drawTorso(ctx, hip, shoulder, stroke, accent);

  // 前侧腿
  const kneeFront = polar(hip, legL, 36);
  const footFront = polar(kneeFront, kneeL, 36);
  limb(ctx, hip, kneeFront, footFront, stroke, lineWidth);
  drawFoot(ctx, kneeFront, footFront, accent, stride);

  // 前侧手臂
  const elbowFront = polar(shoulder, armL, 30);
  const handFront = polar(elbowFront, foreL, 28);
  limb(ctx, shoulder, elbowFront, handFront, stroke, lineWidth);

  // 头: 几何圆 + 朝向标记
  drawHead(ctx, head, stroke, accent);

  // 剑
  if (showSword) {
    drawSword(ctx, handFront, swordAngle, accent);
    drawSlashArc(ctx, handFront, swordAngle, p, accent);
  } else {
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(handFront.x, handFront.y, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  // 跑步速度线
  if (params.visual === 'run') {
    drawSpeedLines(ctx, hip.y, p, accent);
  }

  // 攻击窗口只在运行时展示
  if (params.showRuntimeFx && params.windowOpen) {
    const pulse = 0.5 + 0.5 * Math.sin(t * 18);
    ctx.save();
    ctx.translate(handFront.x, handFront.y);
    ctx.strokeStyle = `rgba(248,113,113,${0.45 + pulse * 0.35})`;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([5, 6]);
    ctx.beginPath();
    ctx.arc(0, 0, 54 + pulse * 7, -0.6, 0.9);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = `rgba(248,113,113,${0.12 + pulse * 0.08})`;
    ctx.beginPath();
    ctx.arc(0, 0, 54 + pulse * 7, -0.6, 0.9);
    ctx.lineTo(0, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // 受击冲击线
  if (params.visual === 'hurt' && p < 0.5) {
    ctx.strokeStyle = `rgba(240,171,252,${0.8 * (1 - p * 2)})`;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    for (let i = 0; i < 4; i += 1) {
      const a = -0.9 + i * 0.55;
      const r1 = 26 + i * 5;
      ctx.beginPath();
      ctx.moveTo(head.x + Math.cos(a) * r1, head.y + Math.sin(a) * r1);
      ctx.lineTo(head.x + Math.cos(a) * (r1 + 16), head.y + Math.sin(a) * (r1 + 16));
      ctx.stroke();
    }
  }

  ctx.restore();
  ctx.restore();

  // 左上角标签
  ctx.fillStyle = 'rgba(15,23,42,0.78)';
  ctx.strokeStyle = 'rgba(148,163,184,0.28)';
  ctx.lineWidth = 1;
  roundRect(ctx, 14, 14, 132, 30, 8);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = palette.accent;
  ctx.font = '600 13px "SF Pro Text", "PingFang SC", system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${palette.label} ${(p * 100).toFixed(0)}%`, 26, 30);
}

function drawTorso(
  ctx: CanvasRenderingContext2D,
  hip: Vec,
  shoulder: Vec,
  stroke: string,
  accent: string,
) {
  const dx = shoulder.x - hip.x;
  const dy = shoulder.y - hip.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const hipW = 11;
  const shoulderW = 15;
  ctx.beginPath();
  ctx.moveTo(hip.x + nx * hipW, hip.y + ny * hipW);
  ctx.lineTo(shoulder.x + nx * shoulderW, shoulder.y + ny * shoulderW);
  ctx.lineTo(shoulder.x - nx * shoulderW, shoulder.y - ny * shoulderW);
  ctx.lineTo(hip.x - nx * hipW, hip.y - ny * hipW);
  ctx.closePath();
  const gradient = ctx.createLinearGradient(hip.x, hip.y, shoulder.x, shoulder.y);
  gradient.addColorStop(0, '#1d2b45');
  gradient.addColorStop(1, '#26365a');
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.stroke();
  // 胸口的几何菱形标记, 强化"几何角色"
  const cx = hip.x + dx * 0.62;
  const cy = hip.y + dy * 0.62;
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.moveTo(cx, cy - 6);
  ctx.lineTo(cx + 5.5, cy);
  ctx.lineTo(cx, cy + 6);
  ctx.lineTo(cx - 5.5, cy);
  ctx.closePath();
  ctx.fill();
}

function drawHead(
  ctx: CanvasRenderingContext2D,
  head: Vec,
  stroke: string,
  accent: string,
) {
  ctx.fillStyle = '#0f172a';
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 4.5;
  ctx.beginPath();
  ctx.arc(head.x, head.y, 18, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(head.x + 7, head.y - 3, 3.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(head.x + 4, head.y + 6);
  ctx.lineTo(head.x + 11, head.y + 6);
  ctx.stroke();
}

function drawSpeedLines(
  ctx: CanvasRenderingContext2D,
  baseY: number,
  p: number,
  accent: string,
) {
  ctx.strokeStyle = accent;
  ctx.lineCap = 'round';
  ctx.lineWidth = 2;
  for (let i = 0; i < 3; i += 1) {
    const y = baseY - 8 + i * 15;
    const offset = ((p * 3 + i * 0.33) % 1) * 40;
    ctx.globalAlpha = 0.18 + (i === 1 ? 0.12 : 0);
    ctx.beginPath();
    ctx.moveTo(-116 - offset, y);
    ctx.lineTo(-72 - offset, y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawSlashArc(
  ctx: CanvasRenderingContext2D,
  hand: Vec,
  angle: number,
  p: number,
  accent: string,
) {
  if (p < 0.32 || p > 0.72) return;
  const intensity = 1 - Math.abs((p - 0.5) / 0.22);
  if (intensity <= 0) return;
  const rad = (angle * Math.PI) / 180;
  ctx.save();
  ctx.translate(hand.x, hand.y);
  ctx.rotate(rad);
  ctx.strokeStyle = `rgba(252,165,165,${0.75 * intensity})`;
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(0, 0, 44, -1.1, 0.5);
  ctx.stroke();
  ctx.strokeStyle = `rgba(255,255,255,${0.5 * intensity})`;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, 54, -0.9, 0.3);
  ctx.stroke();
  ctx.restore();
  void accent;
}

function drawFoot(
  ctx: CanvasRenderingContext2D,
  _knee: Vec,
  foot: Vec,
  color: string,
  stride: number,
) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(foot.x - 3, foot.y);
  ctx.lineTo(foot.x + 13 + stride * 0.2, foot.y + 3);
  ctx.stroke();
}

function drawSword(ctx: CanvasRenderingContext2D, hand: Vec, angle: number, accent: string) {
  const tip = polar(hand, angle, 62);
  const guardA = polar(hand, angle + 90, 11);
  const guardB = polar(hand, angle - 90, 11);
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(guardA.x, guardA.y);
  ctx.lineTo(guardB.x, guardB.y);
  ctx.stroke();
  const gradient = ctx.createLinearGradient(hand.x, hand.y, tip.x, tip.y);
  gradient.addColorStop(0, '#e2e8f0');
  gradient.addColorStop(1, accent);
  ctx.strokeStyle = gradient;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(hand.x, hand.y);
  ctx.lineTo(tip.x, tip.y);
  ctx.stroke();
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(hand.x, hand.y, 4, 0, Math.PI * 2);
  ctx.fill();
}

export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function poseAccent(visual: PoseKind): string {
  return COLORS[visual].accent;
}
