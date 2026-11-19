import type { TargetConfig, TimelineEvent } from './engine/types';
import { sortSchedule } from './engine/simulator';

export interface Scenario {
  id: string;
  name: string;
  summary: string;
  /** 这个例子要展示的结算点。 */
  focus: string[];
  target: TargetConfig;
  events: TimelineEvent[];
}

let counter = 0;
export function nextEventId(prefix = 'evt'): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

type EventInput = TimelineEvent extends infer T ? (T extends TimelineEvent ? Omit<T, 'id' | 'order'> : never) : never;

function ev(partial: EventInput & { id?: string; order?: number }): TimelineEvent {
  return {
    id: partial.id ?? nextEventId(),
    order: partial.order ?? 0,
    ...partial,
  } as TimelineEvent;
}

/** 规范化：按 (time, order) 排序后重新编号，保证同刻次序稳定且可读。 */
export function normalizeEvents(events: TimelineEvent[]): TimelineEvent[] {
  return sortSchedule(events);
}

const refreshScenario: Scenario = {
  id: 'refresh-near-tick',
  name: '重施临近触发点',
  summary:
    '毒雾每 1000ms 跳一次，在 1800ms 重施，2000ms 的跳点照常发生；刷新后到期 5000ms 正好与下一跳同刻，因此 5000ms 的跳被跳过。烈焰在 4500ms 被单独驱散，毒雾不受影响。',
  focus: ['到期边界', '刷新节奏', '来源隔离'],
  target: { maxHp: 1000, baseAttack: 100, initialShield: 0 },
  events: normalizeEvents([
    ev({
      id: 'r-apply-1',
      time: 1000,
      order: 0,
      kind: 'apply',
      effectKind: 'periodicDamage',
      source: '毒雾',
      intervalMs: 1000,
      durationMs: 4000,
      tickDamage: 50,
      label: '施加毒雾（到期 5000ms）',
    }),
    ev({
      id: 'r-refresh-1',
      time: 1800,
      order: 1,
      kind: 'apply',
      effectKind: 'periodicDamage',
      source: '毒雾',
      intervalMs: 1000,
      durationMs: 3200,
      tickDamage: 50,
      label: '重施（刷新到期至 5000ms，与下一跳同刻）',
    }),
    ev({
      id: 'r-apply-2',
      time: 3000,
      order: 2,
      kind: 'apply',
      effectKind: 'periodicDamage',
      source: '烈焰',
      intervalMs: 1000,
      durationMs: 3000,
      tickDamage: 30,
      label: '施加烈焰（另一来源）',
    }),
    ev({
      id: 'r-dispel-other',
      time: 3200,
      order: 3,
      kind: 'dispel',
      effectKind: 'periodicDamage',
      source: '冰霜',
      label: '驱散不存在的来源（应跳过）',
    }),
    ev({
      id: 'r-dispel-fire',
      time: 4500,
      order: 4,
      kind: 'dispel',
      effectKind: 'periodicDamage',
      source: '烈焰',
      label: '驱散烈焰（只移除该来源，毒雾保留）',
    }),
  ]),
};

const stackScenario: Scenario = {
  id: 'stack-expiry',
  name: '叠层分别到期',
  summary: '战歌在 0/1000/1500ms 各叠一层，三层分别在 2000/3000/3500ms 到期；号角在 1600ms 被单独驱散。',
  focus: ['叠层独立到期', '属性恢复', '来源隔离'],
  target: { maxHp: 1000, baseAttack: 100, initialShield: 0 },
  events: normalizeEvents([
    ev({
      id: 's-buff-a',
      time: 0,
      order: 0,
      kind: 'apply',
      effectKind: 'attackBuff',
      source: '战歌',
      attackFlat: 10,
      attackPct: 10,
      durationMs: 2000,
      label: '战歌第 1 层',
    }),
    ev({
      id: 's-buff-b',
      time: 200,
      order: 1,
      kind: 'apply',
      effectKind: 'attackBuff',
      source: '号角',
      attackFlat: 20,
      attackPct: 0,
      durationMs: 3000,
      label: '号角（另一来源）',
    }),
    ev({
      id: 's-buff-a2',
      time: 1000,
      order: 2,
      kind: 'apply',
      effectKind: 'attackBuff',
      source: '战歌',
      attackFlat: 10,
      attackPct: 10,
      durationMs: 2000,
      label: '战歌第 2 层',
    }),
    ev({
      id: 's-buff-a3',
      time: 1500,
      order: 3,
      kind: 'apply',
      effectKind: 'attackBuff',
      source: '战歌',
      attackFlat: 10,
      attackPct: 10,
      durationMs: 2000,
      label: '战歌第 3 层',
    }),
    ev({
      id: 's-dispel-b',
      time: 1600,
      order: 4,
      kind: 'dispel',
      effectKind: 'attackBuff',
      source: '号角',
      label: '驱散号角（只移除该来源）',
    }),
    ev({
      id: 's-hit',
      time: 1700,
      order: 5,
      kind: 'damage',
      amount: 100,
      label: '普通伤害 100',
    }),
  ]),
};

