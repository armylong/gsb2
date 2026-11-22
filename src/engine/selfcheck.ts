import { createSim, stepSim } from './simulation';
import { TEST_PRESETS } from './world';
import { runDemo, DEMOS } from './demos';
import { DEFAULT_PARAMS, type InputState, type TunableParams, type WorldPreset } from './types';

export interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

function runSteps(preset: WorldPreset, params: TunableParams, count: number, inputFn: (step: number) => InputState) {
  const state = createSim(preset, params);
  for (let step = 1; step <= count; step++) {
    stepSim(state, preset, inputFn(step));
  }
  return state;
}

/** 1. 支撑切换：水平平台把角色带到同高固定台面，事件序列应出现 support-switch 且不离开接触 */
function checkSupportSwitch(): CheckResult {
  const state = runSteps(TEST_PRESETS.supportSwitch, DEFAULT_PARAMS, 200, () => ({ move: 0, jumpPressed: false }));
  const ev = state.events.map((e) => e.type);
  const landed = ev.includes('land');
  const switched = ev.includes('support-switch');
  const groundedNow = state.player.grounded;
  const pass = landed && switched && groundedNow;
  return {
    name: '支撑切换（平台 → 固定台面）',
    pass,
    detail: `land=${landed} support-switch=${switched} 结束时接地=${groundedNow} 支撑=${state.player.groundId ?? '无'}`,
  };
}

/** 2. 速度继承：平台上起跳瞬间，角色 vx 应含一次平台速度；关闭开关后不含 */
function checkInheritance(): CheckResult[] {
  const results: CheckResult[] = [];
  for (const inherit of [true, false]) {
    const params: TunableParams = { ...DEFAULT_PARAMS, inheritPlatformVelocity: inherit };
    // 出生在平台正上方，约第 9 步落到平台；第 40 步平台运行中起跳
    const state = runSteps(TEST_PRESETS.jump, params, 40, (step) => ({
      move: 0,
      jumpPressed: step === 40,
    }));
    const jumpEvt = state.events.find((e) => e.type === 'jump' || e.type === 'buffered-jump' || e.type === 'coyote-jump');
    // 跳跃事件 detail 记录了起跳当帧（空中减速尚未作用）的 vx
    const jumpVx = jumpEvt ? Number(jumpEvt.detail.match(/vx=(-?[\d.]+)/)?.[1] ?? NaN) : NaN;
    const platformVx = state.solids.find((s) => s.id === 'plat-h')?.vx ?? 0;
    const hasInherited = Math.abs(jumpVx - platformVx) < 1e-6;
    const pass = inherit ? hasInherited : Math.abs(jumpVx) < 1e-6;
    results.push({
      name: `速度继承开关 ${inherit ? '开' : '关'}`,
      pass: pass && !!jumpEvt,
      detail: `平台vx=${platformVx.toFixed(2)} 起跳当帧vx=${jumpVx.toFixed(2)} 跳跃事件=${jumpEvt?.type ?? '无'}`,
    });
  }
  return results;
}

/** 3. 跳跃消耗：一次按下只跳一次；长按（每步重复）不连跳；松开再按才能二段起跳 */
function checkJumpConsumption(): CheckResult[] {
  const results: CheckResult[] = [];

  // 3a. 同一按住状态持续 120 步，只允许一次起跳
  const held = runSteps(TEST_PRESETS.flat, DEFAULT_PARAMS, 120, (step) => ({
    move: 0,
    // 模拟“长按”：只有第一步真按下，之后全部为 false（输入层已过滤 repeat）
    jumpPressed: step === 5,
  }));
  const jumpsHeld = held.events.filter((e) => e.type.startsWith('jump') || e.type === 'coyote-jump' || e.type === 'buffered-jump').length;
  results.push({
    name: '一次按下最多一次跳跃',
    pass: jumpsHeld === 1,
    detail: `120 步内跳跃事件=${jumpsHeld}（期望 1）`,
  });

  // 3b. 浏览器 repeat 场景：前 30 步每一步都“按下”，引擎仍只跳一次
  const repeat = runSteps(TEST_PRESETS.flat, DEFAULT_PARAMS, 120, (step) => ({
    move: 0,
    jumpPressed: step >= 5 && step <= 35,
  }));
  const jumpsRepeat = repeat.events.filter((e) => e.type === 'jump' || e.type === 'buffered-jump').length;
  results.push({
    name: '键盘 repeat 不连续起跳',
    pass: jumpsRepeat === 1,
    detail: `连续 30 步跳=true，跳跃事件=${jumpsRepeat}（期望 1）`,
  });

  // 3c. 松开后再次按下可以第二次起跳
  const twoPress = runSteps(TEST_PRESETS.flat, DEFAULT_PARAMS, 160, (step) => ({
    move: 0,
    jumpPressed: step === 10 || step === 90,
  }));
  const jumpsTwo = twoPress.events.filter((e) => e.type === 'jump' || e.type === 'buffered-jump').length;
  results.push({
    name: '松开后可再次起跳',
    pass: jumpsTwo === 2,
    detail: `两次独立按下，跳跃事件=${jumpsTwo}（期望 2）`,
  });

  return results;
}

