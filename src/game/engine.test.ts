import { describe, expect, it } from 'vitest'
import {
  AP_COST,
  buildOrder,
  buildRoundState,
  compareForQueue,
  simulateRound,
} from './engine'
import type { Character, Plan, RoundState } from './types'

function makeCharacter(overrides: Partial<Character> & Pick<Character, 'id' | 'side' | 'slot'>): Character {
  const maxHp = overrides.maxHp ?? 100
  const maxShield = overrides.maxShield ?? 0
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    role: overrides.role ?? '',
    side: overrides.side,
    slot: overrides.slot,
    maxHp,
    hp: overrides.hp ?? maxHp,
    atk: overrides.atk ?? 10,
    maxShield,
    shield: overrides.shield ?? 0,
    shieldGain: overrides.shieldGain ?? 10,
    speed: overrides.speed ?? 10,
    maxAp: overrides.maxAp ?? 3,
    ap: overrides.ap ?? overrides.maxAp ?? 3,
  }
}

function makeState(characters: Character[]): RoundState {
  return buildRoundState(1, characters)
}

describe('同速次序', () => {
  it('同速时我方先于敌方, 再按 slot, 结果稳定', () => {
    const characters = [
      makeCharacter({ id: 'e1', side: 'enemy', slot: 0, speed: 10 }),
      makeCharacter({ id: 'a2', side: 'ally', slot: 1, speed: 10 }),
      makeCharacter({ id: 'a1', side: 'ally', slot: 0, speed: 10 }),
      makeCharacter({ id: 'e2', side: 'enemy', slot: 1, speed: 10 }),
    ]
    const order = buildOrder(characters)
    expect(order).toEqual(['a1', 'a2', 'e1', 'e2'])
    // 输入顺序不同也得到相同结果
    expect(buildOrder([...characters].reverse())).toEqual(order)
  })

  it('速度优先于阵营', () => {
    const fastEnemy = makeCharacter({ id: 'e1', side: 'enemy', slot: 0, speed: 20 })
    const slowAlly = makeCharacter({ id: 'a1', side: 'ally', slot: 0, speed: 10 })
    expect(buildOrder([slowAlly, fastEnemy])).toEqual(['e1', 'a1'])
  })

  it('连 slot 也相同时用 id 兜底, 保证全序', () => {
    const a = makeCharacter({ id: 'z', side: 'ally', slot: 0 })
    const b = makeCharacter({ id: 'a', side: 'ally', slot: 0 })
    expect(compareForQueue(b, a)).toBeLessThan(0)
    expect(buildOrder([a, b])).toEqual(['a', 'z'])
  })

  it('阵亡角色不进入队列', () => {
    const dead = makeCharacter({ id: 'dead', side: 'ally', slot: 0, speed: 99, hp: 0 })
    const alive = makeCharacter({ id: 'alive', side: 'enemy', slot: 0, speed: 1 })
    expect(buildOrder([dead, alive])).toEqual(['alive'])
  })
})

describe('护盾抵伤', () => {
  it('先扣护盾再扣生命, 生命最低为 0 并记录溢出', () => {
    const ally = makeCharacter({ id: 'a1', side: 'ally', slot: 0, atk: 30, speed: 20 })
    const enemy = makeCharacter({
      id: 'e1',
      side: 'enemy',
      slot: 0,
      maxHp: 20,
      shield: 25,
      speed: 1,
    })
    const plan: Plan = { a1: { type: 'attack', targetId: 'e1' }, e1: null }
    const result = simulateRound(makeState([ally, enemy]), plan)
    const first = result.steps[0]!
    expect(first.shieldAbsorbed).toBe(25)
    expect(first.hpLost).toBe(5)
    expect(first.overkill).toBe(0)
    expect(first.targetAfter?.shield).toBe(0)
    expect(first.targetAfter?.hp).toBe(15)
  })

  it('溢出伤害单独标注, 生命不会为负', () => {
    const ally = makeCharacter({ id: 'a1', side: 'ally', slot: 0, atk: 50, speed: 20 })
    const enemy = makeCharacter({ id: 'e1', side: 'enemy', slot: 0, maxHp: 20, speed: 1 })
    const result = simulateRound(makeState([ally, enemy]), {
      a1: { type: 'attack', targetId: 'e1' },
    })
    const step = result.steps[0]!
    expect(step.hpLost).toBe(20)
    expect(step.overkill).toBe(30)
    expect(step.targetAfter?.hp).toBe(0)
    expect(step.targetAfter?.alive).toBe(false)
  })

  it('护盾指令不会超过护盾上限', () => {
    const ally = makeCharacter({
      id: 'a1',
      side: 'ally',
      slot: 0,
      maxShield: 30,
      shield: 25,
      shieldGain: 10,
      speed: 10,
    })
    const result = simulateRound(makeState([ally]), { a1: { type: 'shield', targetId: null } })
    const step = result.steps[0]!
    expect(step.shieldGained).toBe(5)
    expect(step.actorAfter.shield).toBe(30)
  })
})

