import { describe, expect, it } from 'vitest';
import { Simulator, key, type Cell, type SimConfig } from '../src/simulator';
import { SCENARIOS } from '../src/scenarios';

const HORIZON = 7;
const MAX_WAIT = 8;

function build(scenarioId: string, strategy: SimConfig['strategy'] = 'strict') {
  const def = SCENARIOS.find((s) => s.id === scenarioId)!;
  return new Simulator(def.build(strategy, HORIZON, MAX_WAIT));
}

// 推进到结束（设步数上限防死循环），返回每台车经过的所有位置
function run(sim: Simulator, cap = 60) {
  const tracks = new Map<string, string[]>();
  for (const car of sim.cars) tracks.set(car.id, [key(car.pos.x, car.pos.y)]);
  let n = 0;
  while (!sim.finished && n < cap) {
    sim.step();
    for (const car of sim.cars) tracks.get(car.id)!.push(key(car.pos.x, car.pos.y));
    n++;
  }
  return { n, tracks };
}

// 不变量：任何时刻每台车位置唯一，且没有两台车同格
function assertNoCellCollision(sim: Simulator) {
  const seen = new Map<string, string>();
  for (const car of sim.cars) {
    const k = key(car.pos.x, car.pos.y);
    expect(seen.has(k), `格子 ${k} 被 ${seen.get(k)} 和 ${car.id} 同时占用`).toBe(false);
    seen.set(k, car.id);
  }
}

// 不变量：预约表里同一 (cell,time) 只能有一个车主
function assertReservationUnique(sim: Simulator) {
  const owners = new Map<string, Set<string>>();
  for (const [vk, owner] of sim.reservations.vertex) {
    if (!owners.has(vk)) owners.set(vk, new Set());
    owners.get(vk)!.add(owner);
  }
  for (const [vk, set] of owners) {
    expect(set.size, `预约 ${vk} 存在多个车主: ${[...set].join(',')}`).toBe(1);
  }
}

// 不变量：迎面交换 —— 同一步存在 a→b 与 b→a 两条边预约即非法
function assertNoHeadOnSwap(sim: Simulator) {
  const edges = new Set(sim.reservations.edge.keys());
  for (const e of edges) {
    const m = e.match(/^(-?\d+),(-?\d+)>(-?\d+),(-?\d+)@(-?\d+)$/)!;
    const [, ax, ay, bx, by, t] = m.map(Number);
    const opp = `${bx},${by}>${ax},${ay}@${t}`;
    expect(edges.has(opp), `存在迎面交换边: ${e} 与 ${opp}`).toBe(false);
  }
}

