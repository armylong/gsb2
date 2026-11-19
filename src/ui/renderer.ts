import type { Engine } from '../engine/engine';
import { FIELD, NPC_SPEED } from '../engine/world';

const COLORS = {
  field: '#0e1116',
  border: '#313a49',
  grid: '#171d26',
  rest: '#7e8ce0',
  patrol: '#3f8f6b',
  patrolActive: '#66bb6a',
  alert: 'rgba(79, 195, 247, 0.10)',
  alertLine: 'rgba(79, 195, 247, 0.45)',
  target: '#ef5350',
  npc: '#4fc3f7',
  moveLine: 'rgba(255, 183, 77, 0.75)',
  text: '#d7deea',
  muted: '#8a94a6',
};

export class SceneRenderer {
  private ctx: CanvasRenderingContext2D;

  constructor(private canvas: HTMLCanvasElement, private engine: Engine) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D not supported');
    this.ctx = ctx;
  }

  render(): void {
    const { ctx } = this;
    const w = this.engine.world;
    ctx.clearRect(0, 0, FIELD.width, FIELD.height);

    // 场地底色 + 网格
    ctx.fillStyle = COLORS.field;
    ctx.fillRect(0, 0, FIELD.width, FIELD.height);
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    for (let x = 40; x < FIELD.width; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, FIELD.height);
      ctx.stroke();
    }
    for (let y = 40; y < FIELD.height; y += 40) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(FIELD.width, y);
      ctx.stroke();
    }
    ctx.strokeStyle = COLORS.border;
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, FIELD.width - 2, FIELD.height - 2);

    // 警戒范围(跟随 NPC, 半径取当前生效阈值)
    ctx.fillStyle = COLORS.alert;
    ctx.strokeStyle = COLORS.alertLine;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.arc(w.npc.pos.x, w.npc.pos.y, w.config.alertRange, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);

    // 休息点
    this.drawRest(w.restPoint.x, w.restPoint.y);

    // 巡逻点
    w.patrolPoints.forEach((p) => {
      this.drawPatrolPoint(p.x, p.y, p.index, p.index === w.npc.patrolIndex);
    });

    // 移动目标连线
    if (w.npc.moveTarget) {
      ctx.strokeStyle = COLORS.moveLine;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(w.npc.pos.x, w.npc.pos.y);
      ctx.lineTo(w.npc.moveTarget.pos.x, w.npc.moveTarget.pos.y);
      ctx.stroke();
      ctx.setLineDash([]);
      // 目标点小叉
      const mt = w.npc.moveTarget.pos;
      ctx.strokeStyle = COLORS.moveLine;
      ctx.beginPath();
      ctx.moveTo(mt.x - 5, mt.y - 5);
      ctx.lineTo(mt.x + 5, mt.y + 5);
      ctx.moveTo(mt.x + 5, mt.y - 5);
      ctx.lineTo(mt.x - 5, mt.y + 5);
      ctx.stroke();
    }

    // 可拖动目标
    if (w.target.exists) this.drawTarget(w.target.pos.x, w.target.pos.y);

    // NPC
    this.drawNpc(w.npc.pos.x, w.npc.pos.y, w.npc.hp);
  }

  private drawRest(x: number, y: number): void {
    const { ctx } = this;
    ctx.fillStyle = COLORS.rest;
    ctx.fillRect(x - 9, y - 9, 18, 18);
    ctx.strokeStyle = '#0e1116';
    ctx.lineWidth = 2;
    ctx.strokeRect(x - 9, y - 9, 18, 18);
    ctx.fillStyle = COLORS.text;
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('休息', x, y - 14);
  }

  private drawPatrolPoint(x: number, y: number, index: number, active: boolean): void {
    const { ctx } = this;
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.fillStyle = active ? COLORS.patrolActive : COLORS.patrol;
    ctx.globalAlpha = active ? 1 : 0.65;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#0e1116';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#0e1116';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(index), x, y + 0.5);
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = COLORS.muted;
    ctx.font = '10px sans-serif';
    ctx.fillText(`巡逻点#${index}`, x, y + 22);
  }

  private drawTarget(x: number, y: number): void {
    const { ctx } = this;
    // 外圈
    ctx.beginPath();
    ctx.arc(x, y, 12, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.target;
    ctx.fill();
    ctx.strokeStyle = '#ffcdd2';
    ctx.lineWidth = 2;
    ctx.stroke();
    // 中心
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.fillStyle = COLORS.text;
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('目标(可拖)', x, y - 17);
  }

  private drawNpc(x: number, y: number, hp: number): void {
    const { ctx } = this;
    // 低血量描边变色
    const low = hp < this.engine.world.config.lowHpThreshold;
    ctx.beginPath();
    ctx.arc(x, y, 11, 0, Math.PI * 2);
    ctx.fillStyle = low ? '#ffb74d' : COLORS.npc;
    ctx.fill();
    ctx.strokeStyle = low ? '#ef5350' : '#e1f5fe';
    ctx.lineWidth = 2;
    ctx.stroke();
    // 朝向小三角(朝向移动目标)
    const mt = this.engine.world.npc.moveTarget;
    if (mt) {
      const ang = Math.atan2(mt.pos.y - y, mt.pos.x - x);
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(ang) * 15, y + Math.sin(ang) * 15);
      ctx.lineTo(x + Math.cos(ang + 2.5) * 9, y + Math.sin(ang + 2.5) * 9);
      ctx.lineTo(x + Math.cos(ang - 2.5) * 9, y + Math.sin(ang - 2.5) * 9);
      ctx.closePath();
      ctx.fillStyle = COLORS.npc;
      ctx.fill();
    }
    ctx.fillStyle = COLORS.text;
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('NPC', x, y - 16);

    // 血条
    const bw = 26;
    ctx.fillStyle = '#330b0b';
    ctx.fillRect(x - bw / 2, y + 14, bw, 4);
    ctx.fillStyle = low ? '#ffb74d' : '#66bb6a';
    ctx.fillRect(x - bw / 2, y + 14, (bw * hp) / 100, 4);
  }

  /** 画布坐标 → 世界坐标(当前 1:1, 保留转换层便于后续缩放) */
  toWorld(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * FIELD.width,
      y: ((clientY - rect.top) / rect.height) * FIELD.height,
    };
  }

  isOnTarget(clientX: number, clientY: number): boolean {
    const p = this.toWorld(clientX, clientY);
    const t = this.engine.world.target.pos;
    return Math.hypot(p.x - t.x, p.y - t.y) <= 16;
  }

  get speedLabel(): string {
    return `${NPC_SPEED} 单位/秒`;
  }
}
