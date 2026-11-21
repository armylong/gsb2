import type { CharState, Input } from './types.js';

/**
 * 录入的操作样例: 每个样例 = 出生点 + 时长 + 逐帧输入函数 + 期望。
 * 主程序里按 1..5 可回放; `npm run verify` 在 Node 中回放并断言状态流转。
 */
export interface SampleDef {
  name: string;
  desc: string;
  spawn: { x: number; y: number };
  duration: number; // 秒
  inputAt(t: number): Input;
  expect: {
    /** 状态流转需按序出现(子序列匹配) */
    sequence: CharState[];
    /** 不得出现的状态 */
    never?: CharState[];
    /** 回放结束时的状态 */
    endState?: CharState;
    /** 某一时刻应处于的状态 */
    atTime?: { t: number; state: CharState };
    /** 贴墙滑落期间 vy 不得超过 WALL_SLIDE_SPEED */
    checkWallSlideCap?: boolean;
  };
}

const I = (o: Partial<Input> = {}): Input => ({
  left: false, right: false, jump: false, down: false, jumpPressed: false, ...o,
});

// 按键按下的时间窗(略宽于一帧, 保证固定步长下能命中)
const pressed = (t: number, at: number) => t >= at && t < at + 0.03;

export const SAMPLES: SampleDef[] = [
  {
    name: 'wall-slide',
    desc: '贴墙滑落: 空中贴住高墙, 下落速度被钳制',
    spawn: { x: 170, y: 240 },
    duration: 3.5,
    inputAt: (t) => I({ left: t < 3.0 }),
    expect: {
      sequence: ['air', 'wallslide', 'ground'],
      endState: 'ground',
      checkWallSlideCap: true,
    },
  },
  {
    name: 'failed-grab',
    desc: '抓边失败: 原地起跳高度不够, 手未进入可抓范围, 落回地面',
    spawn: { x: 340, y: 520 },
    duration: 2.0,
    inputAt: (t) => I({ jump: pressed(t, 0.1), jumpPressed: pressed(t, 0.1) }),
    expect: {
      sequence: ['ground', 'air', 'ground'],
      never: ['ledge', 'mantle'],
      endState: 'ground',
    },
  },
  {
    name: 'low-ceiling',
    desc: '低顶阻挡: 抓住低顶平台边缘后翻身被障碍挡住, 回到悬挂(可控), 再按键取消松手',
    spawn: { x: 660, y: 360 },
    duration: 3.5,
    inputAt: (t) => I({
      right: t < 1.2,
      jump: pressed(t, 1.0),
      jumpPressed: pressed(t, 1.0),
      down: t >= 1.8,
    }),
    expect: {
      sequence: ['air', 'wallslide', 'ledge', 'air', 'ground'],
      never: ['mantle'],
      atTime: { t: 1.3, state: 'ledge' }, // 翻身被挡后仍挂在边缘上(可控)
      endState: 'ground',
    },
  },
  {
    name: 'mantle-success',
    desc: '抓边+翻身成功: 贴主平台左侧滑下抓住左角, 翻上平台站定',
    spawn: { x: 270, y: 340 },
    duration: 2.5,
    inputAt: (t) => I({
      right: t < 1.2,
      jump: pressed(t, 1.0),
      jumpPressed: pressed(t, 1.0),
    }),
    expect: {
      sequence: ['air', 'ledge', 'mantle', 'ground'],
      endState: 'ground',
    },
  },
  {
    name: 'walk-off',
    desc: '下落走离: 在箱子上走出边缘, 支撑解除落回地面',
    spawn: { x: 420, y: 440 },
    duration: 2.0,
    inputAt: (t) => I({ left: t < 1.5 }),
    expect: {
      sequence: ['ground', 'air', 'ground'],
      never: ['ledge', 'mantle'],
      endState: 'ground',
    },
  },
];
