import type { BoxDef, GameState, LevelDef, RejectReason, Side } from '../engine/types';
import { alternatingSide, getBox, getFloor, isDoorOpen, sideName } from '../engine/engine';

export interface HitRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: 'box' | 'slot';
  boxId?: string;
  target?: { region: 'stage' | 'case' | 'car'; floor: number; side: Side };
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---- 布局常量 ----
const W = 1040;
const H = 600;
const TOP = 26;
const BAND = 132;
const SLOT_W = 34;
const SLOT_H = 44;
const GAP = 6;
const SHAFT_X = 432;
const SHAFT_W = 176;
const DOOR_W = 12;

function floorY(floor: number): number {
  return TOP + (4 - floor) * BAND;
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  readonly hitRegions: HitRegion[] = [];
  // 补间：上一快照 → 当前快照
  private prev: GameState | null = null;
  private next: GameState | null = null;
  private animStart = 0;
  private animDur = 1;
  private level: LevelDef;

  constructor(canvas: HTMLCanvasElement, level: LevelDef) {
    this.ctx = canvas.getContext('2d')!;
    this.level = level;
  }

  setLevel(level: LevelDef): void {
    this.level = level;
    this.prev = null;
    this.next = null;
  }

  /** 登记一次逻辑迁移，用于补间；回看模式传 instant 立即对齐 */
  transition(prev: GameState | null, next: GameState, instant = false): void {
    this.prev = prev;
    this.next = next;
    this.animStart = performance.now();
    this.animDur = instant ? 1 : 240;
  }

  get animating(): boolean {
    return this.next !== null && performance.now() - this.animStart < this.animDur;
  }

  private ease(t: number): number {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  }

  /** 轿厢当前用于绘制的浮点楼层 */
  private visualCarFloor(state: GameState): number {
    if (!this.prev || !this.next || state !== this.next) return state.carFloor;
    const raw = (performance.now() - this.animStart) / this.animDur;
    const t = this.ease(Math.min(1, Math.max(0, raw)));
    return this.prev.carFloor + (this.next.carFloor - this.prev.carFloor) * t;
  }

  // ---- 箱子矩形（逻辑状态下的静态位置） ----
  private boxRectVisual(state: GameState, boxId: string): Rect {
    const target = this.boxRectStaticWith(state, boxId);
    if (!this.prev || !this.next || state !== this.next) return target;
    const inPrev = this.prev.placements.some((p) => p.boxId === boxId);
    if (!inPrev) return target;
    const from = this.boxRectStaticWith(this.prev, boxId);
    const raw = (performance.now() - this.animStart) / this.animDur;
    const t = this.ease(Math.min(1, Math.max(0, raw)));
    return {
      x: from.x + (target.x - from.x) * t,
      y: from.y + (target.y - from.y) * t,
      w: from.w + (target.w - from.w) * t,
      h: from.h + (target.h - from.h) * t,
    };
  }

  private boxRectStaticWith(state: GameState, boxId: string): Rect {
    const p = state.placements.find((x) => x.boxId === boxId)!;
    const box = getBox(this.level, boxId);
    const w = box.len * SLOT_W + (box.len - 1) * GAP;
    if (p.region === 'car') {
      const y = floorY(state.carFloor) + 44;
      const x = SHAFT_X + 12 + p.index * (SLOT_W + GAP);
      return { x, y, w, h: SLOT_H };
    }
    const bandY = floorY(p.floor!);
    const rowOffset = p.region === 'stage' ? 40 : 88;
    const y = bandY + rowOffset;
    if (p.side === 'R') {
      const x = SHAFT_X + SHAFT_W + 26 + p.index * (SLOT_W + GAP);
      return { x, y, w, h: SLOT_H };
    }
    const x = SHAFT_X - 26 - (p.index + box.len) * SLOT_W - p.index * GAP;
    return { x, y, w, h: SLOT_H };
  }

  draw(state: GameState, selectedBoxId: string | null, reject: RejectReason | null): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, W, H);
    this.hitRegions.length = 0;

    this.drawShaft();
    const carFloor = this.visualCarFloor(state);
    for (const floor of this.level.floors) {
      this.drawFloorBand(state, floor.id, carFloor, reject);
    }
    this.drawCar(state, carFloor);
    this.drawBoxes(state, selectedBoxId, reject);
    if (reject) this.drawRejectBanner(reject);
  }

  private drawShaft(): void {
    const ctx = this.ctx;
    ctx.fillStyle = '#1f2733';
    ctx.fillRect(SHAFT_X - 4, TOP - 8, SHAFT_W + 8, BAND * 4 + 12);
    ctx.strokeStyle = '#3a4658';
    ctx.lineWidth = 2;
    for (let f = 1; f <= 4; f++) {
      const y = floorY(f);
      ctx.beginPath();
      ctx.moveTo(SHAFT_X - 4, y);
      ctx.lineTo(SHAFT_X + SHAFT_W + 4, y);
      ctx.stroke();
    }
  }

  private drawFloorBand(
    state: GameState,
    floor: number,
    carFloor: number,
    reject: RejectReason | null,
  ): void {
    const ctx = this.ctx;
    const spec = getFloor(this.level, floor);
    const y = floorY(floor);
    const here = Math.round(carFloor) === floor;

    // 楼层标签
    ctx.fillStyle = '#c8d3e2';
    ctx.font = 'bold 15px sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(`${floor}F`, 18, y + 8);

    for (const side of ['L', 'R'] as Side[]) {
      const pf = spec[side];
      const open = isDoorOpen(this.level, floor, side, state.turn);
      this.drawDoor(floor, side, open, y, reject);
      this.drawPlatformSlots(state, floor, side, pf.stageSlots, 'stage', y);
      this.drawPlatformSlots(state, floor, side, pf.caseSlots, 'case', y);
      if (pf.lintel === 'low') this.drawLowLintel(side, y);
    }

    // 门模式说明（放在楼层标签下方，避开轿厢与货位）
    ctx.font = '11px sans-serif';
    ctx.fillStyle = '#8a97a8';
    const mode = spec.doorMode;
    let label = '';
    if (mode.kind === 'both') label = '两侧常开';
    else if (mode.kind === 'fixed') label = `只开${sideName(mode.side)}门`;
    else {
      const cur = alternatingSide(state.turn);
      label = `交替门：本回合${sideName(cur)}开，下回合${sideName(alternatingSide(state.turn + 1))}开`;
    }
    ctx.fillText(label, 18, y + 28);
    void here;
  }

  private drawDoor(floor: number, side: Side, open: boolean, y: number, reject: RejectReason | null): void {
    const ctx = this.ctx;
    const x = side === 'L' ? SHAFT_X - DOOR_W - 2 : SHAFT_X + SHAFT_W + 2;
    const rejected = reject?.side === side;
    ctx.fillStyle = open ? '#3f9d6b' : rejected ? '#e0563f' : '#8a5252';
    ctx.fillRect(x, y + 18, DOOR_W, BAND - 36);
    // 门旁用横排文字标注开/关，避免旋转文字被窄门挤糊
    ctx.fillStyle = open ? '#8fe0b4' : '#f0a89c';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = side === 'L' ? 'right' : 'left';
    ctx.textBaseline = 'middle';
    const tx = side === 'L' ? x - 4 : x + DOOR_W + 4;
    ctx.fillText(open ? '开门' : '关门', tx, y + 30);
    ctx.textAlign = 'start';
    void floor;
  }

  private drawLowLintel(side: Side, y: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = '#c9a14a';
    ctx.lineWidth = 3;
    const x0 = side === 'L' ? SHAFT_X - 150 : SHAFT_X + SHAFT_W + 18;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(x0, y + 14);
    ctx.lineTo(x0 + 130, y + 14);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#c9a14a';
    ctx.font = '11px sans-serif';
    ctx.fillText('低过梁', x0, y + 1);
  }

  private drawPlatformSlots(
    state: GameState,
    floor: number,
    side: Side,
    count: number,
    region: 'stage' | 'case',
    bandY: number,
  ): void {
    const ctx = this.ctx;
    const rowOffset = region === 'stage' ? 40 : 88;
    for (let i = 0; i < count; i++) {
      const rect = this.slotRect(floor, side, region, i, bandY + rowOffset);
      const occupied = state.placements.some((p) =>
        p.region === region && p.floor === floor && p.side === side &&
        i >= p.index && i < p.index + getBox(this.level, p.boxId).len,
      );
      ctx.strokeStyle = region === 'case' ? '#5b8dd9' : '#5a6577';
      ctx.lineWidth = 1.5;
      ctx.setLineDash(occupied ? [] : [3, 3]);
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
      ctx.setLineDash([]);
      if (!occupied) {
        this.hitRegions.push({
          ...rect,
          kind: 'slot',
          target: { region, floor, side },
        });
      }
    }
    ctx.fillStyle = region === 'case' ? '#7fa8e0' : '#8a97a8';
    ctx.font = '11px sans-serif';
    const labelX = side === 'R' ? SHAFT_X + SHAFT_W + 26 : SHAFT_X - 150;
    ctx.fillText(region === 'case' ? '展柜' : '暂存位', labelX, bandY + rowOffset - 15);
  }

  private slotRect(floor: number, side: Side, region: 'stage' | 'case', index: number, y: number): Rect {
    void floor;
    void region;
    if (side === 'R') {
      return { x: SHAFT_X + SHAFT_W + 26 + index * (SLOT_W + GAP), y, w: SLOT_W, h: SLOT_H };
    }
    return { x: SHAFT_X - 26 - (index + 1) * SLOT_W - index * GAP, y, w: SLOT_W, h: SLOT_H };
  }

  private drawCar(state: GameState, carFloor: number): void {
    const ctx = this.ctx;
    const y = floorY(Math.round(carFloor)) + (carFloor - Math.round(carFloor)) * BAND;
    const boxY = y + 44;
    // 轿厢外壳
    ctx.fillStyle = '#2c384a';
    ctx.fillRect(SHAFT_X + 4, y + 18, SHAFT_W - 8, BAND - 34);
    ctx.strokeStyle = '#6b7890';
    ctx.lineWidth = 2;
    ctx.strokeRect(SHAFT_X + 4, y + 18, SHAFT_W - 8, BAND - 34);
    // 货位
    for (let i = 0; i < this.level.carSlots; i++) {
      const x = SHAFT_X + 12 + i * (SLOT_W + GAP);
      ctx.strokeStyle = '#46546a';
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(x, boxY, SLOT_W, SLOT_H);
      ctx.setLineDash([]);
      const occupied = state.placements.some(
        (p) => p.region === 'car' && i >= p.index && i < p.index + getBox(this.level, p.boxId).len,
      );
      if (!occupied) {
        this.hitRegions.push({
          x,
          y: boxY,
          w: SLOT_W,
          h: SLOT_H,
          kind: 'slot',
          target: { region: 'car', floor: state.carFloor, side: 'L' },
        });
      }
    }
  }

  private drawBoxes(state: GameState, selectedBoxId: string | null, reject: RejectReason | null): void {
    for (const p of state.placements) {
      const box = getBox(this.level, p.boxId);
      const rect = this.boxRectVisual(state, p.boxId);
      this.drawBox(box, rect, p.boxId === selectedBoxId, reject?.blockerId === p.boxId);
      this.hitRegions.push({ ...rect, kind: 'box', boxId: p.boxId });
    }
  }

  private drawBox(box: BoxDef, rect: Rect, selected: boolean, blocked: boolean): void {
    const ctx = this.ctx;
    ctx.fillStyle = box.color;
    this.roundRect(rect.x, rect.y, rect.w, rect.h, 6);
    ctx.fill();
    if (selected) {
      ctx.strokeStyle = '#ffd34d';
      ctx.lineWidth = 3;
    } else if (blocked) {
      ctx.strokeStyle = '#ff5a4d';
      ctx.lineWidth = 3;
    } else {
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 1.5;
    }
    this.roundRect(rect.x, rect.y, rect.w, rect.h, 6);
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(box.id, rect.x + rect.w / 2, rect.y + rect.h / 2);
    if (box.horizontalOnly) {
      ctx.font = '10px sans-serif';
      ctx.fillText('水平', rect.x + rect.w / 2, rect.y + rect.h - 8);
    }
    ctx.textAlign = 'start';
  }

  private drawRejectBanner(reject: RejectReason): void {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(192,57,43,0.92)';
    this.roundRect(260, H - 46, 520, 34, 8);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(reject.message, 520, H - 29);
    ctx.textAlign = 'start';
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

  hitTest(mx: number, my: number): HitRegion | null {
    // 后绘制的在上层，逆序命中
    for (let i = this.hitRegions.length - 1; i >= 0; i--) {
      const r = this.hitRegions[i];
      if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h) return r;
    }
    return null;
  }
}
