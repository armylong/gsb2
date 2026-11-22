// 确定性逐拍模拟核心。
// 连续播放(增量 step)和直接定位(从 0 重放到第 t 拍)都走同一个 stepRound,
// 输入只依赖「各轮录制的输入序列」, 因此两种途径必然得到相同状态。

export interface Vec { x: number; y: number }

export interface Input { dx: number; dy: number; act: boolean }
export const NO_INPUT: Input = { dx: 0, dy: 0, act: false };

export const TICK_RATE = 20;          // 每秒 20 拍
export const TICK_MS = 1000 / TICK_RATE;
export const SPEED = 3;               // 空手 px/拍
export const CARRY_SPEED = 2;         // 抱灯 px/拍
export const REACH = 34;              // 捡灯半径
export const PED_RADIUS = 32;         // 上座半径
export const ACTOR_R = 12;

export interface LevelDef {
  id: string;
  name: string;
  hint: string;
  width: number;
  height: number;
  spawn: Vec;
  lamps: Vec[];
  pedestals: Vec[];
  door: { x: number; y: number; w: number; h: number };
  roundTicks: number;
}

export interface LampState { id: number; x: number; y: number; holder: number; pedestal: number }
export interface ActorState { id: number; x: number; y: number; carrying: number }

export interface ConflictEntry {
  tick: number;
  lampId: number;
  contenders: number[];  // 同一拍伸手的人, 按优先级排序
  winner: number;
}

export interface EventEntry { tick: number; text: string }

export interface RoundState {
  tick: number;
  actors: ActorState[];   // actors[0]=真人, actors[1..]=第1..N轮的影子
  lamps: LampState[];
  doorOpen: boolean;
  won: boolean;
  wonTick: number;
}

export const LEVELS: LevelDef[] = [
  {
    id: 'two-rounds',
    name: '关卡1 · 双灯之门(需两轮)',
    hint: '一轮的时间只够送一盏灯。第一轮把灯A送上左底座; 第二轮影子会原样重摆放灯A, 你去送灯B, 两底座同时亮门就开。',
    width: 960, height: 600,
    spawn: { x: 480, y: 520 },
    lamps: [{ x: 300, y: 420 }, { x: 660, y: 420 }],
    pedestals: [{ x: 180, y: 300 }, { x: 780, y: 300 }],
    door: { x: 430, y: 18, w: 100, h: 24 },
    roundTicks: 360, // 18s: 单程送灯约 154 拍, 一轮送两盏约 404 拍 -> 一个人一轮来不及
  },
  {
    id: 'steal',
    name: '关卡2 · 抢灯版',
    hint: '第一轮把灯A送上左底座。第二轮影子会在同一拍去抓灯A——你可以抢先把它拿走(真人优先), 看冲突日志和影子抓空; 也可以老实拿灯B去右底座直接开门。',
    width: 960, height: 600,
    spawn: { x: 480, y: 520 },
    lamps: [{ x: 420, y: 400 }, { x: 540, y: 400 }],
    pedestals: [{ x: 140, y: 240 }, { x: 820, y: 240 }],
    door: { x: 430, y: 18, w: 100, h: 24 },
    roundTicks: 360,
  },
];

export function actorName(id: number): string {
  return id === 0 ? '真人' : `影子${id}`;
}

export function lampName(id: number): string {
  return `灯${String.fromCharCode(65 + id)}`;
}

