import { describe, expect, it } from 'vitest'
import {
  advanceRound,
  createSession,
  executeRound,
  hasFreshPreview,
  makePreview,
  replayStateAt,
  resetSession,
  setCommand,
} from './session'
import { SCENARIOS, getScenario, scenarioPlan } from './scenarios'
import { compareRuns, firstDifferenceStep } from './compare'
import { simulateRound } from './engine'
import type { GameSession, Plan } from './types'

function sessionWithPreview(scenarioId = 'shield'): GameSession {
  return makePreview(createSession(scenarioId))
}

function snapshot(session: GameSession): string {
  return JSON.stringify({ state: session.state, plan: session.plan })
}

describe('预览不修改战场', () => {
  it('生成预览不改变真实场景、方案或行动点', () => {
    for (const scenario of SCENARIOS) {
      const base = createSession(scenario.id)
      const before = snapshot(base)
      const previewed = makePreview(base)
      expect(snapshot(base)).toBe(before)
      expect(previewed.preview).toBeTruthy()
      expect(previewed.preview!.result.steps.length).toBeGreaterThan(0)
      // 真实战场仍是回合初始状态
      expect(previewed.state).toEqual(base.state)
      for (const c of previewed.state.characters) {
        expect(c.ap).toBe(c.maxAp)
      }
    }
  })

  it('连续预览多个方案后, 执行的是最后确认的那一份', () => {
    let session = createSession('shield')
    const ally = session.state.characters.find((c) => c.side === 'ally')!
    const enemy = session.state.characters.find((c) => c.side === 'enemy' && c.id !== 'e1')!

    // 方案 A: 默认方案, 先预览
    session = makePreview(session)
    const planA = JSON.stringify(session.preview!.plan)

    // 方案 B: 改目标, 预览
    session = setCommand(session, ally.id, { type: 'attack', targetId: enemy.id })
    session = makePreview(session)
    const planB = JSON.stringify(session.preview!.plan)
    expect(planB).not.toBe(planA)

    // 方案 C: 改成护盾, 预览
    session = setCommand(session, ally.id, { type: 'shield', targetId: null })
    session = makePreview(session)
    const planC = JSON.stringify(session.preview!.plan)
    expect(planC).not.toBe(planB)

    const executed = executeRound(session)
    const record = executed.records[0]!
    expect(JSON.stringify(record.plan)).toBe(planC)
    // 真实结算与该份预览逐步一致
    expect(record.steps).toEqual(record.preview.steps)
    // 预览历史被保存在记录中
    expect(record.previewHistory.length).toBe(3)
  })

  it('修改方案会让旧预览失效, 不能执行过期的预览', () => {
    let session = sessionWithPreview('shield')
    expect(hasFreshPreview(session)).toBe(true)
    const target = session.state.characters.find((c) => c.id === 'a1')!
    session = setCommand(session, target.id, { type: 'shield', targetId: null })
    expect(session.preview).toBeNull()
    expect(hasFreshPreview(session)).toBe(false)
    const unchanged = executeRound(session)
    expect(unchanged.phase).toBe('planning')
    expect(unchanged.records).toHaveLength(0)
  })
})

describe('撤回与修改', () => {
  it('未确认的指令可以修改与撤回', () => {
    let session = createSession('delay')
    const actor = 'a1'
    session = setCommand(session, actor, { type: 'attack', targetId: 'e1' })
    expect(session.plan[actor]).toEqual({ type: 'attack', targetId: 'e1' })
    session = setCommand(session, actor, { type: 'shield', targetId: null })
    expect(session.plan[actor]).toEqual({ type: 'shield', targetId: null })
    session = setCommand(session, actor, null)
    expect(session.plan[actor]).toBeNull()
  })

  it('执行后不能修改本回合方案', () => {
    const session = executeRound(sessionWithPreview('shield'))
    expect(session.phase).toBe('finished')
    const modified = setCommand(session, 'a1', { type: 'shield', targetId: null })
    expect(modified.plan).toBe(session.plan)
  })
})

