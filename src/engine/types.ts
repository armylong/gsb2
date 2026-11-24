// 旅行集市换物试验台的核心类型定义

/** 物品标识：纸券 + 摊主认可的材料 + 加工产物 */
export type ItemId =
  | 'voucher'
  | 'herb'
  | 'hide'
  | 'shell'
  | 'potion'
  | 'rope'
  | 'map'
  | 'charm'

/** 物品数量表，只记录数量大于 0 的物品 */
export type Quantities = Partial<Record<ItemId, number>>

/** 报价类型：套装必须一次整套完成，散装是普通交换 */
export type OfferKind = 'set' | 'loose'

/** 一个摊位的一笔报价（一个版本） */
export interface Offer {
  id: string
  stallId: string
  title: string
  kind: OfferKind
  /** 摊主收什么 */
  inputs: Quantities
  /** 摊主给什么 */
  outputs: Quantities
  /** 本日剩余次数（每日重置） */
  dailyLimit: number
  /** 报价版本：摊主改价 / 改限额后版本号 +1，旧预览随即过时 */
  version: number
}

export interface Stall {
  id: string
  name: string
  keeper: string
  blurb: string
}

/** 玩家排队中的一笔换物（仅记录意图，尚未成交） */
export interface CartEntry {
  id: string
  offerId: string
  /** 排队时冻结的报价快照，用于在摊主改价后判断预览是否过时 */
  offerSnapshot: Offer
  note?: string
}

/** 每一步预演的结果 */
export interface StepResult {
  entryId: string
  offerId: string
  offerTitle: string
  stallId: string
  stallName: string
  kind: OfferKind
  /** 走到这一步时（含本步）玩家手上的持有量 */
  projected: Quantities
  /** 走到这一步时（含本步）各摊位本日已占用额度 */
  quotaUsed: Record<string, number>
  ok: boolean
  reason?: string
}

export interface SimulationResult {
  /** 全部预演完成后的持有量；中途失败则停在失败前一步 */
  projected: Quantities
  quotaUsed: Record<string, number>
  steps: StepResult[]
  ok: boolean
  failedAt?: string
}

/** 成交历史，保留成交当时的价格快照 */
export interface TradeRecord {
  id: string
  day: number
  offerId: string
  offerTitle: string
  stallId: string
  stallName: string
  kind: OfferKind
  inputs: Quantities
  outputs: Quantities
  /** 成交当时的报价版本 */
  version: number
}

export interface GameState {
  day: number
  holdings: Quantities
  offers: Offer[]
  stalls: Stall[]
  cart: CartEntry[]
  history: TradeRecord[]
  /** 各摊位本日已用额度：{ [offerId]: 次数 } */
  quotaUsed: Record<string, number>
}
