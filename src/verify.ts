import { LEVELS } from './levels';
import { runDemoAction } from './demo';
import {
  collisionInState,
  findStablePad,
  groundFrame,
  handleDistanceError,
  isComplete,
  makeInitialState,
  pickupFrame,
  sweepPivot,
  sweepTranslate,
  type GameState,
} from './engine';
import { HANDLE_DISTANCE } from './types';

let failures = 0;

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    failures++;
    console.error(`  ✗ ${message}`);
  } else {
    console.log(`  ✓ ${message}`);
  }
}

function f2(v: { x: number; y: number }): string {
  return `(${v.x.toFixed(1)}, ${v.y.toFixed(1)})`;
}

function runFullDemo(levelIndex: number): GameState {
  const level = LEVELS[levelIndex]!;
  let state = makeInitialState(level);
  console.log(`\n[${level.name}] 执行内置演示，共 ${level.demo.length} 步`);

  level.demo.forEach((action, i) => {
    const before = state;
    const out = runDemoAction(state, action, level);
    state = out.state;
    const invariant = handleDistanceError(state) < 0.01;
    const collision = collisionInState(state, level);
    if (!out.ok || !invariant || collision) {
      console.error(
        `第 ${i + 1} 步失败 (${action.t}): ok=${out.ok}, message="${out.message}", ` +
          `distanceError=${handleDistanceError(state).toFixed(3)}, collision=${collision?.subject}:${collision?.obstacle}`,
      );
      console.error('  before h:', f2(before.h[0]!), f2(before.h[1]!), 'p:', f2(before.people[0]!), f2(before.people[1]!));
      console.error('  after  h:', f2(state.h[0]!), f2(state.h[1]!), 'p:', f2(state.people[0]!), f2(state.people[1]!));
      if (action.t === 'pivot') console.error('  delta:', action.delta, 'who:', action.who);
      if (action.t === 'translate') console.error('  dx/dy:', action.dx, action.dy);
      if (action.t === 'walk') console.error('  to:', f2(action.to));
      failures++;
    }
  });

  assert(isComplete(state, level), `${level.name} 演示结束时画框完整入架且方向正确`);
  assert(handleDistanceError(state) < 0.01, `${level.name} 全程把手距离保持 ${HANDLE_DISTANCE}`);
  return state;
}

function verifyTrap(levelIndex: number): void {
  const level = LEVELS[levelIndex]!;
  const s = makeInitialState(level);
  const trap = level.trap;
  let result;
  if (trap.t === 'pivot') result = sweepPivot(s, trap.who, trap.delta, level);
  else if (trap.t === 'translate') result = sweepTranslate(s, trap.dx, trap.dy, level);
  else result = sweepPivot(s, 0, 0, level);

  assert(result.reached === false && result.block !== null, `${level.name} 非法长距离拖动“${trap.label}”在途中被拦下`);
  if (trap.expectSubject) {
    assert(result.block?.subject === trap.expectSubject, `拦截提示对象为 ${trap.expectSubject}，实际为 ${result.block?.subject ?? '无'}`);
  }
  if (result.block) console.log(`    拦截信息：${result.message}`);
  assert(collisionInState(result.state, level) === null, '拦下后保留的最后安全姿态没有穿墙');
}

function verifyDropPickup(): void {
  console.log('\n[落地/拿起] 专项检查');
  const level = LEVELS[0]!;
  const initial = makeInitialState(level);

  const illegalState: GameState = {
    ...initial,
    h: [
      { x: 500, y: 500 },
      { x: 680, y: 500 },
    ],
    people: [
      { x: 500, y: 500 },
      { x: 680, y: 500 },
    ],
  };
  const denied = groundFrame(illegalState, level);
  assert(denied.ok === false, '非允许区域放手被拒绝');
  assert(denied.state === illegalState && denied.state.mode === 'carry', '被拒绝的放手保持原状态，不落地也不复制画框');

  const dropped = groundFrame(initial, level);
  assert(dropped.ok && dropped.state.mode === 'ground', '起点驿站可以落地');
  assert(dropped.state.h[0] !== initial.h[0] || dropped.state.mode === 'ground', '落地后仍只有同一个画框状态');

  const picked = pickupFrame(dropped.state, level);
  assert(picked.ok && picked.state.mode === 'carry', '站稳后可以重新拿起');
  assert(
    picked.state.h[0]!.x === initial.h[0]!.x && picked.state.h[1]!.x === initial.h[1]!.x,
    '放下再拿起不会复制或偏移画框',
  );

  const cornerPose: GameState = {
    ...initial,
    h: [
      { x: 825, y: 375 },
      { x: 825, y: 555 },
    ],
    people: [
      { x: 825, y: 375 },
      { x: 825, y: 555 },
    ],
  };
  assert(collisionInState(cornerPose, level) === null, '拐角暂放台的竖向姿态合法');
  assert(findStablePad(cornerPose, level) === 'pad-1-corner', '第一关拐角处还有第二个允许落地/换手点');
}

for (let i = 0; i < LEVELS.length; i++) {
  const level = LEVELS[i]!;
  assert(collisionInState(makeInitialState(level), level) === null, `${level.name} 初始姿态合法`);
  runFullDemo(i);
  verifyTrap(i);
}

verifyDropPickup();

console.log(`\n${failures === 0 ? '全部本地验证通过 ✅' : `存在 ${failures} 个验证失败 ❌`}`);
if (failures > 0) process.exit(1);