describe('执行与回放', () => {
  it('执行用真实结算更新场景, 并与预览逐步一致', () => {
    const session = executeRound(sessionWithPreview('shield'))
    const record = session.records[0]!
    const comparison = compareRuns(record.preview, { steps: record.steps, finalState: record.finalState }, record.initial)
    expect(comparison.differingSteps).toBe(0)
    expect(comparison.finalSame).toBe(true)
    expect(firstDifferenceStep(comparison)).toBeNull()
    expect(session.state).toEqual(record.finalState)
  })

  it('反复前后拖动回放不会重复扣血或再次触发推迟', () => {
    const session = executeRound(sessionWithPreview('delay'))
    const record = session.records[0]!
    const finalSnapshot = JSON.stringify(record.finalState)

    const sample: string[] = []
    const indices = [-5, 0, 1, 2, 3, 2, 1, 0, 5, 3, 999, 0, 4, 2, 0]
    for (const index of indices) {
      sample.push(JSON.stringify(replayStateAt(record, index)))
    }
    // 回放终态与真实终态一致
    expect(JSON.stringify(replayStateAt(record, record.steps.length))).toBe(finalSnapshot)
    // 同一个步号每次得到相同状态 (无副作用); 超界步号夹到终态
    const atTwo = JSON.stringify(replayStateAt(record, 2))
    expect(sample[3]).toBe(atTwo)
    expect(sample[13]).toBe(atTwo)
    expect(sample[10]).toBe(JSON.stringify(record.finalState))
    expect(sample[1]).toBe(JSON.stringify(record.initial))
    // 记录本身未被修改
    expect(JSON.stringify(record.finalState)).toBe(finalSnapshot)
    // 队列与行动点不因回放推进
    const last = replayStateAt(record, record.steps.length)
    for (const c of last.characters) {
      const source = record.finalState.characters.find((x) => x.id === c.id)!
      expect(c.ap).toBe(source.ap)
    }
  })

  it('按记录 id 回放, 不改动会话本身', () => {
    let session = executeRound(sessionWithPreview('shield'))
    const record = session.records[0]!
    const snapshotBefore = JSON.stringify(session)
    const view = replayStateAt(record, 2)
    expect(view.pending).toEqual(record.steps[1]!.queueAfter)
    expect(replayStateAt(record, 0)).toEqual(record.initial)
    expect(JSON.stringify(session)).toBe(snapshotBefore)
  })

  it('旧回放仍对应原来的初始状态, 推进回合不会污染历史', () => {
    let session = executeRound(sessionWithPreview('death'))
    const firstRecord = session.records[0]!
    const initialBefore = JSON.stringify(firstRecord.initial)
    const finalBefore = JSON.stringify(firstRecord.finalState)

    session = advanceRound(session)
    expect(session.round).toBe(2)
    expect(session.phase).toBe('planning')
    expect(JSON.stringify(firstRecord.initial)).toBe(initialBefore)
    expect(JSON.stringify(firstRecord.finalState)).toBe(finalBefore)

    // 第二回合执行后, 第一回合回放仍然可读且结果不变
    session = makePreview(session)
    session = executeRound(session)
    expect(session.records).toHaveLength(2)
    const replay = replayStateAt(firstRecord, firstRecord.steps.length)
    expect(JSON.stringify(replay)).toBe(finalBefore)
  })

  it('重置样例会丢弃记录并回到初始状态', () => {
    let session = executeRound(sessionWithPreview('shield'))
    session = advanceRound(session)
    const reset = resetSession(session)
    expect(reset.records).toHaveLength(0)
    expect(reset.round).toBe(1)
    expect(reset.state).toEqual(createSession('shield').state)
  })
})

describe('预览与实战差异定位', () => {
  it('用不同方案模拟的预览能定位到第一处差异步', () => {
    const session = createSession('shield')
    const planA: Plan = scenarioPlan(getScenario('shield'))
    const previewA = simulateRound(session.state, planA)

    // 只改一个角色的指令, 构造"预览与执行方案不同"的情形
    const planB: Plan = { ...planA, a1: { type: 'shield', targetId: null } }
    const actualB = simulateRound(session.state, planB)

    const comparison = compareRuns(previewA, actualB, session.state)
    expect(comparison.differingSteps).toBeGreaterThan(0)
    expect(comparison.rows.some((r) => !r.same)).toBe(true)
    const first = firstDifferenceStep(comparison)
    expect(first).not.toBeNull()
    // 第一处差异应该指向 a1 的行动步 (速度为 12, 队列第 3 位, 但已行动/生命等字段后续同步变化)
    const diff = comparison.diffs.find((d) => d.index === first)!
    expect(diff.preview).not.toBe(diff.actual)
    expect(comparison.finalSame).toBe(false)
  })
})
