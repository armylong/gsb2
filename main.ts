// ============================================================
// 会合站 · 居民日程调试页
// 三个房间(A/B/C)、两个人物通道门(门1/门2) + 一条慢速外廊。
// 玩家可改门的开放时段或临时关门, 观察约定如何被错过。
// ============================================================

// ---------- 基础类型 ----------
type RoomId = 'A' | 'B' | 'C';
type PersonId = 'jia' | 'yi' | 'bing';

interface Win { open: number; close: number }
interface Door {
  id: 'D1' | 'D2'; name: string;
  a: RoomId; b: RoomId;
  windows: Win[];        // 开放时段(玩家可改, 只影响未来)
  manualUntil: number;   // 玩家临时关门到此时刻
  manualFrom: number;    // 临时关门起始(用于时间轴显示)
}
interface Leg {
  kind: 'door' | 'outer';
  door: Door | null;
  from: RoomId; to: RoomId;
  depart: number; arrive: number;
}
interface PlanEntry {
  label: string; room: RoomId; start: number; end: number;
  meetingId: string | null;
  arrivedAt: number | null;
  completed: boolean;
  status: string;        // 计划中/在场/完成/迟到完成/未到场/冲突跳过/会面错过...
}
interface Meeting {
  id: string; label: string;
  a: PersonId; b: PersonId;
  room: RoomId; start: number; end: number;
  transfer: { from: PersonId; to: PersonId } | null;
  state: 'pending' | 'active' | 'done' | 'missed' | 'failed';
  conflictAbsent: PersonId[];
  seen: PersonId[];          // 窗口内曾到场的人(用于错过归因)
}
interface MoveState { legs: Leg[]; entry: PlanEntry }
interface Person {
  id: PersonId; name: string; color: string;
  room: RoomId;
  move: MoveState | null;
  waitDoor: string | null;   // 正在等哪扇门
  lastBlock: string;         // 最近一次受阻原因(用于错过归因)
  waitLogKey: string;
  plan: PlanEntry[];
}
interface LogEntry { t: number; text: string; persons: PersonId[]; kind: string }
interface State {
  t: number;
  doors: Door[];
  persons: Person[];
  meetings: Meeting[];
  holder: PersonId;          // 纪念品唯一持有者
  log: LogEntry[];
  finished: boolean;
  preset: string;
}

// ---------- 常量 ----------
const CROSS = 4;        // 穿门耗时(分钟)
const DAY_END = 90;     // 一天长度
const OUTER_COST: Record<string, number> = { 'A-B': 20, 'B-C': 20, 'A-C': 36 };
const PERSON_DEFS: Array<{ id: PersonId; name: string; color: string; home: RoomId }> = [
  { id: 'jia', name: '甲', color: '#ff6b6b', home: 'A' },
  { id: 'yi', name: '乙', color: '#4ecdc4', home: 'B' },
  { id: 'bing', name: '丙', color: '#ffd93d', home: 'C' },
];

// ---------- 小工具 ----------
function pairKey(a: RoomId, b: RoomId): string { return [a, b].sort().join('-'); }
function adjacent(a: RoomId, b: RoomId): boolean {
  return pairKey(a, b) === 'A-B' || pairKey(a, b) === 'B-C';
}
function margin(a: RoomId, b: RoomId): number {
  if (a === b) return 0;
  return adjacent(a, b) ? CROSS + 1 : 2 * CROSS + 1;
}
function personById(s: State, id: PersonId): Person {
  return s.persons.filter(p => p.id === id)[0];
}
function pname(id: PersonId): string {
  return PERSON_DEFS.filter(d => d.id === id)[0].name;
}
function doorById(s: State, id: 'D1' | 'D2'): Door {
  return s.doors.filter(d => d.id === id)[0];
}
function doorBetween(s: State, a: RoomId, b: RoomId): Door | null {
  for (const d of s.doors) {
    if ((d.a === a && d.b === b) || (d.a === b && d.b === a)) return d;
  }
  return null;
}
function doorOpen(d: Door, t: number): boolean {
  if (t < d.manualUntil) return false;
  return d.windows.some(w => t >= w.open && t < w.close);
}
function nextOpen(d: Door, t: number): number {
  for (let tt = Math.max(0, Math.ceil(t)); tt <= DAY_END + 60; tt++) {
    if (doorOpen(d, tt)) return tt;
  }
  return Infinity;
}

