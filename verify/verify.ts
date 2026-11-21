// 无头验证:确定性、预测=实际、场景期望、跨循环频率一致性。
// 运行: npm run verify
import {
  Body, Input, Segment, World, cloneBody, expandPlan, firstEvents,
  simulate, stepBody, IDLE_INPUT,
} from '../src/physics';
import { GROUND, SCENARIOS, Scenario } from '../src/scenarios';

const HZ_LIST = [30, 60, 120, 240];
const BASE_HZ = 60;
// 跨频率容差:离散步进带来的固有误差,随 dt 线性变化
const POS_TOL = 14;   // px
const TIME_TOL = 0.06; // s

let failures = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};

function makeWorld(s: Scenario, hz: number): World {
  return {
    params: { ...s.params, dt: 1 / hz },
    obstacles: [GROUND, ...s.obstacles.map(o => ({ ...o }))],
  };
}

/** 把 60Hz 基准的输入计划缩放到目标频率(保持真实时长不变)。 */
function scalePlan(plan: Segment[], hz: number): Segment[] {
  return plan.map(seg => ({ ...seg, ticks: Math.max(1, Math.round(seg.ticks * hz / BASE_HZ)) }));
}

function runActual(world: World, start: Body, inputs: Input[], maxTicks = 2400) {
  // 实际执行:逐 tick 步进(与 simulate 内部逻辑一致,但模拟"实时驱动"的调用方式)
  const b = cloneBody(start);
  const events: import('../src/physics').SimEvent[] = [];
  let tick = 0;
  while (tick < maxTicks) {
    const inp = tick < inputs.length ? inputs[tick] : IDLE_INPUT;
    stepBody(b, inp, world, tick, events);
    tick++;
    if (tick >= inputs.length && b.grounded) break;
  }
  return { final: b, events, ticks: tick };
}

for (const s of SCENARIOS) {
  console.log(`\n== 场景: ${s.name} (${s.id}) ==`);

  // 1) 确定性 + 预测与实际一致(60Hz)
  const world60 = makeWorld(s, 60);
  const inputs60 = expandPlan(s.plan);
  const predicted = simulate(world60, s.start, inputs60);
  const actual = runActual(world60, s.start, inputs60);
  const again = simulate(world60, s.start, inputs60);

  ok(predicted.final.x === again.final.x && predicted.final.y === again.final.y,
    '确定性: 同参数两次模拟结果完全一致');
  ok(predicted.final.x === actual.final.x && predicted.final.y === actual.final.y &&
     predicted.events.length === actual.events.length,
    `预测=实际: 终点差 (${(actual.final.x - predicted.final.x).toFixed(3)}, ${(actual.final.y - predicted.final.y).toFixed(3)}), 事件数 ${predicted.events.length}/${actual.events.length}`);

  // 2) 场景期望(60Hz)
  const first = firstEvents(predicted.events);
  const got = s.expect.first === 'land' ? first.land : first.ceiling;
  ok(!!got, `首次事件为 ${s.expect.first}` + (got ? ` @ (${got.x.toFixed(1)}, ${got.y.toFixed(1)}) t=${got.t.toFixed(2)}s` : ' (未发生)'));
  if (s.expect.first === 'land' && s.expect.landOn && got) {
    const r = s.expect.landOn;
    const onTop = got.x + s.start.w > r.x && got.x < r.x + r.w &&
                  Math.abs(got.y + s.start.h - r.y) < 2;
    ok(onTop, `落点在目标平台顶面 [${r.x}..${r.x + r.w}] @y=${r.y}`);
  }

  // 3) 跨循环频率一致性
  console.log('  频率扫描:');
  const landings: { hz: number; x: number; y: number; t: number }[] = [];
  for (const hz of HZ_LIST) {
    const world = makeWorld(s, hz);
    const inputs = expandPlan(scalePlan(s.plan, hz));
    const res = simulate(world, s.start, inputs);
    const f = firstEvents(res.events);
    const ev = (s.expect.first === 'land' ? f.land : f.ceiling) ?? res.events[0];
    if (!ev) { ok(false, `hz=${hz}: 无事件`); continue; }
    landings.push({ hz, x: ev.x, y: ev.y, t: ev.t });
    console.log(`    hz=${hz.toString().padStart(3)}  首个${ev.type}事件 @ (${ev.x.toFixed(2)}, ${ev.y.toFixed(2)})  t=${ev.t.toFixed(3)}s  终点 (${res.final.x.toFixed(2)}, ${res.final.y.toFixed(2)})`);
  }
  const spread = (key: 'x' | 'y' | 't') => {
    const vs = landings.map(l => l[key]);
    return Math.max(...vs) - Math.min(...vs);
  };
  ok(landings.length === HZ_LIST.length, '所有频率下事件均发生');
  ok(spread('x') <= POS_TOL && spread('y') <= POS_TOL,
    `落点跨频率散布 ≤ ${POS_TOL}px (实际 dx=${spread('x').toFixed(2)} dy=${spread('y').toFixed(2)})`);
  ok(spread('t') <= TIME_TOL, `落点时刻跨频率散布 ≤ ${TIME_TOL}s (实际 ${spread('t').toFixed(3)}s)`);
}

console.log(failures === 0 ? '\n全部通过 ✔' : `\n${failures} 项失败 ✘`);
process.exit(failures === 0 ? 0 : 1);