describe('失效指令', () => {
  it('目标在轮到前阵亡: 跳过, 不自动改打, 不扣行动点', () => {
    const killer = makeCharacter({ id: 'a1', side: 'ally', slot: 0, speed: 30, atk: 100 })
    const archer = makeCharacter({ id: 'a2', side: 'ally', slot: 1, speed: 20, atk: 20, maxAp: 3 })
    const victim = makeCharacter({ id: 'e1', side: 'enemy', slot: 0, speed: 10, maxHp: 10 })
    const other = makeCharacter({ id: 'e2', side: 'enemy', slot: 1, speed: 5, maxHp: 100 })
    const state = makeState([killer, archer, victim, other])
    const result = simulateRound(state, {
      a1: { type: 'attack', targetId: 'e1' },
      a2: { type: 'attack', targetId: 'e1' },
    })
    const skipStep = result.steps.find((s) => s.actorId === 'a2')!
    expect(skipStep.kind).toBe('skip')
    expect(skipStep.reason).toContain('已阵亡')
    expect(skipStep.apCost).toBe(0)
    expect(skipStep.actorAfter.ap).toBe(skipStep.actorBefore.ap)
    expect(skipStep.hpLost).toBe(0)
    // 没有偷偷改打 e2
    expect(other.hp).toBe(100)
  })

  it('行动点不足时跳过且不扣行动点', () => {
    const ally = makeCharacter({ id: 'a1', side: 'ally', slot: 0, maxAp: 1, speed: 10 })
    const enemy = makeCharacter({ id: 'e1', side: 'enemy', slot: 0, speed: 1 })
    const result = simulateRound(makeState([ally, enemy]), {
      a1: { type: 'delay', targetId: 'e1' },
    })
    const step = result.steps[0]!
    expect(step.kind).toBe('skip')
    expect(step.reason).toContain('行动点不足')
    expect(step.apCost).toBe(0)
    expect(step.actorAfter.ap).toBe(1)
    // 队列不受影响
    expect(step.queueAfter).toEqual(['e1'])
  })

  it('未安排指令时待机, 不消耗行动点', () => {
    const ally = makeCharacter({ id: 'a1', side: 'ally', slot: 0, speed: 10 })
    const result = simulateRound(makeState([ally]), {})
    const step = result.steps[0]!
    expect(step.kind).toBe('idle')
    expect(step.apCost).toBe(0)
    expect(step.actorAfter.ap).toBe(3)
  })

  it('不能攻击队友, 不会误伤', () => {
    const a1 = makeCharacter({ id: 'a1', side: 'ally', slot: 0, speed: 20 })
    const a2 = makeCharacter({ id: 'a2', side: 'ally', slot: 1, speed: 1 })
    const result = simulateRound(makeState([a1, a2]), {
      a1: { type: 'attack', targetId: 'a2' },
    })
    const step = result.steps[0]!
    expect(step.kind).toBe('skip')
    expect(step.reason).toContain('不是敌方目标')
    expect(step.targetAfter?.hp).toBe(a2.hp)
  })

  it('行动者轮到自己前阵亡时跳过', () => {
    const killer = makeCharacter({ id: 'e1', side: 'enemy', slot: 0, speed: 30, atk: 100 })
    const victim = makeCharacter({ id: 'a1', side: 'ally', slot: 0, speed: 20, maxHp: 10, ap: 3 })
    const result = simulateRound(makeState([killer, victim]), {
      e1: { type: 'attack', targetId: 'a1' },
      a1: { type: 'attack', targetId: 'e1' },
    })
    const step = result.steps.find((s) => s.actorId === 'a1')!
    expect(step.kind).toBe('skip')
    expect(step.reason).toContain('已阵亡')
    expect(step.apCost).toBe(0)
  })

  it('攻击不存在的目标时跳过', () => {
    const ally = makeCharacter({ id: 'a1', side: 'ally', slot: 0 })
    const result = simulateRound(makeState([ally]), {
      a1: { type: 'attack', targetId: 'missing' },
    })
    expect(result.steps[0]!.kind).toBe('skip')
    expect(result.steps[0]!.reason).toContain('目标不存在')
  })
})

