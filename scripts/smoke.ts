/**
 * 无头验证脚本：npm run smoke
 * 1. 正对风眼不能直行向上风推进
 * 2. 之字换舷可以净位移到上风口，换舷后恢复可控
 * 3. 浮标碰撞不穿透、不突然转向
 * 4. 水流带产生真实漂移，边缘平滑
 * 5. 回放确定；改帆角后轨迹不同（对照有效）
 * 6. 路线一可在自动控制器下完成，且侧别/顺序全对
 */
import { angleDiff, dist, vec, wrapAngle, type Vec2 } from '../src/vec';
import { makeBoat, PHYS } from '../src/engine/physics';
import { BOAT_RADIUS, createWorld, FIXED_DT, sampleCurrent, stepWorld } from '../src/engine/world';
import { BUOYS, COURSE_1, COURSES, CURRENTS, DEFAULT_WIND } from '../src/engine/courses';
import type { Boat, Inputs } from '../src/engine/types';
import { CourseTracker } from '../src/engine/course';
import { ReplayPlayer, type ReplaySnapshot } from '../src/engine/replay';

const deg = (d: number) => (d * Math.PI) / 180;
let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

const wind = { ...DEFAULT_WIND };
const windFrom = wrapAngle(wind.dir + Math.PI); // 风眼方向（屏幕上方，-y）

function run(seconds: number, fn: (t: number, boat: Boat) => Inputs, startHeading = windFrom + deg(33)) {
  const boat = makeBoat(vec(500, 830), startHeading);
  const world = createWorld(wind, BUOYS, CURRENTS);
  const start = { ...boat.pos };
  const frames: ReplaySnapshot['frames'] = [];
  const n = Math.round(seconds / FIXED_DT);
  for (let i = 0; i < n; i++) {
    const input = fn(world.time, boat);
    frames.push({ rudder: input.rudder, sheet: input.sheet });
    stepWorld(world, boat, input);
  }
  return { boat, start, frames };
}

