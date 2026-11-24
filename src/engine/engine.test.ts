import { describe, expect, it } from 'vitest'
import {
  addToCart,
  advanceDay,
  canAfford,
  cancelAll,
  cartStaleEntryIds,
  clearCart,
  commitCart,
  findOffer,
  offerRemaining,
  removeFromCart,
  simulateCart,
} from './engine'
import {
  createInitialState,
  FAILURE_ROUTE,
  INITIAL_HOLDINGS,
  SUCCESS_ROUTE,
  TARGET_ITEM,
} from './scenario'
import type { GameState } from './types'

function queueRoute(state: GameState, route: readonly string[]): GameState {
  return route.reduce((s, offerId) => addToCart(s, offerId), state)
}

describe('开局库存与摊位', () => {
  it('三家摊位都有报价，且每笔报价带本日限额', () => {
    const s = createInitialState()
    expect(s.stalls).toHaveLength(3)
    expect(s.offers.length).toBeGreaterThanOrEqual(6)
    for (const offer of s.offers) {
      expect(offer.dailyLimit).toBeGreaterThan(0)
      expect(offerRemaining(offer, s.quotaUsed)).toBe(offer.dailyLimit)
      expect(Object.keys(offer.inputs).length).toBeGreaterThan(0)
      expect(Object.keys(offer.outputs).length).toBeGreaterThan(0)
    }
  })

  it('开局库存紧巴巴：纸券 4 张、香草仅 1 份', () => {
    const s = createInitialState()
    expect(s.holdings.voucher).toBe(INITIAL_HOLDINGS.voucher)
    expect(s.holdings.herb).toBe(1)
  })
})

describe('预演：前一笔产物给后一笔用', () => {
  it('成功路线两笔连换拿到目标物藏宝图', () => {
    const s = queueRoute(createInitialState(), SUCCESS_ROUTE)
    const result = simulateCart(s)

    expect(result.ok).toBe(true)
    expect(result.steps).toHaveLength(2)
    // 第一步产出的绳子进入预演池子
    expect(result.steps[0].projected.rope).toBe(1)
    expect(result.steps[0].projected.hide).toBeUndefined()
    // 第二步把绳子用掉，拿到目标物
    expect(result.steps[1].projected.rope).toBeUndefined()
    expect(result.projected[TARGET_ITEM]).toBe(1)
  })

  it('失败路线在第二步指出香草不足，且已换的贝壳保留在预演结果里', () => {
    const s = queueRoute(createInitialState(), FAILURE_ROUTE)
    const result = simulateCart(s)

    expect(result.ok).toBe(false)
    expect(result.failedAt).toBe(s.cart[1].id)
    const failed = result.steps.find((step) => !step.ok)
    expect(failed?.reason).toContain('herb 差 1')
    expect(failed?.reason).toContain('套装')
    // 第一步成功：贝壳已入袋；失败发生在第二步
    expect(result.projected.shell).toBe(2)
    expect(result.projected.charm ?? 0).toBe(0)
  })
})

describe('套装原子性与暂放物品不可重复计数', () => {
  it('同一份材料不能同时算给两家：护符套装不会把别处的香草重复计算', () => {
    // 再加一笔炼露套装排队：它和护符套装都要香草，而全局只有 1 份
    let s = queueRoute(createInitialState(), FAILURE_ROUTE)
    s = addToCart(s, 'potion-set')
    const result = simulateCart(s)

    expect(result.ok).toBe(false)
    // 失败点仍是护符套装（第二步），炼露套装根本轮不到执行
    expect(result.failedAt).toBe(s.cart[1].id)
  })

  it('套装缺任意一种材料即整体不成交，不会只扣部分材料', () => {
    let s = createInitialState()
    s = addToCart(s, 'charm-set')
    const before = { ...s.holdings }
    const result = simulateCart(s)

    expect(result.ok).toBe(false)
    expect(result.steps[0].reason).toContain('shell 差 2')
    // 预演不改真实状态
    expect(s.holdings).toEqual(before)
  })

  it('确认时任一步失败则整队不成交，持有量与额度原样不动', () => {
    const s = queueRoute(createInitialState(), FAILURE_ROUTE)
    const snapshot = { ...s.holdings }
    const { state: next, records } = commitCart(s)

    expect(records).toHaveLength(0)
    expect(next.holdings).toEqual(snapshot)
    expect(next.quotaUsed).toEqual({})
    // 购物车保留，方便玩家改单
    expect(next.cart).toHaveLength(2)
  })

  it('整队确认成功后一次性提交，历史冻结成交当时价格', () => {
    const s = queueRoute(createInitialState(), SUCCESS_ROUTE)
    const { state: next, records, result } = commitCart(s)

    expect(result.ok).toBe(true)
    expect(records).toHaveLength(2)
    expect(next.cart).toHaveLength(0)
    expect(next.holdings[TARGET_ITEM]).toBe(1)
    // 两笔报价各占用 1 次额度
    expect(next.quotaUsed['rope-loose']).toBe(1)
    expect(next.quotaUsed['map-set']).toBe(1)
    // 历史记录里的价格是成交当时的快照
    const mapTrade = records.find((r) => r.offerId === 'map-set')
    expect(mapTrade?.inputs).toEqual({ rope: 1, voucher: 2 })
    expect(mapTrade?.version).toBe(1)
  })
})

