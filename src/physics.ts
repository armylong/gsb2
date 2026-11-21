// 2D 跳台物理核心:固定步长、确定性。预测与实际执行共用同一套 step,保证差值只来自外部变化。
// 坐标系与 canvas 一致:y 向下为正,重力为正。

export interface Params {
  gravity: number;      // px/s^2,向下
  jumpVel: number;      // px/s,起跳瞬时向上速度
  airAccel: number;     // px/s^2,空中水平加速度
  maxAirSpeed: number;  // px/s,水平速度上限
  groundFriction: number; // px/s^2,地面无输入减速
  airDrag: number;      // px/s^2,空中无输入减速
  dt: number;           // 固定步长(秒),由循环频率决定
}

export interface Rect { x: number; y: number; w: number; h: number }

export interface Body extends Rect { vx: number; vy: number; grounded: boolean }

export interface Input { move: -1 | 0 | 1; jump: boolean }

export const IDLE_INPUT: Input = { move: 0, jump: false };

export type EventType = 'land' | 'wall' | 'ceiling';

export interface SimEvent {
  tick: number;
  t: number;          // 秒
  type: EventType;
  x: number; y: number; // 事件发生时角色左上角位置
}

export interface World {
  params: Params;
  obstacles: Rect[];  // 含地面,均为固定矩形
}

export interface SimResult {
  points: { x: number; y: number }[]; // 每 tick 中心点
  events: SimEvent[];
  final: Body;
  ticks: number;
}

export function cloneBody(b: Body): Body {
  return { x: b.x, y: b.y, w: b.w, h: b.h, vx: b.vx, vy: b.vy, grounded: b.grounded };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 推进一个固定步长。events 为输出参数(可选)。 */
export function stepBody(b: Body, inp: Input, w: World, tick: number, events?: SimEvent[]): void {
  const p = w.params;

  // 水平:输入加速 / 无输入减速
  if (inp.move !== 0) {
    b.vx = clamp(b.vx + inp.move * p.airAccel * p.dt, -p.maxAirSpeed, p.maxAirSpeed);
  } else {
    const dec = (b.grounded ? p.groundFriction : p.airDrag) * p.dt;
    b.vx = Math.abs(b.vx) <= dec ? 0 : b.vx - Math.sign(b.vx) * dec;
  }

  // 起跳(仅落地状态)
  if (inp.jump && b.grounded) {
    b.vy = -p.jumpVel;
    b.grounded = false;
  }

  // 重力
  b.vy += p.gravity * p.dt;

  // X 轴移动与解算
  b.x += b.vx * p.dt;
  for (const o of w.obstacles) {
    if (overlaps(b, o)) {
      if (b.vx > 0) b.x = o.x - b.w;
      else if (b.vx < 0) b.x = o.x + o.w;
      if (b.vx !== 0) events?.push({ tick, t: tick * p.dt, type: 'wall', x: b.x, y: b.y });
      b.vx = 0;
    }
  }

  // Y 轴移动与解算
  b.y += b.vy * p.dt;
  const wasGrounded = b.grounded;
  b.grounded = false;
  for (const o of w.obstacles) {
    if (overlaps(b, o)) {
      if (b.vy > 0) {
        b.y = o.y - b.h;
        if (!wasGrounded) events?.push({ tick, t: tick * p.dt, type: 'land', x: b.x, y: b.y });
        b.grounded = true;
      } else if (b.vy < 0) {
        b.y = o.y + o.h;
        events?.push({ tick, t: tick * p.dt, type: 'ceiling', x: b.x, y: b.y });
      }
      b.vy = 0;
    }
  }
}

export interface Segment { ticks: number; move: -1 | 0 | 1; jump: boolean }

/** 把"段"形式的输入计划展开成逐 tick 输入。 */
export function expandPlan(segments: Segment[]): Input[] {
  const out: Input[] = [];
  for (const s of segments) {
    for (let i = 0; i < s.ticks; i++) out.push({ move: s.move, jump: s.jump && i === 0 });
  }
  return out;
}

/**
 * 从 start 状态起,按 inputs 逐 tick 模拟;输入用完后以空输入继续,
 * 直到落地或超过 maxTicks。预测与实际执行都调用它,保证一致。
 */
export function simulate(world: World, start: Body, inputs: Input[], maxTicks = 600): SimResult {
  const b = cloneBody(start);
  const points: { x: number; y: number }[] = [{ x: b.x + b.w / 2, y: b.y + b.h / 2 }];
  const events: SimEvent[] = [];
  let tick = 0;
  while (tick < maxTicks) {
    const inp = tick < inputs.length ? inputs[tick] : IDLE_INPUT;
    stepBody(b, inp, world, tick, events);
    tick++;
    points.push({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
    if (tick >= inputs.length && b.grounded) break;
  }
  return { points, events, final: b, ticks: tick };
}

/** 每类事件的首次发生,用于标注"首次触地 / 首次撞墙 / 首次撞顶"。 */
export function firstEvents(events: SimEvent[]): Partial<Record<EventType, SimEvent>> {
  const out: Partial<Record<EventType, SimEvent>> = {};
  for (const e of events) if (!out[e.type]) out[e.type] = e;
  return out;
}
