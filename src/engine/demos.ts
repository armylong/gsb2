import { createSim, stepSim } from './simulation';
import { TEST_PRESETS } from './world';
import { DEFAULT_PARAMS, FIXED_DT, type InputState, type SimEvent, type TunableParams, type WorldPreset } from './types';

/** 一条脚本输入：在第 startStep..endStep（左闭右开）步内生效 */
export interface InputSpan {
  startStep: number;
  endStep: number;
  move?: number;
  /** 在 startStep 这一步产生跳跃按下边沿 */
  jumpAtStart?: boolean;
}

export interface DemoDef {
  id: string;
  name: string;
  description: string;
  preset: WorldPreset;
  durationSec: number;
  spans: InputSpan[];
}

function buildInput(spans: InputSpan[], step: number): InputState {
  let move = 0;
  let jumpPressed = false;
  for (const s of spans) {
    if (step >= s.startStep && step < s.endStep) {
      move = s.move ?? 0;
      if (s.jumpAtStart && step === s.startStep) jumpPressed = true;
    }
  }
  return { move, jumpPressed };
}

/**
 * 四个演示入口。输入以引擎步号（1/60s 一格）编排，
 * 因此无论 30 还是 60 显示节奏、无论手动播放还是自动化跑，结果完全一致。
 */
export const DEMOS: DemoDef[] = [
  {
    id: 'reverse',
    name: '站台换向',
    description: '出生即落在水平移动平台上，保持不动经过两次端点换向；观察角色不被弹起、不被甩开，支撑关系始终保持。',
    preset: TEST_PRESETS.platformRide,
    durationSec: 6,
    spans: [{ startStep: 1, endStep: 360 }],
  },
  {
    id: 'platform-jump',
    name: '平台上起跳',
    description: '在水平平台运行中起跳，对比开关“继承平台速度”下的水平轨迹；起跳只继承一次平台速度，落地后重新建立支撑。',
    preset: TEST_PRESETS.platformRide,
    durationSec: 4,
    spans: [
      // 站稳后在平台运动中起跳
      { startStep: 60, endStep: 61, jumpAtStart: true },
      { startStep: 61, endStep: 240 },
    ],
  },
  {
    id: 'head-bump',
    name: '撞顶落地',
    description: '在低顶正下方起跳，角色头顶碰撞后立即停止上升并落回地面，落地后可再次起跳。',
    preset: TEST_PRESETS.ceiling,
    durationSec: 3.5,
    spans: [
      // 站稳后起跳，必然撞顶
      { startStep: 20, endStep: 21, jumpAtStart: true },
      // 落地恢复后再跳一次，验证落地即恢复起跳能力
      { startStep: 110, endStep: 111, jumpAtStart: true },
      { startStep: 111, endStep: 210 },
    ],
  },
  {
    id: 'edge-coyote',
    name: '边缘宽限',
    description: '从台沿走出后在土狼时间内起跳（coyote-jump），再演示落地前跳跃预输入（buffered-jump）；两者时长均可在左侧调节。',
    preset: TEST_PRESETS.edge,
    durationSec: 4.2,
    spans: [
      // 走出右缘（约第 10 步离地），在宽限窗口内起跳
      { startStep: 3, endStep: 20, move: 1 },
      { startStep: 14, endStep: 15, jumpAtStart: true },
      // 落地前预输入：落地瞬间自动起跳
      { startStep: 95, endStep: 96, jumpAtStart: true },
      { startStep: 96, endStep: 252 },
    ],
  },
];

export interface DemoRunResult {
  finalX: number;
  finalY: number;
  events: SimEvent[];
}

/** 脱离 DOM 跑完整演示，供自检与测试复用 */
export function runDemo(def: DemoDef, params: TunableParams = DEFAULT_PARAMS): DemoRunResult {
  const state = createSim(def.preset, params);
  const total = Math.round(def.durationSec / FIXED_DT);
  for (let step = 1; step <= total; step++) {
    stepSim(state, def.preset, buildInput(def.spans, step));
  }
  return { finalX: state.player.x, finalY: state.player.y, events: [...state.events] };
}
