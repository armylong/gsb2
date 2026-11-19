import { describe, expect, it } from 'vitest'
import { SCENARIOS, getScenario, scenarioPlan } from './scenarios'
import { buildRoundState, simulateRound } from './engine'
import { characterFromScenario } from './session'
import { compareRuns, firstDifferenceStep } from './compare'
import type { Plan } from './types'

function runScenario(id: string, plan?: Plan) {
  const scenario = getScenario(id)
  const state = buildRoundState(1, scenario.characters.map(characterFromScenario))
  const result = simulateRound(state, plan ?? scenarioPlan(scenario))
  return { scenario, state, result }
}

describe('内置样例', () => {
  it('每个样例恰好 3 对 3, 且初始方案都有内容', () => {
    for (const scenario of SCENARIOS) {
      expect(scenario.characters.filter((c) => c.side === 'ally')).toHaveLength(3)
      expect(scenario.characters.filter((c) => c.side === 'enemy')).toHaveLength(3)
      expect(Object.values(scenario.initialPlan).filter(Boolean).length).toBeGreaterThan(0)
    }
    expect(SCENARIOS).toHaveLength(3)
  })

  it('样例一能观察到护盾先抵伤', () => {
    const { result } = runScenario('shield')
    const withShield = result.steps.filter((s) => s.shieldAbsorbed > 0)
    expect(withShield.length).toBeGreaterThan(0)
    for (const step of withShield) {
      expect(step.hpLost + step.shieldAbsorbed).toBeGreaterThan(0)
    }
  })

  it('样例二能观察到目标提前阵亡后的跳过, 且不自动改打', () => {
    const { result } = runScenario('death')
    const deadTargetSkips = result.steps.filter(
      (s) => s.kind === 'skip' && (s.reason ?? '').includes('已阵亡'),
    )
    expect(deadTargetSkips.length).toBeGreaterThanOrEqual(1)
    // 被击倒的哨兵不会收到后续伤害
    const e1Steps = result.steps.filter((s) => s.targetId === 'e1' && s.hpLost > 0)
    expect(e1Steps).toHaveLength(1)
    expect(e1Steps[0]!.targetAfter!.hp).toBe(0)
  })

  it('样例三能观察到推迟成功、已行动目标被拒和行动点不足', () => {
    const { result } = runScenario('delay')
    const moved = result.steps.filter((s) => s.outcome === 'delay' && s.queueMoved)
    expect(moved.length).toBeGreaterThanOrEqual(1)
    const actedSkip = result.steps.find((s) => (s.reason ?? '').includes('已经行动过'))
    expect(actedSkip?.kind).toBe('skip')
    const apSkip = result.steps.find((s) => (s.reason ?? '').includes('行动点不足'))
    expect(apSkip?.kind).toBe('skip')
    expect(apSkip?.apCost).toBe(0)
    // 每个角色每回合只行动一次
    const actorCounts = new Map<string, number>()
    for (const step of result.steps) {
      actorCounts.set(step.actorId, (actorCounts.get(step.actorId) ?? 0) + 1)
    }
    for (const count of actorCounts.values()) expect(count).toBe(1)
  })

  it('样例中包含同速角色, 用来说明同速次序', () => {
    const { state, result } = runScenario('delay')
    const speeds = state.characters.map((c) => c.speed)
    expect(new Set(speeds).size).toBeLessThan(speeds.length)
    // 卫兵与我方同速先于盾卫
    const order = result.steps.map((s) => s.actorId)
    expect(order.indexOf('a2')).toBeLessThan(order.indexOf('e2'))
  })
})

describe('样例的预览与实战', () => {
  it('所有样例的预览与同方案结算逐步一致', () => {
    for (const scenario of SCENARIOS) {
      const { state, result } = runScenario(scenario.id)
      const actual = simulateRound(state, scenarioPlan(scenario))
      const comparison = compareRuns(result, actual, state)
      expect(comparison.differingSteps).toBe(0)
      expect(comparison.finalSame).toBe(true)
      expect(firstDifferenceStep(comparison)).toBeNull()
    }
  })

  it('改动一个角色的方案后, 差异能被定位到具体一步', () => {
    const { state, result } = runScenario('shield')
    const changedPlan: Plan = { ...scenarioPlan(getScenario('shield')), a2: { type: 'shield', targetId: null } }
    const changed = simulateRound(state, changedPlan)
    const comparison = compareRuns(result, changed, state)
    expect(comparison.differingSteps).toBeGreaterThan(0)
    const first = firstDifferenceStep(comparison)
    expect(first).toBe(2) // 游侠是第 2 位行动者
    const fieldNames = comparison.diffs.filter((d) => d.index === first).map((d) => d.field)
    expect(fieldNames.length).toBeGreaterThan(0)
    expect(comparison.finalSame).toBe(false)
  })
})