// ---------- 日志 ----------
function log(s: State, text: string, kind: string, persons: PersonId[]): void {
  s.log.push({ t: s.t, text, persons, kind });
}

// ---------- 路线规划 ----------
// 候选: 门路线(可能经中间房间) / 外廊(始终开放但慢)。选到达最早者, 并列时选腿少者。
function bestRoute(s: State, from: RoomId, to: RoomId, t: number): Leg[] {
  if (from === to) return [];
  const cands: Leg[][] = [];
  const d = doorBetween(s, from, to);
  if (d) {
    const dep = nextOpen(d, t);
    if (isFinite(dep)) {
      cands.push([{ kind: 'door', door: d, from, to, depart: dep, arrive: dep + CROSS }]);
    }
  } else {
    // A<->C 经 B 换乘两道门
    const d1 = doorById(s, from === 'A' ? 'D1' : 'D2');
    const d2 = doorById(s, from === 'A' ? 'D2' : 'D1');
    const dep1 = nextOpen(d1, t);
    if (isFinite(dep1)) {
      const arr1 = dep1 + CROSS;
      const dep2 = nextOpen(d2, arr1);
      if (isFinite(dep2)) {
        cands.push([
          { kind: 'door', door: d1, from, to: 'B', depart: dep1, arrive: arr1 },
          { kind: 'door', door: d2, from: 'B', to, depart: dep2, arrive: dep2 + CROSS },
        ]);
      }
    }
  }
  cands.push([{ kind: 'outer', door: null, from, to, depart: t, arrive: t + OUTER_COST[pairKey(from, to)] }]);
  cands.sort((x, y) => {
    const ax = x[x.length - 1].arrive, ay = y[y.length - 1].arrive;
    return ax - ay || x.length - y.length;
  });
  return cands[0];
}

// ---------- 计划 ----------
function mkEntry(label: string, room: RoomId, start: number, end: number, meetingId: string | null): PlanEntry {
  return { label, room, start, end, meetingId, arrivedAt: null, completed: false, status: '计划中' };
}

function completeEntry(s: State, p: Person, e: PlanEntry): void {
  if (e.completed) return;
  e.completed = true;
  if (e.arrivedAt === null) e.status = '未到场';
  else e.status = e.arrivedAt <= e.start ? '完成' : '迟到完成';
}

// 当前该执行的条目: 会面进行中则钉在原地; 否则优先"需要动身"的, 其次当前房间可做的
function currentEntry(s: State, p: Person, t: number): PlanEntry | null {
  for (const e of p.plan) {
    if (!e.completed && t >= e.end) completeEntry(s, p, e);
  }
  const todo = p.plan.filter(e => !e.completed);
  if (todo.length === 0) return null;
  // 正在会面的窗口内 → 不提前离场
  for (const e of todo) {
    if (e.meetingId && e.room === p.room && t >= e.start && t < e.end) return e;
  }
  // 需要动身的最早条目(已到访过的条目不再触发移动)
  for (const e of todo) {
    if (e.room !== p.room && e.arrivedAt === null && t >= e.start - margin(p.room, e.room)) return e;
  }
  for (const e of todo) {
    if (e.room === p.room) return e;
  }
  return todo[0]; // 在别处但还没到动身时间 → 原地等待
}

// 提交去执行条目 e: 与之时间重叠且地点冲突的更晚条目按规则放弃
function commitEntry(s: State, p: Person, e: PlanEntry): void {
  for (const o of p.plan) {
    if (o === e || o.completed) continue;
    if (o.start >= e.start && o.start < e.end && o.room !== e.room) {
      o.completed = true;
      o.status = '冲突跳过';
      if (o.meetingId) {
        const m = s.meetings.filter(mm => mm.id === o.meetingId)[0];
        if (m && m.conflictAbsent.indexOf(p.id) < 0) m.conflictAbsent.push(p.id);
        log(s, `${p.name} 放弃「${o.label}」：与「${e.label}」时间冲突（规则：只参加开始较早的会面，纪念品持有者唯一）`, 'conflict', [p.id]);
      }
    }
  }
}

