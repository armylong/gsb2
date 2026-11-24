import { DAY_TWO_CHANGES } from './scenario'
import type {
  CartEntry,
  GameState,
  ItemId,
  Offer,
  Quantities,
  SimulationResult,
  StepResult,
  TradeRecord,
} from './types'

// ---------- 数量表小工具 ----------

export function cloneQuantities(q: Quantities): Quantities {
  return { ...q }
}

export function getQty(q: Quantities, id: ItemId): number {
  return q[id] ?? 0
}

/** 持有量是否足以支付 cost（逐物品检查，不允许欠账） */
export function canAfford(holdings: Quantities, cost: Quantities): boolean {
  return (Object.entries(cost) as [ItemId, number][]).every(
    ([id, need]) => getQty(holdings, id) >= need,
  )
}

/** 说明缺什么，例如 “香草差 1 份”；够付时返回 undefined */
export function shortageDescription(holdings: Quantities, cost: Quantities): string | undefined {
  const missing: string[] = []
  for (const [id, need] of Object.entries(cost) as [ItemId, number][]) {
    const have = getQty(holdings, id)
    if (have < need) {
      missing.push(`${id} 差 ${need - have}`)
    }
  }
  return missing.length > 0 ? missing.join('，') : undefined
}

function applyCost(holdings: Quantities, cost: Quantities): Quantities {
  const next = cloneQuantities(holdings)
  for (const [id, n] of Object.entries(cost) as [ItemId, number][]) {
    next[id] = getQty(next, id) - n
    if ((next[id] ?? 0) <= 0) delete next[id]
  }
  return next
}

function applyGain(holdings: Quantities, gain: Quantities): Quantities {
  const next = cloneQuantities(holdings)
  for (const [id, n] of Object.entries(gain) as [ItemId, number][]) {
    next[id] = getQty(next, id) + n
  }
  return next
}

// ---------- 报价与额度 ----------

export function offerRemaining(offer: Offer, quotaUsed: Record<string, number>): number {
  return offer.dailyLimit - (quotaUsed[offer.id] ?? 0)
}

export function findOffer(state: GameState, offerId: string): Offer | undefined {
  return state.offers.find((o) => o.id === offerId)
}

/** 排队时的快照与当前报价是否一致；摊主改价或改限额都会让旧预览过时 */
export function isEntryStale(entry: CartEntry, current: Offer | undefined): boolean {
  if (!current) return true
  return current.version !== entry.offerSnapshot.version
}

export function cartStaleEntryIds(state: GameState): Set<string> {
  const ids = new Set<string>()
  for (const entry of state.cart) {
    if (isEntryStale(entry, findOffer(state, entry.offerId))) ids.add(entry.id)
  }
  return ids
}

// ---------- 预演（不修改真实状态） ----------

/**
 * 按排队顺序逐笔预演。
 * 套装（set）与散装（loose）都在这里做原子检查：
 * 任何一种材料不足或摊主额度用尽，这一步即失败，后续步骤不再执行。
 * 预演中的每一步都从同一个 projected 池子里扣料 / 加料，
 * 因此前一步暂放给 A 摊的材料不可能再出现在后一步的池子里 ——
 * 同一份材料天然无法同时算给两家。
 */
export function simulateCart(state: GameState): SimulationResult {
  const staleIds = cartStaleEntryIds(state)
  let working: Quantities = cloneQuantities(state.holdings)
  const quotaUsed: Record<string, number> = { ...state.quotaUsed }
  const steps: StepResult[] = []
  let ok = true
  let failedAt: string | undefined

  for (const entry of state.cart) {
    const current = findOffer(state, entry.offerId)
    const offer = current ?? entry.offerSnapshot
    const stall = state.stalls.find((s) => s.id === offer.stallId)

    const base: StepResult = {
      entryId: entry.id,
      offerId: offer.id,
      offerTitle: offer.title,
      stallId: offer.stallId,
      stallName: stall?.name ?? offer.stallId,
      kind: offer.kind,
      projected: cloneQuantities(working),
      quotaUsed: { ...quotaUsed },
      ok: false,
    }

    // 1) 报价已过时
    if (staleIds.has(entry.id)) {
      steps.push({ ...base, reason: '报价已过时：摊主改了价格或限额，请按今日报价重新排队' })
      ok = false
      failedAt = entry.id
      break
    }

    // 2) 摊主本日额度
    const remaining = offerRemaining(offer, quotaUsed)
    if (remaining <= 0) {
      steps.push({ ...base, reason: `摊主本日额度已用尽（限额 ${offer.dailyLimit} 次）` })
      ok = false
      failedAt = entry.id
      break
    }

    // 3) 套装原子性：整套材料必须一次凑齐，缺一样都不成交
    const shortage = shortageDescription(working, offer.inputs)
    if (shortage) {
      const prefix = offer.kind === 'set' ? '套装材料凑不齐（整锅才换，不拆零）：' : '材料不足：'
      steps.push({ ...base, reason: prefix + shortage })
      ok = false
      failedAt = entry.id
      break
    }

    // 4) 扣款、发货、占用一次额度
    working = applyGain(applyCost(working, offer.inputs), offer.outputs)
    quotaUsed[offer.id] = (quotaUsed[offer.id] ?? 0) + 1

    steps.push({
      ...base,
      projected: cloneQuantities(working),
      quotaUsed: { ...quotaUsed },
      ok: true,
    })
  }

  return { projected: working, quotaUsed, steps, ok, failedAt }
}

