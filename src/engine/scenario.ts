import type { GameState, Offer, Quantities, Stall } from './types'

/** 本试验台指定的目标物：两笔连换路线要拿到的东西 */
export const TARGET_ITEM = 'map' as const

export const STALLS: Stall[] = [
  {
    id: 'herb-stall',
    name: '药草婆的摊子',
    keeper: '药草婆',
    blurb: '认纸券和香草，套装炼露一次成锅，不散卖半成品。',
  },
  {
    id: 'hunter-stall',
    name: '猎人铺子',
    keeper: '老猎人',
    blurb: '只收兽皮与纸券，藏宝图每日仅绘一张。',
  },
  {
    id: 'shell-stall',
    name: '贝壳匠摊位',
    keeper: '贝壳匠',
    blurb: '纸券换贝壳很划算，但护符套装要凑齐双份材料。',
  },
]

/** 第 1 日报价；version 从 1 开始，改价 / 改限额即 +1 */
export const INITIAL_OFFERS: Offer[] = [
  // 药草婆
  {
    id: 'herb-loose',
    stallId: 'herb-stall',
    title: '纸券换香草',
    kind: 'loose',
    inputs: { voucher: 1 },
    outputs: { herb: 1 },
    dailyLimit: 3,
    version: 1,
  },
  {
    id: 'potion-set',
    stallId: 'herb-stall',
    title: '炼露套装',
    kind: 'set',
    inputs: { herb: 2, voucher: 1 },
    outputs: { potion: 1 },
    dailyLimit: 1,
    version: 1,
  },
  // 猎人
  {
    id: 'rope-loose',
    stallId: 'hunter-stall',
    title: '兽皮搓绳',
    kind: 'loose',
    inputs: { hide: 2 },
    outputs: { rope: 1 },
    dailyLimit: 2,
    version: 1,
  },
  {
    id: 'map-set',
    stallId: 'hunter-stall',
    title: '藏宝图套装',
    kind: 'set',
    inputs: { rope: 1, voucher: 2 },
    outputs: { map: 1 },
    dailyLimit: 1,
    version: 1,
  },
  // 贝壳匠
  {
    id: 'shell-loose',
    stallId: 'shell-stall',
    title: '纸券换贝壳',
    kind: 'loose',
    inputs: { voucher: 1 },
    outputs: { shell: 2 },
    dailyLimit: 2,
    version: 1,
  },
  {
    id: 'charm-set',
    stallId: 'shell-stall',
    title: '护符套装',
    kind: 'set',
    inputs: { shell: 2, herb: 2 },
    outputs: { charm: 1 },
    dailyLimit: 1,
    version: 1,
  },
]

/**
 * 开局库存：纸券和材料都紧巴巴，不能随便买。
 * 香草只有 1 份 —— 这是失败路线里 “同一份材料不能算两次” 的关键。
 */
export const INITIAL_HOLDINGS: Quantities = {
  voucher: 4,
  herb: 1,
  hide: 2,
  shell: 0,
  potion: 0,
  rope: 0,
  map: 0,
  charm: 0,
}

/** 次日改价 / 改限额表：只列出发生变化的报价 */
export interface OfferChange {
  inputs?: Quantities
  outputs?: Quantities
  dailyLimit?: number
  note: string
}

export const DAY_TWO_CHANGES: Record<string, OfferChange> = {
  // 纸券贬值：换香草从 1 券涨到 2 券，额度 3 → 2
  'herb-loose': {
    inputs: { voucher: 2 },
    dailyLimit: 2,
    note: '纸券换香草涨价：1 券 → 2 券，每日 3 次 → 2 次',
  },
  // 藏宝图加收 1 张纸券
  'map-set': {
    inputs: { rope: 1, voucher: 3 },
    note: '藏宝图套装涨价：2 券 → 3 券',
  },
  // 贝壳限额收紧：2 次 → 1 次
  'shell-loose': {
    dailyLimit: 1,
    note: '纸券换贝壳限额：每日 2 次 → 1 次',
  },
}

/** 预设成功路线：两笔连着换，前一笔的绳子给后一笔用，拿到目标物藏宝图 */
export const SUCCESS_ROUTE = ['rope-loose', 'map-set'] as const

/**
 * 预设失败路线：贝壳看着便宜（1 券换 2 个），
 * 但护符套装要 2 份香草，开局只有 1 份且今日无处补货 —— 同一份材料不能重复计数。
 */
export const FAILURE_ROUTE = ['shell-loose', 'charm-set'] as const

export function createInitialState(): GameState {
  return {
    day: 1,
    holdings: { ...INITIAL_HOLDINGS },
    offers: INITIAL_OFFERS.map((o) => ({ ...o, inputs: { ...o.inputs }, outputs: { ...o.outputs } })),
    stalls: STALLS.map((s) => ({ ...s })),
    cart: [],
    history: [],
    quotaUsed: {},
  }
}