// ---------- 人物每刻行为 ----------
function personTick(s: State, p: Person): void {
  const t = s.t;
  if (p.move) return; // 移动中
  const e = currentEntry(s, p, t);
  if (!e) { p.waitDoor = null; return; }
  if (p.room === e.room) {
    if (e.arrivedAt === null) e.arrivedAt = t;
    p.waitDoor = null;
    return;
  }
  if (t < e.start - margin(p.room, e.room)) { p.waitDoor = null; return; } // 还没到动身时间
  commitEntry(s, p, e);
  const route = bestRoute(s, p.room, e.room, t);
  const first = route[0];
  const last = route[route.length - 1];
  if (first.kind === 'door' && first.depart > t) {
    // 门没开 → 在门前等待(等待期间每刻重新评估, 玩家改时段会立即生效)
    p.waitDoor = first.door!.id;
    p.lastBlock = `${first.door!.name}关闭至T=${first.depart}`;
    const key = `${first.door!.id}:${first.depart}`;
    if (p.waitLogKey !== key) {
      p.waitLogKey = key;
      log(s, `${p.name} 在${first.door!.name}前等待（${p.lastBlock}，预计T=${last.arrive}到${e.room}）`, 'info', [p.id]);
    }
    return;
  }
  // 出发
  p.waitDoor = null;
  if (first.kind === 'outer') {
    const d = doorBetween(s, p.room, e.room);
    const why = d ? `${d.name}关闭至T=${nextOpen(d, t)}` : '门路线更慢';
    p.lastBlock = `${why}，改道外廊`;
    log(s, `${p.name} ${why}，改道外廊前往${e.room}（预计T=${last.arrive}到）`, 'info', [p.id]);
  }
  p.move = { legs: route, entry: e };
}

function moveTick(s: State, p: Person): void {
  if (!p.move) return;
  const legs = p.move.legs;
  const last = legs[legs.length - 1];
  if (s.t >= last.arrive) {
    const e = p.move.entry;
    p.room = last.to;
    p.move = null;
    e.arrivedAt = s.t;
    if (s.t > e.start) {
      log(s, `${p.name} 到达${e.room}（计划T=${e.start}前到，${p.lastBlock || '迟到'}）`, 'miss', [p.id]);
    }
    p.lastBlock = '';
  }
}

// ---------- 会面 ----------
function markMeetingEntries(s: State, m: Meeting, status: string): void {
  for (const pid of [m.a, m.b]) {
    const p = personById(s, pid);
    for (const e of p.plan) {
      if (e.meetingId === m.id && !e.completed) e.status = status;
    }
  }
}

function meetingTick(s: State): void {
  const t = s.t;
  for (const m of s.meetings) {
    if (m.state === 'pending' && t >= m.start) {
      m.state = 'active';
      log(s, `会面窗口开始：「${m.label}」@${m.room}（T=${m.start}~${m.end}）`, 'info', [m.a, m.b]);
    }
    if (m.state !== 'active') continue;
    const pa = personById(s, m.a), pb = personById(s, m.b);
    const inA = pa.room === m.room && !pa.move;
    const inB = pb.room === m.room && !pb.move;
    if (inA && m.seen.indexOf(m.a) < 0) m.seen.push(m.a);
    if (inB && m.seen.indexOf(m.b) < 0) m.seen.push(m.b);
    if (inA && inB) {
      if (m.transfer) {
        if (s.holder === m.transfer.from) {
          s.holder = m.transfer.to;
          m.state = 'done';
          markMeetingEntries(s, m, '完成');
          log(s, `✅ 「${m.label}」纪念品 ${pname(m.transfer.from)}→${pname(m.transfer.to)} 当面交接完成（@${m.room}）`, 'success', [m.a, m.b]);
        } else {
          m.state = 'failed';
          markMeetingEntries(s, m, '交接失败');
          const prev = s.meetings.filter(x => x.transfer && x.transfer!.to === m.transfer!.from)[0];
          const why = prev && prev.state !== 'done'
            ? `「${prev.label}」已${prev.state === 'missed' ? '错过' : '失败'}，纪念品仍在${pname(s.holder)}处`
            : `纪念品在${pname(s.holder)}处`;
          log(s, `❌ 「${m.label}」${pa.name}、${pb.name}都在${m.room}，但${pname(m.transfer.from)}未持有纪念品（${why}），交接失败`, 'fail', [m.a, m.b]);
        }
      } else {
        m.state = 'done';
        markMeetingEntries(s, m, '完成');
        log(s, `✅ 「${m.label}」完成（@${m.room}）`, 'success', [m.a, m.b]);
      }
      continue;
    }
    if (t >= m.end) {
      m.state = 'missed';
      markMeetingEntries(s, m, '会面错过');
      const reasons: string[] = [];
      for (const pid of [m.a, m.b]) {
        const pp = personById(s, pid);
        if (m.seen.indexOf(pid) >= 0) continue; // 窗口内曾到场, 不是错过原因
        if (m.conflictAbsent.indexOf(pid) >= 0) {
          reasons.push(`${pp.name}因时间冲突未到场`);
        } else if (pp.move) {
          const eta = pp.move.legs[pp.move.legs.length - 1].arrive;
          reasons.push(`${pp.name}未到（${pp.lastBlock ? pp.lastBlock + '，' : ''}途中，预计T=${eta}到）`);
        } else {
          reasons.push(`${pp.name}未到（${pp.lastBlock || '仍在' + pp.room}）`);
        }
      }
      log(s, `⚠️ 「${m.label}」错过：${reasons.length ? reasons.join('；') : '双方在窗口内未同时到场'}`, 'miss', [m.a, m.b]);
    }
  }
}