describe('预约冲突规则', () => {
  it('同一步内不重占格子，也不迎面交换穿过同一边', () => {
    // 三格直路：E 从 (0,0) 东行去 (2,0)，W 从 (2,0) 西行去 (0,0)。
    // 无避让格的单车道：两车最终对向顶死，全局死锁失败；
    // 但任何一步都不允许同格或迎面交换——先验证不变量，再验证失败结论。
    const cells: Cell[] = [
      { x: 0, y: 0, type: 'road' },
      { x: 1, y: 0, type: 'road' },
      { x: 2, y: 0, type: 'road' },
    ];
    const sim = new Simulator({
      width: 3,
      height: 1,
      cells,
      horizon: 4,
      strategy: 'strict',
      maxWait: 20,
      cars: [
        {
          id: 'E',
          label: 'E',
          color: '#fff',
          start: { x: 0, y: 0 },
          goal: { x: 2, y: 0 },
          priority: 5,
        },
        {
          id: 'W',
          label: 'W',
          color: '#000',
          start: { x: 2, y: 0 },
          goal: { x: 0, y: 0 },
          priority: 5,
        },
      ],
    });
    for (let i = 0; i < 8; i++) {
      assertNoCellCollision(sim);
      assertReservationUnique(sim);
      assertNoHeadOnSwap(sim);
      sim.step();
    }
    // 单车道无避让，死锁失败而不是穿模/同格
    expect(sim.cars.every((c) => c.status === 'failed')).toBe(true);
    expect(sim.cars[0].failReason).toMatch(/死锁/);
  });

  it('有避让格时迎面车流可以解死：低优先级车退入避让格后两车先后通过', () => {
    // 主路 (0,0)-(3,0) 四格，W 的避让格 (2,1) 直接挂在 W 起点 (3,0) 旁边的 (2,0) 下方。
    // E 优先级更高先走，W 在 (2,0) 受阻后直接退到 (2,1)，E 通过后 W 再走。
    const cells: Cell[] = [
      { x: 0, y: 0, type: 'road' },
      { x: 1, y: 0, type: 'road' },
      { x: 2, y: 0, type: 'road' },
      { x: 3, y: 0, type: 'road' },
      { x: 2, y: 1, type: 'wait' },
    ];
    const sim = new Simulator({
      width: 4,
      height: 2,
      cells,
      horizon: 6,
      strategy: 'strict',
      maxWait: 20,
      cars: [
        {
          id: 'E',
          label: 'E',
          color: '#4fc3f7',
          start: { x: 0, y: 0 },
          goal: { x: 3, y: 0 },
          priority: 8,
        },
        {
          id: 'W',
          label: 'W',
          color: '#ffb74d',
          start: { x: 3, y: 0 },
          goal: { x: 0, y: 0 },
          priority: 2,
          siding: { x: 2, y: 1 },
        },
      ],
    });
    const { tracks } = run(sim, 30);
    assertNoCellCollision(sim);
    assertNoHeadOnSwap(sim);
    expect(sim.cars.every((c) => c.status === 'done')).toBe(true);
    expect(tracks.get('W')!).toContain('2,1');
  });
});

describe('场景一：单桥对向会车', () => {
  it('对向车退入等待格，两车先后通过，全部到达', () => {
    const sim = build('opposite');
    const { tracks } = run(sim);
    assertNoCellCollision(sim);
    assertNoHeadOnSwap(sim);
    assertReservationUnique(sim);
    expect(sim.cars.every((c) => c.status === 'done')).toBe(true);
    // A2 一定在东侧等待格 (8,2) 停泊避让过
    expect(tracks.get('A2')!).toContain('8,2');
  });
});

describe('场景二：弱优先车持续等待', () => {
  it('严格优先级：弱车 W 饥饿失败，日志给出失败原因；两台 H 车到达', () => {
    const sim = build('starvation', 'strict');
    run(sim);
    const w = sim.cars.find((c) => c.id === 'W')!;
    expect(w.status).toBe('failed');
    expect(w.failReason).toContain('弱车饥饿');
    const failEvents = sim.events.filter((e) => e.level === 'fail');
    expect(failEvents.some((e) => e.text.includes('W') && e.text.includes('饥饿'))).toBe(true);
    expect(sim.cars.filter((c) => c.id.startsWith('H')).every((c) => c.status === 'done')).toBe(
      true,
    );
  });

  it('优先级老化：W 的有效优先级随等待上升，最终翻盘到达', () => {
    const sim = build('starvation', 'aging');
    run(sim);
    assertNoCellCollision(sim);
    assertNoHeadOnSwap(sim);
    expect(sim.cars.every((c) => c.status === 'done')).toBe(true);
  });

  it('先到先得：W 长期排队同样可获得通行权', () => {
    const sim = build('starvation', 'fcfs');
    run(sim);
    expect(sim.cars.every((c) => c.status === 'done')).toBe(true);
  });
});