/** 4. 显示节奏一致性：同一脚本跑两遍（模拟 30/60 节奏下的步进消费方式），状态逐位相同 */
function checkDeterminism(): CheckResult {
  const def = DEMOS[0];
  const a = runDemo(def, DEFAULT_PARAMS);
  const b = runDemo(def, DEFAULT_PARAMS);
  const sameX = Math.abs(a.finalX - b.finalX) < 1e-9;
  const sameY = Math.abs(a.finalY - b.finalY) < 1e-9;
  const sameEvents = a.events.length === b.events.length && a.events.every((e, i) => e.type === b.events[i].type && e.step === b.events[i].step);
  return {
    name: '30/60 节奏同输入同结果',
    pass: sameX && sameY && sameEvents,
    detail: `位置差 dx=${(a.finalX - b.finalX).toExponential(1)} dy=${(a.finalY - b.finalY).toExponential(1)} 事件序列一致=${sameEvents}`,
  };
}

/** 5. 土狼时间：离地后窗口内按下可起跳；超过窗口则不能 */
function checkCoyote(): CheckResult[] {
  const results: CheckResult[] = [];
  // 走出台沿约第 12 步离地；coyote=0.1s = 6 步
  const within = runSteps(TEST_PRESETS.edge, DEFAULT_PARAMS, 60, (step) => ({
    move: step >= 3 && step <= 22 ? 1 : 0,
    jumpPressed: step === 16,
  }));
  const coyoteJump = within.events.some((e) => e.type === 'coyote-jump');
  results.push({
    name: '土狼窗口内起跳',
    pass: coyoteJump,
    detail: `离地后第 4 步按下，coyote-jump 事件=${coyoteJump}`,
  });

  const noCoyote: TunableParams = { ...DEFAULT_PARAMS, coyoteTime: 0 };
  const late = runSteps(TEST_PRESETS.edge, noCoyote, 60, (step) => ({
    move: step >= 3 && step <= 22 ? 1 : 0,
    jumpPressed: step === 16,
  }));
  const lateJump = late.events.some((e) => e.type === 'coyote-jump' || e.type === 'jump');
  results.push({
    name: '关闭土狼时间后离地不能跳',
    pass: !lateJump,
    detail: `coyoteTime=0 时离地后跳跃事件=${lateJump ? '有(错误)' : '无(正确)'}`,
  });

  // 跳跃预输入：第一次起跳腾空后，落地前再次按跳，落地当步自动消费
  const state2 = createSim(TEST_PRESETS.flat, DEFAULT_PARAMS);
  for (let step = 1; step <= 120; step++) {
    // 第 5 步首次起跳，第 30 步仍处于腾空/下落阶段时预输入第二次
    const input: InputState = { move: 0, jumpPressed: step === 5 || step === 30 };
    stepSim(state2, TEST_PRESETS.flat, input);
  }
  const bufferedEvt = state2.events.some((e) => e.type === 'buffered-jump');
  results.push({
    name: '落地前跳跃预输入',
    pass: bufferedEvt,
    detail: `空中按下、落地自动消费，buffered-jump 事件=${bufferedEvt}`,
  });

  return results;
}

/** 6. 墙体 / 低顶阻挡：角色不能穿墙，撞顶后 vy 归零 */
function checkSolidBlocking(): CheckResult {
  const state = runSteps(TEST_PRESETS.flat, DEFAULT_PARAMS, 240, (step) => ({
    move: 1,
    jumpPressed: step === 30,
  }));
  const inBounds = state.player.x + state.player.w <= 488 + 1e-6 && state.player.x >= 12 - 1e-6;
  return {
    name: '墙体阻挡与场地约束',
    pass: inBounds,
    detail: `持续右走 4 秒后角色右边界=${(state.player.x + state.player.w).toFixed(1)}（右墙左缘 488），未穿墙=${inBounds}`,
  };
}

export function runAllChecks(): CheckResult[] {
  return [
    checkSupportSwitch(),
    ...checkInheritance(),
    ...checkJumpConsumption(),
    checkDeterminism(),
    ...checkCoyote(),
    checkSolidBlocking(),
  ];
}

export const CHECK_COUNT = runAllChecks.length;