// ---------- 主循环 ----------
function tick(s: State): void {
  if (s.finished) return;
  for (const p of s.persons) moveTick(s, p);
  for (const p of s.persons) personTick(s, p);
  meetingTick(s);
  if (s.t >= DAY_END) {
    s.finished = true;
    log(s, `一天结束。纪念品最终持有者：${pname(s.holder)}`, 'info', [s.holder]);
  }
  s.t++;
}

// ---------- 预设日程 ----------
function mkMeeting(id: string, label: string, a: PersonId, b: PersonId,
  room: RoomId, start: number, end: number,
  transfer: { from: PersonId; to: PersonId } | null): Meeting {
  return { id, label, a, b, room, start, end, transfer, state: 'pending', conflictAbsent: [], seen: [] };
}

function buildPreset(kind: 'ok' | 'cascade'): State {
  const doors: Door[] = [
    { id: 'D1', name: '门1', a: 'A', b: 'B', windows: [{ open: 0, close: DAY_END }], manualUntil: 0, manualFrom: 0 },
    { id: 'D2', name: '门2', a: 'B', b: 'C', windows: [{ open: 0, close: DAY_END }], manualUntil: 0, manualFrom: 0 },
  ];
  const meetings: Meeting[] = [
    mkMeeting('M1', '交接①', 'jia', 'yi', 'B', 20, 30, { from: 'jia', to: 'yi' }),
    mkMeeting('M2', '交接②', 'yi', 'bing', 'C', 45, 55, { from: 'yi', to: 'bing' }),
  ];
  const jiaPlan = [
    mkEntry('A 休整', 'A', 0, 20, null),
    mkEntry('交接①', 'B', 20, 30, 'M1'),
    mkEntry('B 逗留', 'B', 30, 60, null),
    mkEntry('返回 A', 'A', 60, DAY_END, null),
  ];
  const yiPlan = [
    mkEntry('B 值守', 'B', 0, 20, null),
    mkEntry('交接①', 'B', 20, 30, 'M1'),
    mkEntry('B 整理', 'B', 30, 45, null),
    mkEntry('交接②', 'C', 45, 55, 'M2'),
    mkEntry('C 值守', 'C', 55, DAY_END, null),
  ];
  const bingPlan = [
    mkEntry('C 值守', 'C', 0, 45, null),
    mkEntry('交接②', 'C', 45, 55, 'M2'),
    mkEntry('C 记录', 'C', 55, DAY_END, null),
  ];
  if (kind === 'cascade') {
    // 门1 在甲动身前关闭: 交接①被错过 → 乙拿不到纪念品 → 交接②随之失效
    doors[0].windows = [{ open: 0, close: 15 }, { open: 40, close: DAY_END }];
    // 再加一场与交接②时间冲突的茶叙, 演示"冲突时只参加较早会面"的规则
    meetings.push(mkMeeting('M3', '茶叙', 'jia', 'yi', 'B', 48, 58, null));
    jiaPlan.splice(3, 0, mkEntry('茶叙', 'B', 48, 58, 'M3'));
    yiPlan.splice(4, 0, mkEntry('茶叙', 'B', 48, 58, 'M3'));
  }
  const persons: Person[] = PERSON_DEFS.map(def => ({
    id: def.id, name: def.name, color: def.color,
    room: def.home, move: null, waitDoor: null, lastBlock: '', waitLogKey: '',
    plan: def.id === 'jia' ? jiaPlan : def.id === 'yi' ? yiPlan : bingPlan,
  }));
  const s: State = {
    t: 0, doors, persons, meetings,
    holder: 'jia', log: [], finished: false, preset: kind,
  };
  log(s, `已载入日程：${kind === 'ok' ? '正常交接' : '连锁错过'}（纪念品初始由甲持有）`, 'player', []);
  return s;
}