describe('额度限制', () => {
  it('同一报价超过本日限额会在超限那一步失败', () => {
    let s = createInitialState()
    // 纸券换贝壳每日限 2 次，库存够 4 张券，排 3 笔
    s = addToCart(addToCart(addToCart(s, 'shell-loose'), 'shell-loose'), 'shell-loose')
    const result = simulateCart(s)

    expect(result.ok).toBe(false)
    expect(result.steps).toHaveLength(3)
    expect(result.steps[2].ok).toBe(false)
    expect(result.steps[2].reason).toContain('额度已用尽')
  })
})

describe('取消与回滚', () => {
  it('移除排队条目 / 全部取消都不碰持有量和摊主额度', () => {
    let s = queueRoute(createInitialState(), SUCCESS_ROUTE)
    const before = { ...s.holdings }
    s = removeFromCart(s, s.cart[0].id)
    expect(s.holdings).toEqual(before)
    expect(s.quotaUsed).toEqual({})

    s = queueRoute(s, SUCCESS_ROUTE)
    s = cancelAll(s)
    expect(s.cart).toHaveLength(0)
    expect(s.holdings).toEqual(before)
    expect(s.quotaUsed).toEqual({})
  })

  it('成交后再取消空队列也不会影响已成交结果', () => {
    const s = queueRoute(createInitialState(), SUCCESS_ROUTE)
    const { state: committed } = commitCart(s)
    const cleared = clearCart(committed)
    expect(cleared.holdings[TARGET_ITEM]).toBe(1)
    expect(cleared.history).toHaveLength(2)
  })
})

describe('次日改价与过时预览', () => {
  it('次日套用新报价、限额重置，未改动的报价版本不变', () => {
    const s = queueRoute(createInitialState(), SUCCESS_ROUTE)
    const { state: committed } = commitCart(s)
    const next = advanceDay(committed)

    expect(next.day).toBe(2)
    // 额度重置
    expect(next.quotaUsed).toEqual({})
    // 藏宝图涨价：2 券 → 3 券，版本 +1
    const mapOffer = findOffer(next, 'map-set')!
    expect(mapOffer.inputs.voucher).toBe(3)
    expect(mapOffer.version).toBe(2)
    // 未改动的报价保持版本 1
    expect(findOffer(next, 'rope-loose')!.version).toBe(1)
    // 贝壳限额 2 → 1
    expect(findOffer(next, 'shell-loose')!.dailyLimit).toBe(1)
    // 持有量与历史跨日保留
    expect(next.holdings[TARGET_ITEM]).toBe(1)
    expect(next.history[0].day).toBe(1)
  })

  it('跨日残留的排队条目被标记过时，预演直接拦截并要求重新排队', () => {
    let s = createInitialState()
    s = addToCart(s, 'herb-loose')
    s = advanceDay(s)

    const staleIds = cartStaleEntryIds(s)
    expect(staleIds.size).toBe(1)

    const result = simulateCart(s)
    expect(result.ok).toBe(false)
    expect(result.steps[0].reason).toContain('过时')
  })

  it('历史记录保留旧价格，不受次日涨价影响', () => {
    const s = queueRoute(createInitialState(), SUCCESS_ROUTE)
    const { state: committed } = commitCart(s)
    const next = advanceDay(committed)

    const mapTrade = next.history.find((r) => r.offerId === 'map-set')
    expect(mapTrade?.inputs.voucher).toBe(2)
    expect(mapTrade?.version).toBe(1)
    // 今日报价已经是 3 券
    expect(findOffer(next, 'map-set')!.inputs.voucher).toBe(3)
  })
})

describe('数量表工具', () => {
  it('canAfford 逐物品检查，缺任意一种即不够付', () => {
    expect(canAfford({ voucher: 2, herb: 1 }, { voucher: 2, herb: 1 })).toBe(true)
    expect(canAfford({ voucher: 2 }, { voucher: 2, herb: 1 })).toBe(false)
    expect(canAfford({ voucher: 1 }, { voucher: 2 })).toBe(false)
  })
})