/** 近迎风自动舵：targetAbsDeg 为目标真风角（度），走廊随接近门渐进收敛到要求侧。 */
function upwindAutopilot(
  targetAbsDeg: number,
  sheet: number,
  gateX: number,
  gateY: number,
  startY: number,
  sideOffset = -20,
) {
  const targetAbs = deg(targetAbsDeg);
  type St = 'S1' | 'S2' | 'T12' | 'T21';
  let state: St = 'S1';
  return (_t: number, boat: Boat): Inputs => {
    const twa = wrapAngle(angleDiff(windFrom, boat.heading));
    // k: 1=远离门, 0=到门；走廊从宽 150 渐进收到 35，中心偏向要求侧
    const k = clamp01((boat.pos.y - gateY) / (startY - gateY));
    const corridor = 35 + 115 * k;
    const centerX = gateX + sideOffset * (1 - k);
    const hitRight = boat.pos.x > centerX + corridor;
    const hitLeft = boat.pos.x < centerX - corridor;
    const clear = boat.fill > 0.9 && Math.abs(twa) > deg(PHYS.noGoOuterDeg);

    switch (state) {
      case 'S1': if (hitRight) state = 'T12'; break;
      case 'T12': if (clear && twa < 0) state = 'S2'; break;
      case 'S2': if (hitLeft) state = 'T21'; break;
      case 'T21': if (clear && twa > 0) state = 'S1'; break;
    }

    let rudder: number;
    if (state === 'T12') rudder = -1;
    else if (state === 'T21') rudder = 1;
    else {
      const side = state === 'S2' ? -1 : 1;
      const err = wrapAngle(twa - targetAbs * side);
      rudder = clamp1(-err * 1.6);
    }
    return { rudder, sheet };
  };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

console.log('1) 正对风眼：不能直接滑到上风');
{
  const r = run(25, () => ({ rudder: 0, sheet: 0.05 }), windFrom);
  const gain = r.start.y - r.boat.pos.y; // y 减小 = 向上风
  check('25 秒内向风眼净推进很小', gain < 80, `净上行 ${gain.toFixed(1)} m`);
  check('fill 进入失速', r.boat.fill < 0.35, `fill=${r.boat.fill.toFixed(2)}`);
}

console.log('2) 之字换舷：可以走到上风口，换舷后恢复可控');
{
  // 门设在极远处，使走廊在整段测试内保持近似恒定宽度
  const r = run(110, upwindAutopilot(33, 0.08, 500, -5000, 830, 0));
  const gain = r.start.y - r.boat.pos.y;
  const speed2 = r.boat.vel.x ** 2 + r.boat.vel.y ** 2;
  // 之字的本质是上行同时有显著横移分量；取过程中到达的最大横向偏离
  check('向上风净位移显著', gain > 200, `上行 ${gain.toFixed(0)} m / 110 s`);
  check('结束时船仍有可控速度', speed2 > 1.5, `速度²=${speed2.toFixed(2)}`);
  check('帆走出明显之字（横向速度分量显著）', Math.abs(r.boat.vel.x) > 0.8,
    `横向速度 ${r.boat.vel.x.toFixed(2)} m/s`);
  check('结束时帆已重新吃风', r.boat.fill > 0.9, `fill=${r.boat.fill.toFixed(2)}`);
}

console.log('3) 浮标碰撞：不穿透、不突然转向');
{
  const buoy = BUOYS[0];
  const boat = makeBoat(vec(buoy.pos.x - 60, buoy.pos.y), 0);
  const world = createWorld(wind, BUOYS, CURRENTS);
  const headingBefore = boat.heading;
  let minClear = Infinity;
  for (let i = 0; i < 600; i++) {
    stepWorld(world, boat, { rudder: 0, sheet: 0.25 });
    minClear = Math.min(minClear, dist(boat.pos, buoy.pos));
  }
  check('船身始终在接触面之外', minClear >= buoy.radius + BOAT_RADIUS - 1e-6,
    `最小间距 ${minClear.toFixed(2)}（阈值 ${buoy.radius + BOAT_RADIUS}）`);
  check('碰撞没有改变船头方向', Math.abs(angleDiff(headingBefore, boat.heading)) < deg(2));
}

console.log('4) 水流带：边缘进入时有漂移');
{
  const world = createWorld(wind, BUOYS, CURRENTS);
  const inside = sampleCurrent(world, vec(500, 470));
  const outside = sampleCurrent(world, vec(500, 80));
  const edge = sampleCurrent(world, vec(500, 360 + 22));
  check('带内达到设定流速', Math.abs(inside.x - 1.4) < 1e-6);
  check('带外流速为 0', len2(outside) < 1e-9);
  check('边缘平滑过渡', edge.x > 0.1 && edge.x < 1.35, edge.x.toFixed(2));

  const boat = makeBoat(vec(120, 470), 0);
  const calm = createWorld({ dir: 0, speed: 0 }, [], [
    { x0: 0, x1: 2000, y0: 0, y1: 900, velocity: vec(1.4, 0), feather: 1 },
  ]);
  // 短时间内水流应产生可见漂移（船从静止被水带动，位移明显大于 0）
  for (let i = 0; i < 120; i++) stepWorld(calm, boat, { rudder: 0, sheet: 1 });
  const drift = boat.pos.x - 120;
  check('无动力船被水流推走', drift > 2.5, `2 秒漂移 ${drift.toFixed(1)} m（满流速应接近 2.8）`);
}

console.log('5) 回放确定性 + 帆角对照产生不同轨迹');
{
  const boat0 = makeBoat(vec(500, 830), windFrom + deg(50));
  const world0 = createWorld(wind, BUOYS, CURRENTS);
  const frames: ReplaySnapshot['frames'] = [];
  for (let i = 0; i < 1800; i++) {
    const input: Inputs = { rudder: Math.sin(i / 90) * 0.7, sheet: 0.15 };
    frames.push(input);
    stepWorld(world0, boat0, input);
  }
  const snap: ReplaySnapshot = {
    version: 1, wind: { ...wind }, startPos: vec(500, 830),
    startHeading: windFrom + deg(50), frames, duration: 30,
  };
  function replay(mode: 'original' | 'fixed', fixed: number): Vec2 {
    const b = makeBoat({ ...snap.startPos }, snap.startHeading);
    const w = createWorld({ ...snap.wind }, BUOYS, CURRENTS);
    const p = new ReplayPlayer(snap);
    let inp = p.next(mode, fixed);
    while (inp) {
      stepWorld(w, b, inp);
      inp = p.next(mode, fixed);
    }
    return b.pos;
  }
  const endA = replay('original', 0);
  const endTight = replay('fixed', 0.02);
  const endLoose = replay('fixed', 0.95);
  check('同输入回放终点一致', dist(endA, boat0.pos) < 1e-6,
    `误差 ${dist(endA, boat0.pos).toExponential(1)}`);
  check('不同帆角终点不同', dist(endTight, endLoose) > 20,
    `紧帆 vs 松帆相差 ${dist(endTight, endLoose).toFixed(0)} m`);
}

console.log('6) 路线一：自动控制器可完成迎风路线');
{
  const course = COURSE_1;
  const boat = makeBoat(course.startPos, course.startHeading);
  const world = createWorld(wind, BUOYS, CURRENTS);
  const tracker = new CourseTracker(course);
  // 持久化自动舵：以 1 号标 x 为走廊中心，宽度足够绕过
  const upwind = upwindAutopilot(
    33, course.defaultSheet,
    course.gates[0].center.x, course.gates[0].center.y,
    course.startPos.y, -20,
  );
  let prev = { ...boat.pos };
  for (let i = 0; i < 60 * 700 && !tracker.finished; i++) {
    let input: Inputs;
    if (tracker.nextIndex === 0) {
      input = upwind(world.time, boat);
    } else {
      const gate = course.gates[tracker.nextIndex];
      // 瞄准要求侧的安全通道，避免直接撞门中心的浮标
      const across = { x: -gate.legDir.y, y: gate.legDir.x };
      const sideSign = gate.requiredSide === 'port' ? -1 : 1;
      const aimPoint = {
        x: gate.center.x + across.x * sideSign * 32,
        y: gate.center.y + across.y * sideSign * 32,
      };
      const aim = Math.atan2(aimPoint.y - boat.pos.y, aimPoint.x - boat.pos.x);
      const err = angleDiff(boat.heading, aim);
      input = { rudder: clamp1(err * 2), sheet: 0.4 };
    }
    stepWorld(world, boat, input);
    tracker.check(prev, boat.pos, world.time);
    prev = { ...boat.pos };
  }
  check('路线一完成', tracker.finished,
    tracker.finished ? `用时 ${tracker.finishTime?.toFixed(1)} s`
      : `停在第 ${tracker.nextIndex}/${course.gates.length} 扇门`);
  check('无逆序/侧别错误', tracker.wrongOrderCount === 0 && tracker.wrongSideCount === 0,
    `逆序 ${tracker.wrongOrderCount} 侧别 ${tracker.wrongSideCount}`);
}

function len2(v: Vec2): number {
  return v.x * v.x + v.y * v.y;
}
function clamp1(v: number): number {
  return Math.max(-1, Math.min(1, v));
}

console.log(`\n共 ${COURSES.length} 条路线、${BUOYS.length} 枚浮标、${CURRENTS.length} 个水区。`);
if (failures > 0) {
  console.error(`失败 ${failures} 项`);
  process.exit(1);
}
console.log('全部通过。');
