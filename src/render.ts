// Canvas 渲染：场景 + 悬挂行程 + HUD 读数
import {
  Sim, getCompression, wheelInContact, getSpeed,
  WHEEL_RADIUS, TRAVEL, CHASSIS_HW, CHASSIS_HH, ANCHOR_DX, ANCHOR_DY,
} from './sim';
import { Vec2 } from 'planck';

const VIEW_H = 8; // 固定观察窗口高度（米）

export function drawScene(ctx: CanvasRenderingContext2D, sim: Sim, w: number, h: number): void {
  const scale = h / VIEW_H;
  const camX = sim.chassis.getPosition().x + 1.2;
  const camY = sim.chassis.getPosition().y + 0.3;
  const sx = (x: number) => (x - camX) * scale + w / 2;
  const sy = (y: number) => h / 2 - (y - camY) * scale;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#101418';
  ctx.fillRect(0, 0, w, h);

  // 地形
  ctx.strokeStyle = '#7a8a99';
  ctx.lineWidth = 2;
  ctx.beginPath();
  let started = false;
  for (const p of sim.terrainPts) {
    const x = sx(p.x), y = sy(p.y);
    if (x < -50 || x > w + 50) { started = false; continue; }
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // 悬挂（弹簧线 + 轮轴）与行程标尺
  for (let i = 0; i < 2; i++) {
    const anchorLocal = new Vec2(i === 0 ? -ANCHOR_DX : ANCHOR_DX, ANCHOR_DY);
    const anchor = sim.chassis.getWorldPoint(anchorLocal);
    const wc = sim.wheels[i].getPosition();
    const contact = wheelInContact(sim, i as 0 | 1);
    const comp = getCompression(sim, i as 0 | 1);

    // 弹簧锯齿线
    drawSpring(ctx, sx(anchor.x), sy(anchor.y), sx(wc.x), sy(wc.y), 6, 8);

    // 轮轴
    ctx.fillStyle = '#ccc';
    ctx.beginPath();
    ctx.arc(sx(wc.x), sy(wc.y), 3, 0, Math.PI * 2);
    ctx.fill();

    // 行程标尺（画在轮旁，标出最大压缩/伸展线）
    const gx = sx(wc.x) + 46;
    const gTop = sy(anchor.y + TRAVEL);   // 最大压缩位置
    const gBot = sy(anchor.y - TRAVEL);   // 最大伸展位置
    const gMid = sy(anchor.y);
    ctx.strokeStyle = '#445';
    ctx.lineWidth = 1;
    ctx.strokeRect(gx, gTop, 8, gBot - gTop);
    ctx.strokeStyle = '#889';
    ctx.beginPath(); ctx.moveTo(gx - 3, gMid); ctx.lineTo(gx + 11, gMid); ctx.stroke();
    // 当前压缩位置指示块（限制在行程内显示）
    const frac = Math.max(-1, Math.min(1, comp / TRAVEL));
    const gy = gMid - frac * (gBot - gTop) / 2; // 压缩(正)向上
    ctx.fillStyle = '#ffb020';
    ctx.fillRect(gx, gy - 2, 8, 4);

    // 接触状态
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    if (contact) {
      ctx.fillStyle = '#3fd97e';
      ctx.beginPath();
      ctx.arc(sx(wc.x), sy(wc.y - WHEEL_RADIUS) - 8, 4, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = '#ff5555';
      ctx.beginPath();
      ctx.arc(sx(wc.x), sy(wc.y - WHEEL_RADIUS) - 8, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillText('无接触', sx(wc.x), sy(wc.y - WHEEL_RADIUS) - 16);
    }
  }

  // 车身
  const pos = sim.chassis.getPosition();
  const angle = sim.chassis.getAngle();
  ctx.save();
  ctx.translate(sx(pos.x), sy(pos.y));
  ctx.rotate(-angle);
  ctx.fillStyle = '#3a6ea8';
  ctx.strokeStyle = '#9cc3e8';
  ctx.lineWidth = 1.5;
  ctx.fillRect(-CHASSIS_HW * scale, -CHASSIS_HH * scale, CHASSIS_HW * 2 * scale, CHASSIS_HH * 2 * scale);
  ctx.strokeRect(-CHASSIS_HW * scale, -CHASSIS_HH * scale, CHASSIS_HW * 2 * scale, CHASSIS_HH * 2 * scale);
  ctx.restore();

  // 车轮（含辐条显示转动）
  for (let i = 0; i < 2; i++) {
    const wp = sim.wheels[i].getPosition();
    const wa = sim.wheels[i].getAngle();
    ctx.save();
    ctx.translate(sx(wp.x), sy(wp.y));
    ctx.rotate(-wa);
    ctx.fillStyle = '#222';
    ctx.strokeStyle = '#ddd';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, WHEEL_RADIUS * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = '#ffb020';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(WHEEL_RADIUS * scale, 0);
    ctx.moveTo(0, 0);
    ctx.lineTo(-WHEEL_RADIUS * scale * 0.6, WHEEL_RADIUS * scale * 0.6);
    ctx.stroke();
    ctx.restore();
  }

  drawHud(ctx, sim, w);
}

function drawSpring(
  ctx: CanvasRenderingContext2D,
  x1: number, y1: number, x2: number, y2: number,
  coils: number, amp: number,
): void {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  ctx.strokeStyle = '#e0e0e0';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  const seg = 1 / (coils * 2);
  for (let i = 1; i < coils * 2; i++) {
    const t = i * seg;
    const off = (i % 2 === 0 ? -1 : 1) * amp;
    ctx.lineTo(x1 + dx * t + nx * off, y1 + dy * t + ny * off);
  }
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function drawHud(ctx: CanvasRenderingContext2D, sim: Sim, w: number): void {
  const cL = getCompression(sim, 0);
  const cR = getCompression(sim, 1);
  const v = getSpeed(sim);
  const lines = [
    `车速 ${(v * 3.6).toFixed(1)} km/h`,
    `模拟时间 ${sim.time.toFixed(2)} s`,
    `左悬挂压缩 ${(cL * 1000).toFixed(0)} mm  ${wheelInContact(sim, 0) ? '接地' : '离地'}`,
    `右悬挂压缩 ${(cR * 1000).toFixed(0)} mm  ${wheelInContact(sim, 1) ? '接地' : '离地'}`,
    `驱动模式 ${{ coast: '滑行', forward: '驱动', reverse: '倒车', brake: '刹车' }[sim.drive]}`,
  ];
  ctx.font = '13px monospace';
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(8, 8, 240, lines.length * 18 + 10);
  ctx.fillStyle = '#e8f0f8';
  lines.forEach((s, i) => ctx.fillText(s, 16, 26 + i * 18));
}
