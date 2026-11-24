import { createInitialState } from '../engine/scenario'
import {
  addToCart,
  advanceDay,
  cancelAll,
  clearCart,
  commitCart,
  removeFromCart,
} from '../engine/engine'
import type { GameState, SimulationResult, TradeRecord } from '../engine/types'

export type Action =
  | { type: 'ADD'; offerId: string }
  | { type: 'REMOVE'; entryId: string }
  | { type: 'CLEAR' }
  | { type: 'CANCEL' }
  | { type: 'COMMIT' }
  | { type: 'NEXT_DAY' }
  | { type: 'RESET' }
  | { type: 'LOAD_ROUTE'; offerIds: readonly string[] }

export interface CommitOutcome {
  result: SimulationResult
  records: TradeRecord[]
}

export interface AppState {
  game: GameState
  /** 最近一次确认的结果（成功或失败原因），用于顶部提示条 */
  lastCommit: CommitOutcome | null
  /** 最近一次操作的说明文字（如已载入路线、已进入次日） */
  notice: string | null
}

export function initAppState(): AppState {
  return { game: createInitialState(), lastCommit: null, notice: null }
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'ADD':
      return {
        ...state,
        game: addToCart(state.game, action.offerId),
        lastCommit: null,
        notice: null,
      }
    case 'REMOVE':
      return { ...state, game: removeFromCart(state.game, action.entryId), lastCommit: null }
    case 'CLEAR':
    case 'CANCEL':
      return { ...state, game: clearCart(state.game), lastCommit: null }
    case 'COMMIT': {
      const { state: nextGame, result, records } = commitCart(state.game)
      return {
        ...state,
        game: nextGame,
        lastCommit: { result, records },
        notice: null,
      }
    }
    case 'NEXT_DAY': {
      const next = advanceDay(state.game)
      return {
        ...state,
        game: next,
        lastCommit: null,
        notice: '已进入次日：部分摊位改了价或限额，旧排队条目已标记为过时',
      }
    }
    case 'LOAD_ROUTE': {
      let game = cancelAll(state.game)
      for (const offerId of action.offerIds) game = addToCart(game, offerId)
      return { ...state, game, lastCommit: null, notice: '已把预设路线排进队列，可逐笔核对预演' }
    }
    case 'RESET':
      return initAppState()
    default:
      return state
  }
}