describe('队列变化', () => {
  it('推迟把尚未行动的目标移到队尾, 并记录前后下标', () => {
    const fast = makeCharacter({ id: 'a1', side: 'ally', slot: 0, speed: 30, maxAp: 3 })
    const mid = makeCharacter({ id: 'e1', side: 'enemy', slot: 0, speed: 20 })
    const last = makeCharacter({ id: 'e2', side: 'enemy', slot: 1, speed: 10 })
    const result = simulateRound(makeState([fast, mid, last]), {
      a1: { type: 'delay', targetId: 'e1' },
    })
    const step = result.steps[0]!
    expect(step.kind).toBe('act')
    expect(step.outcome).toBe('delay')
    expect(step.queueBefore).toEqual(['a1', 'e1', 'e2'])
    expect(step.queueAfter).toEqual(['e2', 'e1'])
    expect(step.queueMoved).toEqual({ id: 'e1', from: 0, to: 1 })
    expect(step.actorAfter.ap).toBe(3 - AP_COST.delay)
  })

  it('已行动过的角色不能被推迟, 也不会再次行动', () => {
    const first = makeCharacter({ id: 'a1', side: 'ally', slot: 0, speed: 30 })
    const delayer = makeCharacter({ id: 'a2', side: 'ally', slot: 1, speed: 20, maxAp: 3 })
    const enemy = makeCharacter({ id: 'e1', side: 'enemy', slot: 0, speed: 10 })
    const result = simulateRound(makeState([first, delayer, enemy]), {
      a1: { type: 'attack', targetId: 'e1' },
      a2: { type: 'delay', targetId: 'a1' },
    })
    const step = result.steps.find((s) => s.actorId === 'a2')!
    expect(step.kind).toBe('skip')
    expect(step.reason).toContain('已经行动过')
    // a1 在整回合中只行动一次
    const a1Steps = result.steps.filter((s) => s.actorId === 'a1')
    expect(a1Steps).toHaveLength(1)
    // e1 仍剩在队列中, 并且最终会行动
    expect(result.steps.filter((s) => s.actorId === 'e1')).toHaveLength(1)
  })

  it('推迟已在队尾的目标时队列不变, 但仍然消耗行动点', () => {
    const fast = makeCharacter({ id: 'a1', side: 'ally', slot: 0, speed: 30, maxAp: 3 })
    const last = makeCharacter({ id: 'e1', side: 'enemy', slot: 0, speed: 10 })
    const result = simulateRound(makeState([fast, last]), {
      a1: { type: 'delay', targetId: 'e1' },
    })
    const step = result.steps[0]!
    expect(step.outcome).toBe('delay')
    expect(step.queueMoved).toBeNull()
    expect(step.actorAfter.ap).toBe(1)
  })

  it('不能推迟自己', () => {
    const only = makeCharacter({ id: 'a1', side: 'ally', slot: 0, speed: 10 })
    const result = simulateRound(makeState([only]), {
      a1: { type: 'delay', targetId: 'a1' },
    })
    expect(result.steps[0]!.kind).toBe('skip')
    expect(result.steps[0]!.reason).toContain('不能推迟自己')
    expect(result.steps[0]!.actorAfter.ap).toBe(3)
  })
})

describe('不修改输入', () => {
  it('simulateRound 不修改传入的初始状态和方案', () => {
    const ally = makeCharacter({ id: 'a1', side: 'ally', slot: 0, speed: 20, atk: 15 })
    const enemy = makeCharacter({ id: 'e1', side: 'enemy', slot: 0, speed: 10, shield: 5 })
    const state = makeState([ally, enemy])
    const plan: Plan = { a1: { type: 'attack', targetId: 'e1' } }
    const stateSnapshot = JSON.parse(JSON.stringify(state))
    const planSnapshot = JSON.parse(JSON.stringify(plan))
    simulateRound(state, plan)
    expect(state).toEqual(stateSnapshot)
    expect(plan).toEqual(planSnapshot)
  })

  it('多次结算同一输入得到完全一致的结果 (确定性)', () => {
    const ally = makeCharacter({ id: 'a1', side: 'ally', slot: 0, speed: 20, atk: 15 })
    const enemy = makeCharacter({ id: 'e1', side: 'enemy', slot: 0, speed: 10, shield: 5 })
    const state = makeState([ally, enemy])
    const plan: Plan = {
      a1: { type: 'attack', targetId: 'e1' },
      e1: { type: 'shield', targetId: null },
    }
    const first = simulateRound(state, plan)
    const second = simulateRound(state, plan)
    expect(second).toEqual(first)
  })
})