// ============================================================
// 以下为本页 UI(浏览器环境); 无 document 时走 headless 自检
// ============================================================

const ROOM_POS: Record<RoomId, { x: number; y: number }> = {
  A: { x: 40, y: 50 }, B: { x: 260, y: 50 }, C: { x: 480, y: 50 },
};
const ROOM_W = 140, ROOM_H = 110;
const DOOR_X: Record<string, number> = { D1: 220, D2: 440 };
const OUTER_PT: Record<RoomId, { x: number; y: number }> = {
  A: { x: 110, y: 185 }, B: { x: 330, y: 185 }, C: { x: 550, y: 185 },
};
const CV_W = 660, CV_H = 450;
const TL_X0 = 50, TL_X1 = 620, TL_Y = 320; // 时间轴区域
function tlX(t: number): number { return TL_X0 + t * (TL_X1 - TL_X0) / DAY_END; }

function roomCenter(r: RoomId): { x: number; y: number } {
  return { x: ROOM_POS[r].x + ROOM_W / 2, y: ROOM_POS[r].y + ROOM_H / 2 };
}

function personPos(s: State, p: Person): { x: number; y: number } {
  if (p.move) {
    const t = s.t;
    const legs = p.move.legs;
    let leg = legs[legs.length - 1];
    for (const l of legs) { if (t < l.arrive) { leg = l; break; } }
    const f = Math.max(0, Math.min(1, (t - leg.depart) / (leg.arrive - leg.depart)));
    if (leg.kind === 'outer') {
      const p0 = OUTER_PT[leg.from], p2 = OUTER_PT[leg.to];
      const p1 = { x: (p0.x + p2.x) / 2, y: Math.max(p0.y, p2.y) + 70 };
      const x = (1 - f) * (1 - f) * p0.x + 2 * (1 - f) * f * p1.x + f * f * p2.x;
      const y = (1 - f) * (1 - f) * p0.y + 2 * (1 - f) * f * p1.y + f * f * p2.y;
      return { x, y };
    }
    const c0 = roomCenter(leg.from), c1 = roomCenter(leg.to);
    return { x: c0.x + (c1.x - c0.x) * f, y: c0.y + (c1.y - c0.y) * f };
  }
  // 房间内槽位
  const inRoom = s.persons.filter(q => !q.move && q.room === p.room);
  const idx = inRoom.indexOf(p);
  const c = roomCenter(p.room);
  return { x: c.x + (idx - (inRoom.length - 1) / 2) * 40, y: c.y };
}

let state: State;
let speed = 1;
let paused = false;
let timer: any = null;
let renderedLogCount = 0;
let locate: { t: number; persons: PersonId[] } | null = null;

function el(id: string): any { return document.getElementById(id); }

