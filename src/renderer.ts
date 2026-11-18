/**
 * Renderer：纯 Canvas 2D 绘制，不修改物理状态。
 * planck 世界 y 轴向上，canvas y 轴向下，这里做统一坐标变换。
 */
import { Vec2 } from 'planck';
import type { ChainEngine } from './engine';
import { GROUND_Y, OBSTACLES, RECONNECT_THRESHOLD } from './config';
import type { JointReadout } from './types';

export interface Camera {
  /** 世界坐标中画布中心对应位置 */
  centerX: number;
  centerY: number;
  /** 每米像素数 */
  scale: number;
}

const COLORS = {
  bg: '#0f1420',
  ground: '#3a4356',
  groundTop: '#6b7590',
  obstacle: '#46536e',
  obstacleEdge: '#8da2c8',
  link: '#4ea1ff',
  linkStroke: '#cfe4ff',
  linkDragged: '#ffb347',
  weight: '#ff7a59',
  weightStroke: '#ffd1c2',
  anchor: '#7ee0a8',
  joint: '#e8ecf4',
  jointBrokenA: '#ff6b6b',
  jointBrokenB: '#ffd166',
  jointSelected: '#ffe08a',
  label: '#d7deea',
  guide: '#ffe08a',
  limitArc: 'rgba(255,224,138,0.55)',
  deviation: '#ff6b6b',
  reconnect: '#7ee0a8',
  dragLine: 'rgba(255,179,71,0.7)',
};

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  camera: Camera = { centerX: 0, centerY: -0.5, scale: 42 };
  /** 当前鼠标世界坐标（拖拽辅助线用） */
  mouseWorld: Vec2 | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建 Canvas 2D 上下文');
    this.ctx = ctx;
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** 屏幕（CSS 像素）坐标 -> 世界坐标 */
  screenToWorld(sx: number, sy: number): Vec2 {
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const x = this.camera.centerX + (sx - w / 2) / this.camera.scale;
    const y = this.camera.centerY - (sy - h / 2) / this.camera.scale;
    return new Vec2(x, y);
  }

  private worldToScreen(x: number, y: number): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    const sx = rect.width / 2 + (x - this.camera.centerX) * this.camera.scale;
    const sy = rect.height / 2 - (y - this.camera.centerY) * this.camera.scale;
    return [sx, sy];
  }

  render(engine: ChainEngine, selectedJoint: number | null, paused: boolean): void {
    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, rect.width, rect.height);

    this.drawGround(rect.width, rect.height);
    this.drawObstacles();
    this.drawAnchor(engine);
    this.drawLinks(engine);
    this.drawWeight(engine);
    this.drawJoints(engine, selectedJoint);
    this.drawDragGuide(engine);
    if (selectedJoint !== null) {
      const readout = engine.getJointReadout(selectedJoint);
      if (readout) this.drawJointGuides(engine, readout);
    }
    if (paused) this.drawPauseBadge(rect.width);
  }

  private drawGround(width: number, height: number): void {
    const ctx = this.ctx;
    const [, topY] = this.worldToScreen(0, GROUND_Y);
    ctx.fillStyle = COLORS.ground;
    ctx.fillRect(0, topY, width, height - topY);
    ctx.strokeStyle = COLORS.groundTop;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, topY);
    ctx.lineTo(width, topY);
    ctx.stroke();
    // 地面斜线纹理
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    for (let x = -40; x < width + 40; x += 24) {
      ctx.beginPath();
      ctx.moveTo(x, topY);
      ctx.lineTo(x - 14, topY + 16);
      ctx.stroke();
    }
  }

  private drawObstacles(): void {
    const ctx = this.ctx;
    for (const o of OBSTACLES) {
      const [sx, sy] = this.worldToScreen(o.x, o.y);
      const r = o.radius * this.camera.scale;
      ctx.fillStyle = COLORS.obstacle;
      ctx.strokeStyle = COLORS.obstacleEdge;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  private drawAnchor(engine: ChainEngine): void {
    const ctx = this.ctx;
    const p = engine.scenario.anchor;
    const [sx, sy] = this.worldToScreen(p.x, p.y);
    ctx.fillStyle = COLORS.anchor;
    ctx.beginPath();
    ctx.arc(sx, sy, 6, 0, Math.PI * 2);
    ctx.fill();
    // 顶部支架
    ctx.strokeStyle = COLORS.anchor;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(sx - 16, sy - 14);
    ctx.lineTo(sx + 16, sy - 14);
    ctx.moveTo(sx - 10, sy - 14);
    ctx.lineTo(sx, sy);
    ctx.moveTo(sx + 10, sy - 14);
    ctx.lineTo(sx, sy);
    ctx.stroke();
  }

  private drawLinks(engine: ChainEngine): void {
    const ctx = this.ctx;
    const dragged = engine.getDraggedBody();
    for (const link of engine.links) {
      const body = link.body;
      const pos = body.getPosition();
      const angle = body.getAngle();
      const [cx, cy] = this.worldToScreen(pos.x, pos.y);
      const hwPx = link.halfWidth * this.camera.scale;
      const hhPx = link.halfHeight * this.camera.scale;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(-angle); // 屏幕 y 翻转，角度取反
      ctx.fillStyle = body === dragged ? COLORS.linkDragged : COLORS.link;
      ctx.strokeStyle = COLORS.linkStroke;
      ctx.lineWidth = 1.5;
      this.roundRect(-hwPx, -hhPx, hwPx * 2, hhPx * 2, 4);
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      // 链节编号 B0..Bn
      ctx.fillStyle = COLORS.label;
      ctx.font = '11px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`B${link.index}`, cx, cy);
    }
  }

  private drawWeight(engine: ChainEngine): void {
    const body = engine.weightBody;
    if (!body) return;
    const ctx = this.ctx;
    const pos = body.getPosition();
    const [sx, sy] = this.worldToScreen(pos.x, pos.y);
    const r = engine.scenario.weightRadius * this.camera.scale;
    const dragged = engine.getDraggedBody() === body;
    ctx.fillStyle = dragged ? COLORS.linkDragged : COLORS.weight;
    ctx.strokeStyle = COLORS.weightStroke;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#2a1208';
    ctx.font = 'bold 11px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('W', sx, sy);
  }

  private drawJoints(engine: ChainEngine, selected: number | null): void {
    const ctx = this.ctx;
    for (const rec of engine.joints) {
      const anchor = rec.bodyA.getWorldPoint(rec.localAnchorA);
      const [sx, sy] = this.worldToScreen(anchor.x, anchor.y);
      const isSelected = rec.index === selected;

      if (rec.broken) {
        // 拆开：分别画出两端的连接点，颜色区分并连线表示偏差
        const b = rec.bodyB.getWorldPoint(rec.localAnchorB);
        const [bx, by] = this.worldToScreen(b.x, b.y);
        ctx.strokeStyle = COLORS.deviation;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(bx, by);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = COLORS.jointBrokenA;
        ctx.beginPath();
        ctx.arc(sx, sy, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = COLORS.jointBrokenB;
        ctx.beginPath();
        ctx.arc(bx, by, 5, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = isSelected ? COLORS.jointSelected : COLORS.joint;
        ctx.beginPath();
        ctx.arc(sx, sy, isSelected ? 6 : 4, 0, Math.PI * 2);
        ctx.fill();
        if (isSelected) {
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }

      // 关节编号 J0..Jm（断开时标在 A 端旁）；J0 位于固定支架处，标签右移避免重叠
      ctx.fillStyle = rec.broken ? COLORS.jointBrokenA : COLORS.label;
      ctx.font = '10px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`J${rec.index}${rec.isWeightJoint ? '(W)' : ''}`, sx + (rec.index === 0 ? 14 : 7), sy - (rec.index === 0 ? 10 : 4));
    }
  }

  private drawDragGuide(engine: ChainEngine): void {
    if (!engine.isDragging() || !this.mouseWorld) return;
    const ctx = this.ctx;
    const body = engine.getDraggedBody();
    if (!body) return;
    const pos = body.getPosition();
    const [ax, ay] = this.worldToScreen(pos.x, pos.y);
    const [mx, my] = this.worldToScreen(this.mouseWorld.x, this.mouseWorld.y);
    ctx.strokeStyle = COLORS.dragLine;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(mx, my);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /** 选中关节辅助线：角度限制弧线、当前角方向、连接点偏差/重连阈值 */
  private drawJointGuides(engine: ChainEngine, r: JointReadout): void {
    const ctx = this.ctx;
    const [sx, sy] = this.worldToScreen(r.anchorA.x, r.anchorA.y);
    const arcR = 26;

    // 以 bodyA 朝向为 0 基准画限制弧（静态固定端朝向视为 0）
    const bodyA = engine.joints[r.index].bodyA;
    const baseAngle = bodyA.isDynamic() ? bodyA.getAngle() : 0;
    const screenBase = -baseAngle;
    const screenCurrent = screenBase - r.angle; // 世界正角 -> 屏幕取反

    if (r.limitEnabled) {
      ctx.strokeStyle = COLORS.limitArc;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(sx, sy, arcR, screenBase + r.lower, screenBase + r.upper, false);
      ctx.stroke();
    }

    // 当前角度方向线（与实际关节状态一致，断开时也按当前姿态画）
    ctx.strokeStyle = COLORS.guide;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + Math.cos(screenCurrent) * (arcR + 10), sy + Math.sin(screenCurrent) * (arcR + 10));
    ctx.stroke();

    // 限制边界细线
    if (r.limitEnabled) {
      ctx.strokeStyle = 'rgba(255,224,138,0.6)';
      ctx.lineWidth = 1;
      for (const a of [screenBase + r.lower, screenBase + r.upper]) {
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx + Math.cos(a) * (arcR + 6), sy + Math.sin(a) * (arcR + 6));
        ctx.stroke();
      }
    }

    // 连接点偏差：断开时画阈值圈，圈外不可重连
    if (r.broken) {
      const thresholdPx = RECONNECT_THRESHOLD * this.camera.scale;
      ctx.strokeStyle = r.canReconnect ? COLORS.reconnect : COLORS.deviation;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(sx, sy, thresholdPx, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  private drawPauseBadge(width: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(15,20,32,0.65)';
    ctx.fillRect(width / 2 - 46, 10, 92, 26);
    ctx.fillStyle = '#ffe08a';
    ctx.font = 'bold 13px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('⏸ 已暂停', width / 2, 23);
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}
