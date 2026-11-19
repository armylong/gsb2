import { GameMap } from './map';
import { Sim, NPC } from './sim';

export interface Preset {
  name: string;
  description: string;
  build(): Sim;
}

const W = 30;
const H = 20;

/** 只有外墙的空场地 */
function emptyMap(): GameMap {
  const m = new GameMap(W, H);
  for (let x = 0; x < W; x++) {
    m.at(x, 0).terrain = 'wall';
    m.at(x, H - 1).terrain = 'wall';
  }
  for (let y = 0; y < H; y++) {
    m.at(0, y).terrain = 'wall';
    m.at(W - 1, y).terrain = 'wall';
  }
  return m;
}

function wallRect(m: GameMap, x0: number, y0: number, x1: number, y1: number): void {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) m.at(x, y).terrain = 'wall';
}

function npc(id: number, name: string, x: number, y: number, threshold: number): NPC {
  return new NPC(id, name, x, y, threshold);
}

/** 默认图:四个房间 + 走廊,门有开有关 */
function buildDefault(): Sim {
  const m = emptyMap();
  // 竖墙 x=9 与 x=20,横墙 y=9,各留通道与门
  wallRect(m, 9, 1, 9, 8);
  wallRect(m, 9, 10, 9, 18);
  wallRect(m, 20, 1, 20, 8);
  wallRect(m, 20, 10, 20, 18);
  wallRect(m, 1, 9, 8, 9);
  wallRect(m, 10, 9, 19, 9);
  wallRect(m, 21, 9, 28, 9);
  // 横墙上的通道口
  m.at(4, 9).terrain = 'floor';
  m.at(13, 9).terrain = 'floor';
  m.at(24, 9).terrain = 'floor';
  // 竖墙上的门:两开两关
  const doors: [number, number, boolean][] = [
    [9, 3, false],
    [20, 3, true],
    [9, 12, true],
    [20, 12, false],
  ];
  for (const [x, y, open] of doors) {
    m.at(x, y).terrain = 'door';
    m.at(x, y).doorOpen = open;
  }
  // 一些柱子
  wallRect(m, 3, 6, 4, 6);
  wallRect(m, 25, 6, 26, 6);
  const npcs = [npc(1, '甲', 4, 5, 4), npc(2, '乙', 25, 2, 6), npc(3, '丙', 14, 15, 3)];
  return new Sim(m, npcs);
}

/** 示例1:绕墙传声 —— 声源与 NPC 之间被开口向下的墙隔开,声音必须绕行 */
function buildDetour(): Sim {
  const m = emptyMap();
  wallRect(m, 16, 6, 26, 6); // 顶边
  wallRect(m, 16, 7, 16, 11); // 左边
  wallRect(m, 26, 7, 26, 11); // 右边,底部敞开
  const npcs = [
    npc(1, '甲', 21, 9, 4), // 墙围内,只能等声音从下方绕进来
    npc(2, '乙', 4, 16, 5), // 距离远,强度不足
    npc(3, '丙', 8, 4, 4), // 开阔处,正常听到
  ];
  const sim = new Sim(m, npcs);
  sim.emit('impact', 13, 9);
  return sim;
}

/** 示例2:关门衰减 —— 同一声源,关门时听不到,开门后能听到 */
function buildDoor(): Sim {
  const m = emptyMap();
  wallRect(m, 15, 1, 15, 18);
  m.at(15, 10).terrain = 'door';
  m.at(15, 10).doorOpen = false;
  const npcs = [
    npc(1, '甲', 20, 10, 8), // 门后:关门强度不足,开门可听到
    npc(2, '乙', 8, 4, 4), // 与声源同侧,总能听到
    npc(3, '丙', 24, 16, 2), // 太远,强度耗尽到不了
  ];
  const sim = new Sim(m, npcs);
  sim.emit('impact', 8, 10);
  return sim;
}

/** 示例3:双声源竞争 —— NPC 先听到远处的撞击,后听到近处的脚步,调查目标随之切换 */
function buildCompete(): Sim {
  const m = emptyMap();
  const npcs = [npc(1, '甲', 15, 10, 3), npc(2, '乙', 6, 6, 5), npc(3, '丙', 24, 14, 5)];
  const sim = new Sim(m, npcs);
  sim.emit('impact', 15, 3); // t=0 远处撞击,先到达甲
  sim.schedule(6, 'footstep', 19, 10); // t=6 近处脚步,后到达,甲改查它
  return sim;
}

export const PRESETS: Preset[] = [
  {
    name: '默认房间图',
    description: '四个房间由走廊和门相连,门有开有关。自行点击格子发声,或切换编辑模式改门改墙。',
    build: buildDefault,
  },
  {
    name: '示例1:绕墙传声',
    description:
      '甲被三面墙围住(底部敞开),撞击声必须向下绕行再进入,到达时间和剩余强度按绕行路径计算,而非直线距离。乙太远强度不足,可对比三人不同的结果。',
    build: buildDetour,
  },
  {
    name: '示例2:关门衰减',
    description:
      '甲与声源之间隔着一扇关闭的门,穿门额外衰减导致强度低于阈值而听不到。用门编辑模式把门打开,再到同一格重新发声,甲即可听到(旧事件仍按关门时的快照传播)。',
    build: buildDoor,
  },
  {
    name: '示例3:双声源竞争',
    description:
      't=0 远处发出撞击,t=6 近处发出脚步。甲先调查撞击,脚步到达后改为调查脚步(最新听到者优先)。可在 NPC 面板看到两个事件各自的到达时刻与强度。',
    build: buildCompete,
  },
];
