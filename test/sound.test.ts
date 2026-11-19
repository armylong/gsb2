import { describe, it, expect } from 'vitest';
import { mapFromStrings, FOOTSTEP_INTENSITY, IMPACT_INTENSITY, DOOR_CLOSED_EXTRA } from '../src/map';
import { propagate } from '../src/propagate';
import { Sim, NPC } from '../src/sim';

function reachAt(reach: ({ time: number; intensity: number; entry: string | null } | null)[], w: number, x: number, y: number) {
  return reach[y * w + x];
}

describe('传播:绕行与到达时间', () => {
  // 声音从 (1,1) 到 (3,3),直线被墙挡住,必须绕右侧通道走 8 格
  const map = mapFromStrings([
    '#######',
    '#.....#',
    '#.###.#',
    '###...#',
    '#.....#',
    '#######',
  ]);

  it('绕墙走通道,不按直线穿墙', () => {
    const r = propagate(map, 1, 1, IMPACT_INTENSITY, 0);
    const t = reachAt(r, 7, 3, 3)!;
    expect(t.time).toBe(8); // 绕行 8 步,而非曼哈顿距离 4
    expect(t.intensity).toBe(IMPACT_INTENSITY - 8);
    expect(t.entry).toBe('W'); // 从 (4,3) 向西进入
  });

  it('墙后的格子完全到不了', () => {
    const r = propagate(map, 1, 1, IMPACT_INTENSITY, 0);
    expect(reachAt(r, 7, 2, 2)).toBeNull(); // 墙格本身
    expect(reachAt(r, 7, 3, 2)).toBeNull();
  });

  it('发声时刻 t0 计入到达时间', () => {
    const r = propagate(map, 1, 1, IMPACT_INTENSITY, 5);
    expect(reachAt(r, 7, 3, 3)!.time).toBe(5 + 8);
  });
});

describe('传播:门的衰减', () => {
  const closed = mapFromStrings(['#########', '#..D....#', '#########']);
  const opened = mapFromStrings(['#########', '#..d....#', '#########']);

  it('关闭的门额外衰减强度但时间不额外增加', () => {
    const r = propagate(closed, 1, 1, IMPACT_INTENSITY, 0);
    const t = reachAt(r, 9, 5, 1)!;
    expect(t.time).toBe(4); // 4 步,时间与开门相同
    expect(t.intensity).toBe(IMPACT_INTENSITY - 4 - DOOR_CLOSED_EXTRA);
  });

  it('打开的门无额外衰减', () => {
    const r = propagate(opened, 1, 1, IMPACT_INTENSITY, 0);
    expect(reachAt(r, 9, 5, 1)!.intensity).toBe(IMPACT_INTENSITY - 4);
  });

  it('强度耗尽后不再传播', () => {
    const r = propagate(closed, 1, 1, FOOTSTEP_INTENSITY, 0);
    expect(reachAt(r, 9, 6, 1)!.intensity).toBe(1); // 10 - 9 = 1
    expect(reachAt(r, 9, 7, 1)).toBeNull(); // 再走一步强度归零,到不了
  });
});

describe('传播:多路线选择', () => {
  it('开阔房间多路线不叠加,等于单条最短路径的剩余强度', () => {
    const map = mapFromStrings(['#######', '#.....#', '#.....#', '#.....#', '#.....#', '#.....#', '#######']);
    const r = propagate(map, 1, 1, FOOTSTEP_INTENSITY, 0);
    // (3,3) 曼哈顿距离 4,存在多条等长路径,强度不得叠加
    expect(reachAt(r, 7, 3, 3)!.intensity).toBe(FOOTSTEP_INTENSITY - 4);
  });

  // 关门捷径(6步+4衰减=10)vs 绕行(8步=8):取剩余强度大的绕行者,而非到达快者
  const map = mapFromStrings(['#########', '#...#...#', '#...D...#', '#.......#', '#########']);
  it('取剩余强度最大的路线,而不是到达最早的路线', () => {
    const r = propagate(map, 1, 2, IMPACT_INTENSITY, 0);
    const t = reachAt(r, 9, 7, 2)!;
    expect(t.intensity).toBe(IMPACT_INTENSITY - 8);
    expect(t.time).toBe(8);
    expect(t.entry).toBe('N'); // 从 (7,3) 沿底部通道向北绕进来
  });

  // 穿门 3 步(强度-7)与绕行 7 步(强度-7)同强度:取到达更早的穿门路线
  const tie = mapFromStrings(['#######', '#..D..#', '#.##..#', '#.....#', '#######']);
  it('同强度路线以较早到达者为准', () => {
    const r = propagate(tie, 1, 1, IMPACT_INTENSITY, 0);
    const t = reachAt(r, 7, 4, 1)!;
    expect(t.intensity).toBe(IMPACT_INTENSITY - 7);
    expect(t.time).toBe(3); // 穿门 3 步,早于绕行 7 步
    expect(t.entry).toBe('E'); // 从门 (3,1) 向东进入
  });
});

