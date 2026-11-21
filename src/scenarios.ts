import { makeLevel, makeNode, type Edge, type Level, type LogicNode } from './model';

export type ScenarioId = 'cross-step' | 'dual-gate' | 'two-input' | 'feedback-latch';

export interface ScenarioMeta {
  id: ScenarioId;
  title: string;
  blurb: string;
}

export const SCENARIOS: ScenarioMeta[] = [
  {
    id: 'cross-step',
    title: '跨步反馈: 开关 → 延时 → 门 → 门',
    blurb:
      'A 开关经 2 步延时进入 AND 门的 IN A; 压力板接 IN B. 第 1 步翻转 A 并踩上压力板, 观察门在第几步打开、保持几步, 以及可通行状态.',
  },
  {
    id: 'dual-gate',
    title: '双输入门: 两开关同时翻转',
    blurb: '同一结算时刻翻转 A/B 两开关; XOR/NAND 观察合流后的稳定值.',
  },
  {
    id: 'two-input',
    title: '两输入步进: 开关 + 压力板',
    blurb: '角色走到压力板上与拨动开关同时提交, 检查门是否在同一结算时刻收到两个变化.',
  },
  {
    id: 'feedback-latch',
    title: '无延时反馈: 稳定自锁与冲突',
    blurb: '上排 OR 自锁环在开关打开后收敛为 ON 并保持; 下排 NAND 环在 B 打开后振荡, 应报冲突并冻结.',
  },
];

let counter = 0;
export function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

function nodes(list: LogicNode[]): LogicNode[] {
  return list;
}

function edge(from: string, to: string, toPort = 0, id?: string): Edge {
  return { id: id ?? uid('edge'), from, to, toPort };
}

export function buildScenario(id: ScenarioId): Level {
  switch (id) {
    case 'cross-step': {
      const sw = makeNode('switch', 'sw-a', { x: 1, y: 2 }, { name: 'A 开关' });
      const delay = makeNode('delay', 'dl-1', { x: 4, y: 2 }, { name: '2 步延时', steps: 2 });
      const plate = makeNode('plate', 'pl-1', { x: 3, y: 5 }, { name: '压力板' });
      const gate = makeNode('gate', 'gt-and', { x: 6, y: 3 }, { name: '跨步 AND', op: 'and' });
      const door = makeNode('door', 'dr-1', { x: 10, y: 2 }, { name: '东门' });
      const lamp = makeNode('lamp', 'lp-1', { x: 10, y: 5 }, { name: '通行灯' });
      return makeLevel({
        name: '跨步反馈',
        cols: 12,
        rows: 7,
        home: { x: 2, y: 5 },
        nodes: nodes([sw, delay, plate, gate, door, lamp]),
        edges: [
          edge(sw.id, delay.id, 0, 'e-sw-dl'),
          edge(delay.id, gate.id, 0, 'e-dl-gt'),
          edge(plate.id, gate.id, 1, 'e-pl-gt'),
          edge(gate.id, door.id, 0, 'e-gt-dr'),
          edge(gate.id, lamp.id, 0, 'e-gt-lp'),
        ],
      });
    }
    case 'dual-gate': {
      const a = makeNode('switch', 'sw-a', { x: 2, y: 2 }, { name: 'A' });
      const b = makeNode('switch', 'sw-b', { x: 2, y: 5 }, { name: 'B' });
      const xor = makeNode('gate', 'gt-xor', { x: 6, y: 2 }, { name: 'XOR 门', op: 'xor' });
      const nand = makeNode('gate', 'gt-nand', { x: 6, y: 5 }, { name: 'NAND 门', op: 'nand' });
      const lamp1 = makeNode('lamp', 'lp-xor', { x: 10, y: 2 }, { name: 'XOR 灯' });
      const lamp2 = makeNode('lamp', 'lp-nand', { x: 10, y: 5 }, { name: 'NAND 灯' });
      return makeLevel({
        name: '双输入门',
        cols: 12,
        rows: 8,
        home: { x: 1, y: 7 },
        nodes: nodes([a, b, xor, nand, lamp1, lamp2]),
        edges: [
          edge(a.id, xor.id, 0, 'e-a-xor0'),
          edge(b.id, xor.id, 1, 'e-b-xor1'),
          edge(a.id, nand.id, 0, 'e-a-nand0'),
          edge(b.id, nand.id, 1, 'e-b-nand1'),
          edge(xor.id, lamp1.id, 0, 'e-xor-lp'),
          edge(nand.id, lamp2.id, 0, 'e-nand-lp'),
        ],
      });
    }
    case 'two-input': {
      const sw = makeNode('switch', 'sw-a', { x: 1, y: 2 }, { name: 'A 开关' });
      const plate = makeNode('plate', 'pl-1', { x: 2, y: 4 }, { name: '压力板' });
      const andGate = makeNode('gate', 'gt-and', { x: 5, y: 2 }, { name: 'AND 门', op: 'and' });
      const door = makeNode('door', 'dr-1', { x: 6, y: 4 }, { name: '门' });
      const lamp = makeNode('lamp', 'lp-1', { x: 8, y: 4 }, { name: '通行灯' });
      return makeLevel({
        name: '两输入步进',
        cols: 10,
        rows: 6,
        home: { x: 1, y: 4 },
        nodes: nodes([sw, plate, andGate, door, lamp]),
        edges: [
          edge(sw.id, andGate.id, 0, 'e-sw-and0'),
          edge(plate.id, andGate.id, 1, 'e-pl-and1'),
          edge(andGate.id, door.id, 0, 'e-and-door'),
          edge(andGate.id, lamp.id, 0, 'e-and-lamp'),
        ],
      });
    }
    case 'feedback-latch': {
      const sw = makeNode('switch', 'sw-a', { x: 1, y: 1 }, { name: '锁存 A' });
      const latch = makeNode('gate', 'gt-latch', { x: 4, y: 1 }, { name: 'OR 自锁', op: 'or' });
      const door = makeNode('door', 'dr-latch', { x: 7, y: 1 }, { name: '锁定门' });
      const swB = makeNode('switch', 'sw-b', { x: 1, y: 4 }, { name: '冲突 B' });
      const g1 = makeNode('gate', 'gt-conf-a', { x: 4, y: 4 }, { name: 'NAND 环 A', op: 'nand' });
      const g2 = makeNode('gate', 'gt-conf-b', { x: 7, y: 4 }, { name: '缓冲环 B', op: 'or' });
      const lampConf = makeNode('lamp', 'lp-conf', { x: 10, y: 4 }, { name: '冲突灯' });
      return makeLevel({
        name: '无延时反馈: 稳定自锁与冲突',
        cols: 12,
        rows: 6,
        home: { x: 0, y: 5 },
        nodes: nodes([sw, latch, door, swB, g1, g2, lampConf]),
        edges: [
          edge(sw.id, latch.id, 0, 'e-sw-latch0'),
          edge(latch.id, latch.id, 1, 'e-latch-self'),
          edge(latch.id, door.id, 0, 'e-latch-door'),
          edge(swB.id, g1.id, 0, 'e-swb-conf0'),
          edge(g2.id, g1.id, 1, 'e-conf-g2-g1'),
          edge(g1.id, g2.id, 0, 'e-conf-g1-g2a'),
          edge(g1.id, g2.id, 1, 'e-conf-g1-g2b'),
          edge(g1.id, lampConf.id, 0, 'e-conf-lamp'),
        ],
      });
    }
  }
}