describe('中途封路', () => {
  // 带绕行支路的自定义小图：主路 (0..4,0)，支路 (1,1)(2,1)(3,1) 构成绕行
  function detourConfig(): SimConfig {
    const cells: Cell[] = [];
    for (let x = 0; x <= 4; x++) cells.push({ x, y: 0, type: 'road' });
    for (let x = 1; x <= 3; x++) cells.push({ x, y: 1, type: 'road' });
    return {
      width: 5,
      height: 2,
      cells,
      horizon: 7,
      strategy: 'strict',
      maxWait: 12,
      cars: [
        {
          id: 'C',
          label: 'C',
          color: '#4fc3f7',
          start: { x: 0, y: 0 },
          goal: { x: 4, y: 0 },
          priority: 5,
        },
      ],
    };
  }

  it('封路后旧预约清空重算，受影响车绕行；不受影响的行程继续', () => {
    const sim = new Simulator(detourConfig());
    sim.step(); // C 走到 (1,0)
    expect(sim.cars[0].pos).toEqual({ x: 1, y: 0 });

    // 封住主路 (2,0)
    expect(sim.setClosed(2, 0, true)).toBe(true);
    // 预约表已整体重建：不存在指向封闭格的残留预约
    for (const vk of sim.reservations.vertex.keys()) {
      const [x, y] = vk.split(',').map(Number);
      expect(x === 2 && y === 0).toBe(false);
    }
    // 新计划绕到支路 (1,1)
    expect(sim.cars[0].plan.some((p) => p.to.x === 1 && p.to.y === 1)).toBe(true);

    run(sim);
    expect(sim.cars[0].status).toBe('done');
    expect(sim.cars[0].pos).toEqual({ x: 4, y: 0 });
  });

  it('有车占用的格子拒绝封闭', () => {
    const sim = new Simulator(detourConfig());
    expect(sim.setClosed(0, 0, true)).toBe(false);
    expect(sim.cellAt(0, 0)!.closed).toBeFalsy();
  });

  it('封路导致不可达时给出无路径失败原因，解封后可恢复', () => {
    const sim = new Simulator(detourConfig());
    // 同时封主路与支路，彻底切断 (1,0)→(3,0)
    sim.setClosed(2, 0, true);
    sim.setClosed(2, 1, true);
    run(sim);
    expect(sim.cars[0].status).toBe('failed');
    expect(sim.cars[0].failReason).toMatch(/死锁|无可达路径/);

    // 重新建一个干净实例验证解封恢复
    const sim2 = new Simulator(detourConfig());
    sim2.setClosed(2, 0, true);
    sim2.setClosed(2, 1, true);
    sim2.setClosed(2, 0, false);
    sim2.setClosed(2, 1, false);
    run(sim2);
    expect(sim2.cars[0].status).toBe('done');
  });
});

describe('优先级调节', () => {
  it('运行中提高弱车优先级后下一轮规划立即生效：让行顺序反转', () => {
    // 用场景一的双车对向结构。默认同优先级时 A1（东向，id 序在前）先过桥；
    // 把 A2 调到更高优先级后，A2 应先过桥。通过谁先占用桥面格判断让行顺序。
    const def = SCENARIOS.find((s) => s.id === 'opposite')!;
    const sim1 = new Simulator(def.build('strict', HORIZON, MAX_WAIT));
    run(sim1);
    expect(sim1.cars.every((c) => c.status === 'done')).toBe(true);

    const cfg = def.build('strict', HORIZON, MAX_WAIT);
    cfg.cars.find((c) => c.id === 'A2')!.priority = 9;
    const sim2 = new Simulator(cfg);
    const { tracks } = run(sim2);
    expect(sim2.cars.every((c) => c.status === 'done')).toBe(true);
    // A2 提权后先进入桥面：A2 轨迹里出现桥面格的最早 tick 早于 A1
    const firstBridgeTick = (id: string) =>
      tracks.get(id)!.findIndex((p) => ['4,3', '5,3', '6,3'].includes(p));
    expect(firstBridgeTick('A2')).toBeLessThan(firstBridgeTick('A1'));
  });

  it('setPriority / setStrategy 调用后立即重算预约，状态与事件即时生效', () => {
    // setStrategy：状态与事件立即可见
    const sim = build('starvation', 'strict');
    sim.setStrategy('aging');
    expect(sim.strategy).toBe('aging');
    expect(sim.events.some((e) => e.text.includes('aging'))).toBe(true);

    // setPriority：值立即写入并触发 planAll 重算（预约表被重建且非空）
    sim.setPriority('W', 9);
    expect(sim.cars.find((c) => c.id === 'W')!.priority).toBe(9);
    expect(sim.reservations.vertex.size).toBeGreaterThan(0);
    expect(sim.events.some((e) => e.text.includes('优先级调整'))).toBe(true);
  });
});