// ---------- 成交（原子提交整队） ----------

let idSeq = 0
function localId(prefix: string): string {
  idSeq += 1
  return `${prefix}-${Date.now().toString(36)}-${idSeq}`
}

/**
 * 确认整队换物：先完整预演，任一步失败则整体不成交、状态原样返回（连同失败原因）。
 * 全部通过才一次性提交 —— 套装交换一次完成，中途不存在 “付了一半” 的状态。
 */
export function commitCart(
  state: GameState,
): { state: GameState; result: SimulationResult; records: TradeRecord[] } {
  const result = simulateCart(state)
  if (!result.ok) {
    return { state, result, records: [] }
  }

  const records: TradeRecord[] = state.cart.map((entry) => {
    const offer = findOffer(state, entry.offerId) ?? entry.offerSnapshot
    const stall = state.stalls.find((s) => s.id === offer.stallId)
    return {
      id: localId('trade'),
      day: state.day,
      offerId: offer.id,
      offerTitle: offer.title,
      stallId: offer.stallId,
      stallName: stall?.name ?? offer.stallId,
      kind: offer.kind,
      // 历史记录冻结成交当时的输入 / 输出与版本
      inputs: { ...offer.inputs },
      outputs: { ...offer.outputs },
      version: offer.version,
    }
  })

  const next: GameState = {
    ...state,
    holdings: result.projected,
    quotaUsed: result.quotaUsed,
    cart: [],
    history: [...state.history, ...records],
  }
  return { state: next, result, records }
}

// ---------- 排队管理（只动购物车，不碰持有量与额度） ----------

export function addToCart(state: GameState, offerId: string, note?: string): GameState {
  const offer = findOffer(state, offerId)
  if (!offer) return state
  const entry: CartEntry = {
    id: localId('entry'),
    offerId,
    offerSnapshot: {
      ...offer,
      inputs: { ...offer.inputs },
      outputs: { ...offer.outputs },
    },
    note,
  }
  return { ...state, cart: [...state.cart, entry] }
}

export function removeFromCart(state: GameState, entryId: string): GameState {
  return { ...state, cart: state.cart.filter((e) => e.id !== entryId) }
}

export function clearCart(state: GameState): GameState {
  return { ...state, cart: [] }
}

/**
 * 取消排队：因为预演从未真正扣减持有量或占用摊主额度，
 * 移除排队条目后持有量与本日额度自然回到合适状态，无需回滚账本。
 */
export function cancelAll(state: GameState): GameState {
  return clearCart(state)
}

// ---------- 次日 ----------

/**
 * 进入次日：
 * - 套用 DAY_TWO_CHANGES，被改动的报价 version +1（旧排队条目随即显示过时）；
 * - 各摊位本日额度重置（quotaUsed 清零）；
 * - 持有量与成交历史保持不变，历史里保留成交当时的价格。
 */
export function advanceDay(state: GameState): GameState {
  const nextDay = state.day + 1
  const offers = state.offers.map((offer) => {
    const change = DAY_TWO_CHANGES[offer.id]
    if (!change) return offer
    return {
      ...offer,
      inputs: change.inputs ? { ...change.inputs } : { ...offer.inputs },
      outputs: change.outputs ? { ...change.outputs } : { ...offer.outputs },
      dailyLimit: change.dailyLimit ?? offer.dailyLimit,
      version: offer.version + 1,
    }
  })
  return {
    ...state,
    day: nextDay,
    offers,
    quotaUsed: {},
  }
}