describe('NPC:听觉判定', () => {
  function openSim(threshold: number, nx = 4, ny = 1) {
    const map = mapFromStrings(['#########', '#.......#', '#########']);
    const npc = new NPC(1, '甲', nx, ny, threshold);
    return { sim: new Sim(map, [npc]), npc };
  }

  it('到达时强度不低于阈值才听到,且同一事件只响应一次', () => {
    const { sim, npc } = openSim(5);
    sim.emit('footstep', 1, 1); // 到达 (4,1): t=3, 强度 7
    for (let i = 0; i < 20; i++) sim.tick();
    const recs = npc.heard.filter((h) => h.eventId === 1);
    expect(recs.length).toBe(1);
    expect(recs[0].time).toBe(3);
    expect(recs[0].intensity).toBe(7);
  });

  it('强度低于阈值:记录未听到原因', () => {
    const { sim, npc } = openSim(8); // 到达强度 7 < 8
    sim.emit('footstep', 1, 1);
    for (let i = 0; i < 10; i++) sim.tick();
    expect(npc.heard.length).toBe(0);
    expect(npc.missed[0].reason).toBe('too-quiet');
    const st = sim.npcEventStatus(npc, sim.events[0]);
    expect(st).toMatchObject({ kind: 'too-quiet', intensity: 7, time: 3 });
  });

  it('被墙围死:不可达', () => {
    const map = mapFromStrings(['#######', '#.###.#', '#.#.#.#', '#.###.#', '#######']);
    const npc = new NPC(1, '甲', 3, 2, 1);
    const sim = new Sim(map, [npc]);
    sim.emit('impact', 1, 1);
    sim.tick();
    expect(npc.missed[0].reason).toBe('unreachable');
    expect(sim.npcEventStatus(npc, sim.events[0]).kind).toBe('unreachable');
  });

  it('到达前状态为 pending', () => {
    const { sim, npc } = openSim(5);
    sim.emit('footstep', 1, 1); // t=3 到达
    sim.tick(); // t=1
    expect(sim.npcEventStatus(npc, sim.events[0])).toMatchObject({ kind: 'pending', time: 3 });
  });

  it('估计方向取声音进入 NPC 格的来向,而非真实坐标方位', () => {
    // L 形通道:声源在 (1,3),NPC 在 (3,1),声音从下方进入 NPC 格
    const map = mapFromStrings(['#####', '#...#', '###.#', '#...#', '#####']);
    const npc = new NPC(1, '甲', 3, 1, 1);
    const sim = new Sim(map, [npc]);
    sim.emit('footstep', 1, 3);
    for (let i = 0; i < 10; i++) sim.tick();
    const rec = npc.heard[0];
    expect(rec.entry).toBe('N'); // 向北进入 → 估计声源在南,而非真实的西南
  });
});

describe('NPC:多事件调查选择', () => {
  const map = mapFromStrings(['#########', '#.......#', '#########']);

  it('调查最新听到的事件', () => {
    const npc = new NPC(1, '甲', 4, 1, 1);
    const sim = new Sim(map, [npc]);
    sim.emit('impact', 1, 1); // #1 t=3 到达
    for (let i = 0; i < 3; i++) sim.tick();
    expect(npc.investigationTarget()!.eventId).toBe(1);
    sim.emit('footstep', 7, 1); // #2 t=6 到达,更弱但更新
    for (let i = 0; i < 3; i++) sim.tick();
    expect(npc.investigationTarget()!.eventId).toBe(2);
  });

  it('同时到达时优先较强声音', () => {
    const npc = new NPC(1, '甲', 4, 1, 1);
    const sim = new Sim(map, [npc]);
    sim.emit('footstep', 2, 1); // #1 t=2 到达,强度 8
    sim.emit('impact', 6, 1); //   #2 t=2 到达,强度 18
    for (let i = 0; i < 5; i++) sim.tick();
    expect(npc.heard.length).toBe(2);
    expect(npc.investigationTarget()!.eventId).toBe(2);
  });

  it('时刻与强度都相同时按小编号决定', () => {
    const npc = new NPC(1, '甲', 4, 1, 1);
    const sim = new Sim(map, [npc]);
    sim.emit('footstep', 2, 1); // #1
    sim.emit('footstep', 6, 1); // #2 与 #1 同时同强度到达
    for (let i = 0; i < 5; i++) sim.tick();
    expect(npc.investigationTarget()!.eventId).toBe(1);
  });
});

describe('地图快照与重置', () => {
  it('关门只影响之后发出的声音,旧事件按发声时的快照传播', () => {
    const map = mapFromStrings(['#########', '#..d....#', '#########']); // 门初始开着
    const npc = new NPC(1, '甲', 5, 1, 1);
    const sim = new Sim(map, [npc]);
    const ev1 = sim.emit('impact', 1, 1)!; // 开门时发出
    map.at(3, 1).doorOpen = false; // 之后关门
    const ev2 = sim.emit('impact', 1, 1)!; // 关门后发出
    const i1 = ev1.reach[1 * 9 + 5]!.intensity;
    const i2 = ev2.reach[1 * 9 + 5]!.intensity;
    expect(i1).toBe(IMPACT_INTENSITY - 4);
    expect(i2).toBe(IMPACT_INTENSITY - 4 - DOOR_CLOSED_EXTRA);
    // 两个事件互不串记录
    expect(ev1.id).not.toBe(ev2.id);
    for (let i = 0; i < 10; i++) sim.tick();
    expect(npc.heard.map((h) => h.eventId).sort()).toEqual([ev1.id, ev2.id]);
  });

  it('重置后旧传播事件不能再通知 NPC', () => {
    const map = mapFromStrings(['#########', '#.......#', '#########']);
    const npc = new NPC(1, '甲', 4, 1, 1);
    const sim = new Sim(map, [npc]);
    sim.emit('footstep', 1, 1);
    sim.tick();
    sim.reset();
    expect(sim.events.length).toBe(0);
    expect(sim.time).toBe(0);
    expect(npc.heard.length).toBe(0);
    for (let i = 0; i < 20; i++) sim.tick();
    expect(npc.heard.length).toBe(0); // 旧事件不会再来通知
  });
});