export function createRoundState(level: LevelDef, numActors: number): RoundState {
  return {
    tick: 0,
    actors: Array.from({ length: numActors }, (_, i) => ({
      id: i, x: level.spawn.x, y: level.spawn.y, carrying: -1,
    })),
    lamps: level.lamps.map((p, i) => ({ id: i, x: p.x, y: p.y, holder: -1, pedestal: -1 })),
    doorOpen: false,
    won: false,
    wonTick: -1,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// 推进一拍。inputs[a] 是第 a 个角色这一拍的输入(影子用录制值, 越界视为无操作)。
// 解析顺序固定: 移动 -> 收集交互意图 -> 抢灯冲突(真人>更早轮次的影子) -> 放灯 -> 门判定。
export function stepRound(
  level: LevelDef,
  st: RoundState,
  inputs: Input[],
  events: EventEntry[],
  conflicts: ConflictEntry[],
): void {
  const t = st.tick;

  // 1. 移动(抱着灯变慢), 被拿着的灯跟随
  for (const a of st.actors) {
    const inp = inputs[a.id] ?? NO_INPUT;
    if (inp.dx !== 0 || inp.dy !== 0) {
      const len = Math.hypot(inp.dx, inp.dy);
      const sp = a.carrying >= 0 ? CARRY_SPEED : SPEED;
      a.x = clamp(a.x + (inp.dx / len) * sp, ACTOR_R, level.width - ACTOR_R);
      a.y = clamp(a.y + (inp.dy / len) * sp, ACTOR_R, level.height - ACTOR_R);
    }
    if (a.carrying >= 0) {
      const l = st.lamps[a.carrying];
      l.x = a.x; l.y = a.y;
    }
  }

  // 2. 收集交互意图: 拿着灯->放下/上座; 空手->捡最近的可用灯
  const pickups: { actor: number; lamp: number }[] = [];
  const places: number[] = [];
  for (const a of st.actors) {
    const inp = inputs[a.id] ?? NO_INPUT;
    if (!inp.act) continue;
    if (a.carrying >= 0) {
      places.push(a.id);
    } else {
      let best = -1;
      let bestD = REACH;
      for (const l of st.lamps) {
        if (l.holder >= 0) continue; // 已被人拿走的灯不可选 -> 影子的旧动作在此自然失败
        const d = Math.hypot(l.x - a.x, l.y - a.y);
        if (d <= bestD) { best = l.id; bestD = d; }
      }
      if (best >= 0) {
        pickups.push({ actor: a.id, lamp: best });
      } else {
        events.push({ tick: t, text: `${actorName(a.id)} 伸手但附近没有可用的灯` });
      }
    }
  }

  // 3. 抢灯: 同一盏灯多人伸手时, id 小者优先(真人=0 最优先, 影子按轮次先后)
  const byLamp = new Map<number, number[]>();
  for (const p of pickups) {
    const arr = byLamp.get(p.lamp);
    if (arr) arr.push(p.actor);
    else byLamp.set(p.lamp, [p.actor]);
  }
  for (const [lampId, contenders] of byLamp) {
    contenders.sort((x, y) => x - y);
    const winner = contenders[0];
    const lamp = st.lamps[lampId];
    lamp.holder = winner;
    lamp.pedestal = -1;
    st.actors[winner].carrying = lampId;
    if (contenders.length > 1) {
      conflicts.push({ tick: t, lampId, contenders: [...contenders], winner });
      events.push({
        tick: t,
        text: `冲突: ${contenders.map(actorName).join('、')} 同拍抓 ${lampName(lampId)} → ${actorName(winner)} 拿到`,
      });
    } else {
      events.push({ tick: t, text: `${actorName(winner)} 捡起 ${lampName(lampId)}` });
    }
    for (const loser of contenders.slice(1)) {
      events.push({ tick: t, text: `${actorName(loser)} 抓 ${lampName(lampId)} 失败(被别人拿走)` });
    }
  }

  // 4. 放灯(按 id 顺序): 在空底座旁则上座, 否则放地上
  places.sort((a, b) => a - b);
  for (const actorId of places) {
    const a = st.actors[actorId];
    const lampId = a.carrying;
    if (lampId < 0) continue;
    const lamp = st.lamps[lampId];
    let pid = -1;
    for (let i = 0; i < level.pedestals.length; i++) {
      if (st.lamps.some(l => l.pedestal === i)) continue;
      const p = level.pedestals[i];
      if (Math.hypot(p.x - a.x, p.y - a.y) <= PED_RADIUS) { pid = i; break; }
    }
    a.carrying = -1;
    lamp.holder = -1;
    if (pid >= 0) {
      lamp.pedestal = pid;
      lamp.x = level.pedestals[pid].x;
      lamp.y = level.pedestals[pid].y;
      events.push({ tick: t, text: `${actorName(actorId)} 把 ${lampName(lampId)} 放上 底座${pid + 1}` });
    } else {
      lamp.pedestal = -1;
      lamp.x = a.x; lamp.y = a.y;
      events.push({ tick: t, text: `${actorName(actorId)} 放下了 ${lampName(lampId)}` });
    }
  }

  // 5. 门: 所有底座都有灯才开
  st.doorOpen = level.pedestals.every((_, i) => st.lamps.some(l => l.pedestal === i));
  if (st.doorOpen && !st.won) {
    st.won = true;
    st.wonTick = t;
    events.push({ tick: t, text: '🚪 两个底座同时点亮, 门开了!' });
  }

  st.tick = t + 1;
}

// 从第 0 拍重放到 upToTick, 用于拖动时间轴/逐拍检查。
// recordings[i] 是第 i+1 轮的完整输入(影子 i+1), current 是当前轮真人已录输入。
export function simulate(
  level: LevelDef,
  recordings: Input[][],
  current: Input[],
  upToTick: number,
): { state: RoundState; conflicts: ConflictEntry[]; events: EventEntry[] } {
  const st = createRoundState(level, 1 + recordings.length);
  const conflicts: ConflictEntry[] = [];
  const events: EventEntry[] = [];
  for (let t = 0; t < upToTick; t++) {
    const inputs: Input[] = [current[t] ?? NO_INPUT];
    for (const r of recordings) inputs.push(r[t] ?? NO_INPUT);
    stepRound(level, st, inputs, events, conflicts);
  }
  return { state: st, conflicts, events };
}
