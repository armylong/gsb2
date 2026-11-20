import { Channel, LinkConfig, NetConfig, TICK_MS } from './protocol';

/** 网络事件：在确定时刻改链路参数（只影响新消息），或打一条日志 */
export type NetEvent =
  | { atMs: number; type: 'setLink'; channel: Channel; patch: Partial<LinkConfig> }
  | { atMs: number; type: 'log'; text: string };

export interface ScenarioDef {
  id: string;
  name: string;
  description: string;
  durationMs: number;
  initialNet: NetConfig;
  /** 每个逻辑 tick 的按键位掩码，索引即 tick（稀疏处补 0） */
  keysPerTick: number[];
  events: NetEvent[];
}

const BASE_LINK: LinkConfig = { delayMs: 120, jitterMs: 40, lossPct: 0 };

/** 用“按住区间”构造逐 tick 按键数组 */
function buildTrace(durationMs: number, holds: Array<{ fromMs: number; toMs: number; keys: number }>): number[] {
  const ticks = Math.ceil(durationMs / TICK_MS);
  const arr = new Array<number>(ticks).fill(0);
  for (const h of holds) {
    const from = Math.floor(h.fromMs / TICK_MS);
    const to = Math.ceil(h.toMs / TICK_MS);
    for (let t = from; t < to && t < ticks; t++) arr[t] = h.keys;
  }
  return arr;
}

const KEY_R = 8;
const KEY_U = 1;
const KEY_L = 4;
const KEY_D = 2;

/**
 * 场景①：转角碰墙。
 * 先向右走到 L 形墙下方，再向上顶住横墙底面，随后向左贴墙滑动、绕过转角。
 * 整条录像确定，配合固定种子可逐帧复现碰撞与纠正。
 */
function cornerScenario(): ScenarioDef {
  const durationMs = 13200;
  const keysPerTick = buildTrace(durationMs, [
    // 阶段一：走到 L 形墙下，顶住横段底面、向左贴墙滑到竖墙转角（碰撞演示，两端规则一致）
    { fromMs: 0, toMs: 900, keys: KEY_R },
    { fromMs: 900, toMs: 2200, keys: KEY_U },
    { fromMs: 2200, toMs: 2900, keys: KEY_U | KEY_L },
    // 阶段二：U 形折返——右行越过 T 形墙横段右端（x>670），垂直下到底边界，
    // 再沿底边界向左回到出生点一侧；走外墙通道，不与任何内墙相交
    { fromMs: 2900, toMs: 4750, keys: KEY_R },
    { fromMs: 4750, toMs: 6950, keys: KEY_D },
    { fromMs: 6950, toMs: 10300, keys: KEY_L },
    // 阶段三：沿底部无墙走廊向右穿过权威推挤区（紫色）并持续按住右键，
    // 输入/确认持续流动，权威端独有的推力逐快照产生真实预测纠正
    { fromMs: 10300, toMs: 13100, keys: KEY_R },
  ]);
  return {
    id: 'corner',
    name: '转角碰墙',
    description: '先在 L 形墙转角处贴墙滑动，再进入权威推挤区，观察碰撞一致与权威外力造成的预测纠正。',
    durationMs,
    initialNet: { up: { ...BASE_LINK }, down: { ...BASE_LINK } },
    keysPerTick,
    events: [
      { atMs: 0, type: 'log', text: '场景①开始：转角碰墙 + 推挤区录像播放中' },
      { atMs: 10300, type: 'log', text: '进入权威推挤区：权威端施加客户端不模拟的外力，注意误差连线与纠正日志' },
    ],
  };
}

/**
 * 场景②：快照乱序。
 * 中段把下行延迟短暂拉高再恢复，使高压期发出的快照比后续快照更晚到达；
 * 客户端必须依据 serverTick 拒绝旧快照，确认进度不许倒退。
 */
function reorderScenario(): ScenarioDef {
  const durationMs = 6000;
  const keysPerTick = buildTrace(durationMs, [{ fromMs: 0, toMs: 2600, keys: KEY_R }]);
  return {
    id: 'reorder',
    name: '快照乱序',
    description: '下行延迟尖峰制造快照乱序，验证旧快照被拒绝、确认进度不倒退。',
    durationMs,
    initialNet: { up: { ...BASE_LINK }, down: { ...BASE_LINK } },
    keysPerTick,
    events: [
      { atMs: 0, type: 'log', text: '场景②开始：快照乱序录像播放中' },
      { atMs: 500, type: 'setLink', channel: 'down', patch: { delayMs: 750, jitterMs: 30 } },
      { atMs: 500, type: 'log', text: '下行延迟拉高到 750ms（只影响新快照）' },
      { atMs: 1300, type: 'setLink', channel: 'down', patch: { delayMs: 90, jitterMs: 10 } },
      { atMs: 1300, type: 'log', text: '下行延迟恢复到 90ms，等待观察旧快照迟到被拒绝' },
      { atMs: 3200, type: 'setLink', channel: 'down', patch: { delayMs: 120, jitterMs: 40 } },
    ],
  };
}

/**
 * 场景③：短暂丢包。
 * 1.2s 窗口内上行 80% 丢包、下行 50% 丢包；输入通道可靠（RTO 重传），
 * 窗口结束后所有输入序号必须最终被确认，两端收敛，不允许静默丢动作。
 */
function lossScenario(): ScenarioDef {
  const durationMs = 8000;
  const keysPerTick = buildTrace(durationMs, [
    { fromMs: 0, toMs: 2200, keys: KEY_R | KEY_U },
    { fromMs: 2200, toMs: 3000, keys: KEY_D },
  ]);
  return {
    id: 'loss',
    name: '短暂丢包',
    description: '80% 上行丢包持续 1.2s，验证重传把每个输入都送到、最终确认且收敛。',
    durationMs,
    initialNet: { up: { ...BASE_LINK }, down: { ...BASE_LINK } },
    keysPerTick,
    events: [
      { atMs: 0, type: 'log', text: '场景③开始：短暂丢包录像播放中' },
      { atMs: 400, type: 'setLink', channel: 'up', patch: { lossPct: 80 } },
      { atMs: 400, type: 'setLink', channel: 'down', patch: { lossPct: 50 } },
      { atMs: 400, type: 'log', text: '进入丢包窗口：上行 80% / 下行 50%' },
      { atMs: 1600, type: 'setLink', channel: 'up', patch: { lossPct: 0 } },
      { atMs: 1600, type: 'setLink', channel: 'down', patch: { lossPct: 0 } },
      { atMs: 1600, type: 'log', text: '丢包窗口结束，等待重传补齐全部输入' },
    ],
  };
}

export const SCENARIOS: ScenarioDef[] = [cornerScenario(), reorderScenario(), lossScenario()];

export function getScenario(id: string): ScenarioDef | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
