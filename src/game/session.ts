import {
  buildRoundState,
  clonePlan,
  cloneState,
  defaultPlan,
  isAlive,
  nextRoundState,
  simulateRound,
} from './engine'
import { getScenario, scenarioPlan } from './scenarios'
import type {
  Character,
  Command,
  GameSession,
  Plan,
  PreviewEntry,
  RoundRecord,
  RoundState,
  ScenarioCharacter,
  Step,
} from './types'

export function characterFromScenario(c: ScenarioCharacter): Character {
  return {
    id: c.id,
    name: c.name,
    role: c.role,
    side: c.side,
    slot: c.slot,
    maxHp: c.maxHp,
    hp: c.startHp ?? c.maxHp,
    atk: c.atk,
    maxShield: c.maxShield,
    shield: c.startShield ?? 0,
    shieldGain: c.shieldGain,
    speed: c.speed,
    maxAp: c.maxAp,
    ap: c.maxAp,
  }
}

export function initialRoundState(scenarioId: string): RoundState {
  const scenario = getScenario(scenarioId)
  return buildRoundState(1, scenario.characters.map(characterFromScenario))
}

export function createSession(scenarioId: string): GameSession {
  const scenario = getScenario(scenarioId)
  return {
    scenarioId,
    round: 1,
    state: initialRoundState(scenarioId),
    plan: scenarioPlan(scenario),
    records: [],
    phase: 'planning',
    preview: null,
    previewHistory: [],
    nextRecordSeq: 1,
    nextPreviewSeq: 1,
  }
}

/** 重新载入样例: 丢弃该样例的全部规划、预览与记录 */
export function resetSession(session: GameSession): GameSession {
  return createSession(session.scenarioId)
}

export function plansEqual(a: Plan, b: Plan): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    const ca = a[key] ?? null
    const cb = b[key] ?? null
    if (!ca && !cb) continue
    if (!ca || !cb) return false
    if (ca.type !== cb.type || ca.targetId !== cb.targetId) return false
  }
  return true
}

function invalidatePreview(session: GameSession, plan: Plan): GameSession {
  return { ...session, plan, preview: null }
}

/** 设置某角色的指令。仅规划阶段可用; 修改会让当前预览失效 */
export function setCommand(session: GameSession, actorId: string, command: Command | null): GameSession {
  if (session.phase !== 'planning') return session
  const plan = clonePlan(session.plan)
  plan[actorId] = command ? { type: command.type, targetId: command.targetId } : null
  return invalidatePreview(session, plan)
}

export function clearPlan(session: GameSession): GameSession {
  if (session.phase !== 'planning') return session
  const plan: Plan = {}
  for (const character of session.state.characters) {
    if (isAlive(character)) plan[character.id] = null
  }
  return invalidatePreview(session, plan)
}

export function resetPlanToDefault(session: GameSession): GameSession {
  if (session.phase !== 'planning') return session
  return invalidatePreview(session, defaultPlan(session.state))
}

/** 生成预览: 纯计算, 在克隆状态上结算, 不触碰 session.state */
export function makePreview(session: GameSession): GameSession {
  if (session.phase !== 'planning') return session
  const plan = clonePlan(session.plan)
  const result = simulateRound(session.state, plan)
  const entry: PreviewEntry = {
    id: `p${session.nextPreviewSeq}`,
    plan,
    result,
    createdAt: Date.now(),
  }
  return {
    ...session,
    preview: entry,
    previewHistory: [entry, ...session.previewHistory].slice(0, 20),
    nextPreviewSeq: session.nextPreviewSeq + 1,
  }
}

export function clearPreview(session: GameSession): GameSession {
  return { ...session, preview: null }
}

/**
 * 确认执行。要求存在一份对应当前方案的预览。
 * 真实结算从该回合初始状态独立重算; 预览作为证据冻结进记录。
 */
export function executeRound(session: GameSession): GameSession {
  if (session.phase !== 'planning' || !hasFreshPreview(session) || !session.preview) return session

  const initial = cloneState(session.state)
  const plan = clonePlan(session.preview.plan)
  const actual = simulateRound(initial, plan)
  const preview = session.preview
  const record: RoundRecord = {
    id: `r${session.nextRecordSeq}`,
    scenarioId: session.scenarioId,
    round: session.round,
    plan,
    initial,
    preview: preview.result,
    previewId: preview.id,
    previewHistory: session.previewHistory,
    steps: actual.steps,
    finalState: actual.finalState,
    createdAt: Date.now(),
  }

  return {
    ...session,
    state: cloneState(actual.finalState),
    phase: 'finished',
    preview: null,
    previewHistory: [],
    records: [...session.records, record],
    nextRecordSeq: session.nextRecordSeq + 1,
  }
}

/** 进入下一回合; 旧记录保留, 其 initial 快照不受影响 */
export function advanceRound(session: GameSession): GameSession {
  if (session.phase !== 'finished') return session
  const next = nextRoundState(session.state)
  return {
    ...session,
    round: next.round,
    state: next,
    plan: defaultPlan(next),
    phase: 'planning',
    preview: null,
  }
}

export function findRecord(session: GameSession, recordId: string): RoundRecord | undefined {
  return session.records.find((r) => r.id === recordId)
}

/** 当前预览是否与方案一致 */
export function hasFreshPreview(session: GameSession): boolean {
  return session.preview !== null && plansEqual(session.preview.plan, session.plan)
}

/**
 * 回放状态: stepIndex 0 表示回合初始状态, n 表示第 n 步结算后。
 * 只读取已保存的快照, 绝不重新结算; 因此前后拖动不会重复扣血或再次触发推迟。
 */
export function replayStateAt(record: RoundRecord, stepIndex: number): RoundState {
  if (stepIndex <= 0) return cloneState(record.initial)
  const clamped = Math.min(stepIndex, record.steps.length)
  return cloneState(record.steps[clamped - 1]!.stateAfter)
}

export function replayStepAt(record: RoundRecord, stepIndex: number): Step | null {
  if (stepIndex <= 0) return null
  return record.steps[Math.min(stepIndex, record.steps.length) - 1] ?? null
}

/** 战斗是否已结束 (任一方全员阵亡); 调试页只做提示, 不强制终止 */
export function isBattleOver(state: RoundState): { over: boolean; reason: string | null } {
  const alliesAlive = state.characters.some((c) => c.side === 'ally' && isAlive(c))
  const enemiesAlive = state.characters.some((c) => c.side === 'enemy' && isAlive(c))
  if (!alliesAlive) return { over: true, reason: '我方全员阵亡' }
  if (!enemiesAlive) return { over: true, reason: '敌方全员阵亡' }
  return { over: false, reason: null }
}