function drawCanvas(): void {
  const cv = el('cv');
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, CV_W, CV_H);
  ctx.fillStyle = '#1e2430';
  ctx.fillRect(0, 0, CV_W, CV_H);

  // ---- 外廊 ----
  ctx.strokeStyle = '#5a6478';
  ctx.setLineDash([6, 5]);
  ctx.lineWidth = 2;
  const drawOuter = (a: RoomId, b: RoomId) => {
    const p0 = OUTER_PT[a], p2 = OUTER_PT[b];
    const p1 = { x: (p0.x + p2.x) / 2, y: Math.max(p0.y, p2.y) + 70 };
    ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.quadraticCurveTo(p1.x, p1.y, p2.x, p2.y); ctx.stroke();
  };
  drawOuter('A', 'B'); drawOuter('B', 'C');
  ctx.setLineDash([]);
  ctx.fillStyle = '#8a94a8';
  ctx.font = '11px sans-serif';
  ctx.fillText('外廊（始终开放，慢）', 290, 282);

  // ---- 房间 ----
  for (const r of ['A', 'B', 'C'] as RoomId[]) {
    const pos = ROOM_POS[r];
    ctx.fillStyle = '#2a3242';
    ctx.fillRect(pos.x, pos.y, ROOM_W, ROOM_H);
    ctx.strokeStyle = '#465062';
    ctx.strokeRect(pos.x, pos.y, ROOM_W, ROOM_H);
    ctx.fillStyle = '#aeb8cc';
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText(`房间 ${r}`, pos.x + 8, pos.y + 20);
    // 该房间当前/最近的会面
    const ms = state.meetings.filter(m => m.room === r);
    ctx.font = '11px sans-serif';
    ms.forEach((m, i) => {
      const col = m.state === 'done' ? '#6fd08c' : m.state === 'missed' || m.state === 'failed' ? '#ff6b6b'
        : m.state === 'active' ? '#ffd93d' : '#8a94a8';
      ctx.fillStyle = col;
      ctx.fillText(`${m.label} T=${m.start}~${m.end}`, pos.x + 8, pos.y + 38 + i * 14);
    });
  }

  // ---- 门 ----
  for (const d of state.doors) {
    const x = DOOR_X[d.id];
    const open = doorOpen(d, state.t);
    ctx.fillStyle = open ? '#6fd08c' : '#e05555';
    ctx.fillRect(x - 6, 80, 12, 50);
    ctx.fillStyle = '#dfe6f2';
    ctx.font = '12px sans-serif';
    ctx.fillText(d.name, x - 10, 72);
    ctx.fillStyle = open ? '#6fd08c' : '#e05555';
    ctx.font = '10px sans-serif';
    ctx.fillText(open ? '开' : '关', x - 5, 145);
  }

  // ---- 人物 ----
  for (const p of state.persons) {
    const pos = personPos(state, p);
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 13, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();
    ctx.fillStyle = '#1a1a1a';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(p.name, pos.x, pos.y + 5);
    ctx.textAlign = 'left';
    if (state.holder === p.id) {
      ctx.fillStyle = '#ffd93d';
      ctx.font = '14px sans-serif';
      ctx.fillText('★', pos.x - 7, pos.y - 18);
    }
    if (p.waitDoor) {
      ctx.fillStyle = '#ffd93d';
      ctx.font = '11px sans-serif';
      ctx.fillText('⏳等' + (p.waitDoor === 'D1' ? '门1' : '门2'), pos.x - 18, pos.y + 28);
    }
  }

  // ---- 时间轴 ----
  ctx.fillStyle = '#161b25';
  ctx.fillRect(0, TL_Y - 24, CV_W, CV_H - TL_Y + 24);
  ctx.fillStyle = '#8a94a8';
  ctx.font = '11px sans-serif';
  ctx.fillText('时间轴（绿=门开放 / 会面窗口按状态着色）', TL_X0, TL_Y - 10);
  // 刻度
  for (let t = 0; t <= DAY_END; t += 15) {
    ctx.strokeStyle = '#3a4356';
    ctx.beginPath(); ctx.moveTo(tlX(t), TL_Y); ctx.lineTo(tlX(t), CV_H - 12); ctx.stroke();
    ctx.fillStyle = '#6b7589';
    ctx.fillText('' + t, tlX(t) - 4, CV_H - 2);
  }
  // 门开放时段
  state.doors.forEach((d, i) => {
    const y = TL_Y + 8 + i * 16;
    ctx.fillStyle = '#8a94a8';
    ctx.fillText(d.name, 14, y + 9);
    ctx.fillStyle = '#3c4658';
    ctx.fillRect(TL_X0, y, TL_X1 - TL_X0, 10);
    ctx.fillStyle = '#3f9e63';
    for (const w of d.windows) {
      ctx.fillRect(tlX(w.open), y, tlX(Math.min(w.close, DAY_END)) - tlX(w.open), 10);
    }
    if (d.manualUntil > d.manualFrom) {
      ctx.fillStyle = '#e05555';
      ctx.fillRect(tlX(d.manualFrom), y, tlX(Math.min(d.manualUntil, DAY_END)) - tlX(d.manualFrom), 10);
    }
  });
  // 会面窗口
  state.meetings.forEach((m, i) => {
    const y = TL_Y + 44 + i * 15;
    const col = m.state === 'done' ? '#6fd08c' : m.state === 'missed' || m.state === 'failed' ? '#e05555'
      : m.state === 'active' ? '#ffd93d' : '#5a6478';
    ctx.fillStyle = '#8a94a8';
    ctx.fillText(m.label, 8, y + 9);
    ctx.fillStyle = col;
    ctx.fillRect(tlX(m.start), y, tlX(m.end) - tlX(m.start), 10);
  });
  // 定位标记
  if (locate) {
    ctx.strokeStyle = '#ffd93d';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(tlX(locate.t), TL_Y); ctx.lineTo(tlX(locate.t), CV_H - 12); ctx.stroke();
    ctx.lineWidth = 1;
  }
  // 播放头
  ctx.strokeStyle = '#ff5555';
  ctx.beginPath(); ctx.moveTo(tlX(state.t), TL_Y); ctx.lineTo(tlX(state.t), CV_H - 12); ctx.stroke();
}