const shieldScenario: Scenario = {
  id: 'shield-depletion',
  name: '护盾耗尽',
  summary: '盾A/盾B依次吸收并耗尽；盾C到期时移除剩余 30 点吸收量但不扣血；盾D、盾E同刻到期，按施加次序判断吸收先后。',
  focus: ['吸收顺序', '护盾到期不算生命损失', '同刻次序'],
  target: { maxHp: 1000, baseAttack: 100, initialShield: 0 },
  events: normalizeEvents([
    ev({
      id: 'c-shield-a',
      time: 1000,
      order: 0,
      kind: 'apply',
      effectKind: 'shield',
      source: '盾A',
      absorb: 100,
      durationMs: 3000,
      label: '盾A（100，到期 4000）',
    }),
    ev({
      id: 'c-shield-b',
      time: 1500,
      order: 1,
      kind: 'apply',
      effectKind: 'shield',
      source: '盾B',
      absorb: 80,
      durationMs: 6000,
      label: '盾B（80，到期 7500）',
    }),
    ev({
      id: 'c-hit-1',
      time: 2000,
      order: 2,
      kind: 'damage',
      amount: 150,
      label: '伤害 150：耗尽盾A，盾B吸收 50',
    }),
    ev({
      id: 'c-hit-2',
      time: 2500,
      order: 3,
      kind: 'damage',
      amount: 60,
      label: '伤害 60：盾B余 30，剩余 30 扣血',
    }),
    ev({
      id: 'c-shield-c',
      time: 5000,
      order: 4,
      kind: 'apply',
      effectKind: 'shield',
      source: '盾C',
      absorb: 50,
      durationMs: 1000,
      label: '盾C（50，到期 6000）',
    }),
    ev({
      id: 'c-hit-3',
      time: 5500,
      order: 5,
      kind: 'damage',
      amount: 20,
      label: '伤害 20：盾C吸收，剩 30',
    }),
    ev({
      id: 'c-shield-d',
      time: 7000,
      order: 6,
      kind: 'apply',
      effectKind: 'shield',
      source: '盾D',
      absorb: 40,
      durationMs: 2000,
      label: '盾D（40，到期 9000）',
    }),
    ev({
      id: 'c-shield-e',
      time: 8000,
      order: 7,
      kind: 'apply',
      effectKind: 'shield',
      source: '盾E',
      absorb: 20,
      durationMs: 1000,
      label: '盾E（20，到期 9000，晚于D施加）',
    }),
    ev({
      id: 'c-hit-4',
      time: 8500,
      order: 8,
      kind: 'damage',
      amount: 50,
      label: '伤害 50：先耗尽盾D，再吸收盾E 10',
    }),
  ]),
};

const mixedScenario: Scenario = {
  id: 'mixed',
  name: '综合演示',
  summary:
    '攻击叠层、周期伤害、多护盾、驱散与普通伤害混合；初始护盾 50。毒雾在 2500ms 刷新后到期 6000ms，正好与下一跳同刻，可观察到期边界跳过与护盾到期移除。',
  focus: ['同时刻结算顺序', '到期边界', '护盾到期不扣血'],
  target: { maxHp: 1000, baseAttack: 100, initialShield: 50 },
  events: normalizeEvents([
    ev({
      id: 'm-buff-1',
      time: 0,
      order: 0,
      kind: 'apply',
      effectKind: 'attackBuff',
      source: '战歌',
      attackFlat: 10,
      attackPct: 10,
      durationMs: 4000,
      label: '战歌第 1 层',
    }),
    ev({
      id: 'm-dot-1',
      time: 0,
      order: 1,
      kind: 'apply',
      effectKind: 'periodicDamage',
      source: '毒雾',
      intervalMs: 1000,
      durationMs: 4000,
      tickDamage: 40,
      label: '毒雾（每 1000ms 一跳）',
    }),
    ev({
      id: 'm-buff-2',
      time: 1000,
      order: 2,
      kind: 'apply',
      effectKind: 'attackBuff',
      source: '战歌',
      attackFlat: 10,
      attackPct: 10,
      durationMs: 4000,
      label: '战歌第 2 层',
    }),
    ev({
      id: 'm-hit-1',
      time: 1500,
      order: 3,
      kind: 'damage',
      amount: 120,
      label: '伤害 120：初始护盾吸收 50',
    }),
    ev({
      id: 'm-shield-1',
      time: 2000,
      order: 4,
      kind: 'apply',
      effectKind: 'shield',
      source: '护心',
      absorb: 200,
      durationMs: 4000,
      label: '护心（200，到期 6000）',
    }),
    ev({
      id: 'm-dot-refresh',
      time: 2500,
      order: 5,
      kind: 'apply',
      effectKind: 'periodicDamage',
      source: '毒雾',
      intervalMs: 1000,
      durationMs: 3500,
      tickDamage: 40,
      label: '重施毒雾（刷新到期至 6000，与下一跳同刻）',
    }),
    ev({
      id: 'm-dispel-buff',
      time: 3000,
      order: 6,
      kind: 'dispel',
      effectKind: 'attackBuff',
      source: '战歌',
      label: '驱散战歌',
    }),
    ev({
      id: 'm-hit-2',
      time: 4500,
      order: 7,
      kind: 'damage',
      amount: 300,
      label: '伤害 300：耗尽护心 200，余 100 扣血',
    }),
    ev({
      id: 'm-shield-2',
      time: 7000,
      order: 8,
      kind: 'apply',
      effectKind: 'shield',
      source: '余烬',
      absorb: 100,
      durationMs: 1000,
      label: '余烬（100，到期 8000，未受伤）',
    }),
    ev({
      id: 'm-buff-3',
      time: 9000,
      order: 9,
      kind: 'apply',
      effectKind: 'attackBuff',
      source: '战歌',
      attackFlat: 10,
      attackPct: 10,
      durationMs: 5000,
      label: '战歌重新施加',
    }),
  ]),
};

export const SCENARIOS: Scenario[] = [
  mixedScenario,
  refreshScenario,
  stackScenario,
  shieldScenario,
];

export const DEFAULT_SCENARIO_ID = mixedScenario.id;

export function getScenario(id: string): Scenario {
  return SCENARIOS.find((s) => s.id === id) ?? mixedScenario;
}