function entryLiveStatus(s: State, p: Person, e: PlanEntry): string {
  if (e.completed) return e.status;
  const cur = currentEntry(s, p, s.t);
  if (cur === e) {
    if (p.move) return '前往中';
    if (p.waitDoor) return '等待开门';
    if (p.room === e.room) return '在场';
    return '待动身';
  }
  return e.status;
}

function renderPanel(): void {
  el('clock').textContent = `T = ${state.t} 分${state.finished ? '（一天结束）' : ''}${paused ? '（已暂停）' : ''}`;
  el('holder').textContent = `纪念品：${pname(state.holder)} ★`;
  // 门状态
  state.doors.forEach((d, i) => {
    const open = doorOpen(d, state.t);
    const nxt = nextOpen(d, state.t);
    el('dst' + (i + 1)).textContent = open ? '当前：开' : `当前：关${isFinite(nxt) ? `，T=${nxt} 再开` : '，今日不再开'}`;
  });
  // 人物卡片
  for (const p of state.persons) {
    const card = el('card-' + p.id);
    const hi = locate && locate.persons.indexOf(p.id) >= 0;
    card.className = 'pcard' + (hi ? ' hi' : '');
    el('loc-' + p.id).textContent = p.move
      ? `移动中 ${p.move.legs[0].from}→${p.move.legs[p.move.legs.length - 1].to}`
      : `@${p.room}${p.waitDoor ? '（等' + (p.waitDoor === 'D1' ? '门1' : '门2') + '）' : ''}`;
    el('star-' + p.id).textContent = state.holder === p.id ? ' ★持有纪念品' : '';
    const tb = el('plan-' + p.id);
    let html = '<tr><th>时间</th><th>地点</th><th>安排</th><th>状态</th><th>实际到达</th></tr>';
    for (const e of p.plan) {
      const st = entryLiveStatus(state, p, e);
      const cls = st === '完成' ? 'ok' : (st.indexOf('错过') >= 0 || st.indexOf('未到场') >= 0 || st.indexOf('失败') >= 0 || st.indexOf('跳过') >= 0 || st.indexOf('迟到') >= 0) ? 'bad' : (st === '在场' || st === '前往中' || st === '等待开门') ? 'cur' : '';
      html += `<tr class="${cls}"><td>${e.start}~${e.end}</td><td>${e.room}</td><td>${e.label}</td><td>${st}</td><td>${e.arrivedAt === null ? '—' : 'T=' + e.arrivedAt}</td></tr>`;
    }
    tb.innerHTML = html;
  }
  // 日志(增量)
  if (state.log.length < renderedLogCount) {
    el('log').innerHTML = '';
    renderedLogCount = 0;
  }
  const logDiv = el('log');
  for (let i = renderedLogCount; i < state.log.length; i++) {
    const le = state.log[i];
    const div = document.createElement('div');
    div.className = 'le ' + le.kind;
    div.textContent = `[T=${le.t}] ${le.text}`;
    div.title = '点击定位相关人物与时间';
    div.onclick = () => {
      locate = { t: le.t, persons: le.persons };
      el('locate').textContent = le.persons.length
        ? `定位：T=${le.t} · 相关人物：${le.persons.map(pname).join('、')}（时间轴黄线 + 高亮卡片）`
        : `定位：T=${le.t}`;
      render();
    };
    logDiv.appendChild(div);
  }
  renderedLogCount = state.log.length;
  logDiv.scrollTop = logDiv.scrollHeight;
}

function render(): void {
  drawCanvas();
  renderPanel();
}

function startTimer(): void {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    if (!paused && !state.finished) {
      tick(state);
      render();
    }
  }, 250 / speed);
}

function parseWindows(text: string): Win[] | null {
  const out: Win[] = [];
  const parts = text.split(',');
  for (const part of parts) {
    const seg = part.trim();
    if (!seg) continue;
    const m = seg.match(/^(\d+)\s*-\s*(\d+)$/);
    if (!m) return null;
    const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
    if (!(a >= 0 && b > a && b <= DAY_END)) return null;
    out.push({ open: a, close: b });
  }
  return out.length ? out : null;
}

function windowsText(d: Door): string {
  return d.windows.map(w => `${w.open}-${w.close}`).join(',');
}

function resetState(kind: 'ok' | 'cascade'): void {
  state = buildPreset(kind);
  locate = null;
  el('locate').textContent = '点击日志条目可定位到相关人物与时间';
  el('w1').value = windowsText(state.doors[0]);
  el('w2').value = windowsText(state.doors[1]);
  render();
}

function initUI(): void {
  state = buildPreset('ok');
  // 控制按钮
  el('btnPause').onclick = () => {
    paused = !paused;
    el('btnPause').textContent = paused ? '▶ 继续' : '⏸ 暂停';
    render();
  };
  el('selSpeed').onchange = (ev: any) => { speed = parseInt(ev.target.value, 10); startTimer(); };
  el('selPreset').onchange = (ev: any) => resetState(ev.target.value);
  el('btnReset').onclick = () => resetState(el('selPreset').value);
  // 门编辑
  const applyWin = (idx: number) => {
    const input = el('w' + (idx + 1));
    const ws = parseWindows(input.value);
    if (!ws) { el('dst' + (idx + 1)).textContent = '格式错误（例：0-15,40-90）'; return; }
    state.doors[idx].windows = ws;
    log(state, `玩家将${state.doors[idx].name}开放时段改为 ${windowsText(state.doors[idx])}（仅影响 T=${state.t} 之后）`, 'player', []);
    render();
  };
  el('apply1').onclick = () => applyWin(0);
  el('apply2').onclick = () => applyWin(1);
  const manualClose = (idx: number) => {
    const d = state.doors[idx];
    d.manualFrom = state.t;
    d.manualUntil = Math.max(d.manualUntil, state.t + 10);
    log(state, `玩家临时关上${d.name}（T=${state.t} ~ T=${d.manualUntil}）`, 'player', []);
    render();
  };
  el('close1').onclick = () => manualClose(0);
  el('close2').onclick = () => manualClose(1);
  el('w1').value = windowsText(state.doors[0]);
  el('w2').value = windowsText(state.doors[1]);
  startTimer();
  render();
}

// ---------- headless 自检(node main.js) ----------
function headless(): void {
  for (const kind of ['ok', 'cascade'] as Array<'ok' | 'cascade'>) {
    const s = buildPreset(kind);
    let guard = 0;
    while (!s.finished && guard++ < 500) tick(s);
    // tslint:disable-next-line
    console.log(`\n===== 预设: ${kind} =====`);
    for (const l of s.log) console.log(`[T=${l.t}] (${l.kind}) ${l.text}`);
    console.log('会面结果:', s.meetings.map(m => `${m.id}:${m.state}`).join('  '), ' 持有者:', pname(s.holder));
  }
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  window.onload = initUI;
} else {
  headless();
}
