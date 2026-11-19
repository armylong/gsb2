export type Side = 'ally' | 'enemy'

export type CommandType = 'attack' | 'shield' | 'delay'

export interface Command {
  type: CommandType
  /** attack / delay 的目标; shield 固定为自己, 恒为 null */
  targetId: string | null
}

/** 角色 id -> 指令; 值为 null / 缺省表示未安排 */
export type Plan = Record<string, Command | null>

export interface Character {
  id: string
  name: string
  role: string
  side: Side
  /** 部署序号, 同速时的稳定次序依据 */
  slot: number
  maxHp: number
  hp: number
  atk: number
  maxShield: number
  shield: number
  shieldGain: number
  speed: number
  maxAp: number
  ap: number
}

export interface RoundState {
  round: number
  characters: Character[]
  /** 本回合尚未行动的角色, 队首为下一个行动者 */
  pending: string[]
  /** 本回合已经行动过的角色 (含跳过/待机) */
  acted: string[]
}

export interface ActorValues {
  hp: number
  maxHp: number
  shield: number
  maxShield: number
  ap: number
  maxAp: number
  alive: boolean
}

export type StepKind = 'act' | 'skip' | 'idle'
export type StepOutcome = 'damage' | 'shield' | 'delay' | 'skip' | 'idle'

export interface QueueMove {
  id: string
  /** 角色在行动后剩余队列中的旧下标 (0 起) */
  from: number
  /** 角色在行动后剩余队列中的新下标 (0 起) */
  to: number
}

export interface Step {
  /** 从 1 开始 */
  index: number
  round: number
  actorId: string
  actorName: string
  command: Command | null
  kind: StepKind
  outcome: StepOutcome
  /** 跳过 / 待机的原因; 正常行动为 null */
  reason: string | null
  targetId: string | null
  targetName: string | null
  /** 实际扣除的行动点; 跳过恒为 0 */
  apCost: number
  actorBefore: ActorValues
  actorAfter: ActorValues
  targetBefore: ActorValues | null
  targetAfter: ActorValues | null
  shieldAbsorbed: number
  hpLost: number
  overkill: number
  shieldGained: number
  /** 行动前 (含行动者) 的队列 */
  queueBefore: string[]
  /** 行动后的剩余队列 */
  queueAfter: string[]
  /** 推迟成功且位置变化时记录 */
  queueMoved: QueueMove | null
  /** 本步从队列移除的角色, 恒为行动者 */
  queueRemovedId: string
  message: string
  /** 该步结算完毕后的完整场景快照; 回放只读取快照 */
  stateAfter: RoundState
}

export interface SimulationResult {
  steps: Step[]
  finalState: RoundState
}

export interface ScenarioCharacter {
  id: string
  name: string
  role: string
  side: Side
  slot: number
  maxHp: number
  startHp?: number
  atk: number
  maxShield: number
  startShield?: number
  shieldGain: number
  speed: number
  maxAp: number
}

export interface Scenario {
  id: string
  name: string
  tagline: string
  description: string
  /** 这组样例要观察的要点 */
  lessons: string[]
  characters: ScenarioCharacter[]
  initialPlan: Plan
}

export interface RoundRecord {
  id: string
  scenarioId: string
  round: number
  plan: Plan
  /** 该回合的初始状态, 永不改写 */
  initial: RoundState
  /** 确认执行时展示并锁定的那一份预览 */
  preview: SimulationResult
  previewId: string
  /** 本回合规划期间生成过的所有预览 (含较早的方案), 供事后对照定位 */
  previewHistory: PreviewEntry[]
  /** 执行时的真实结算 (从同一初始状态独立重算) */
  steps: Step[]
  finalState: RoundState
  createdAt: number
}

/** 一次预览快照; 只读, 仅供对照, 永远不会被直接执行 */
export interface PreviewEntry {
  id: string
  plan: Plan
  result: SimulationResult
  createdAt: number
}

export type SessionPhase = 'planning' | 'finished'

export interface GameSession {
  scenarioId: string
  round: number
  /** 规划中为回合初始状态; 已结算时为该回合终态 */
  state: RoundState
  plan: Plan
  records: RoundRecord[]
  phase: SessionPhase
  /** 当前方案对应的最新预览; 修改方案后清空 */
  preview: PreviewEntry | null
  /** 所有生成过的预览, 供事后对照 */
  previewHistory: PreviewEntry[]
  nextRecordSeq: number
  nextPreviewSeq: number
}

export interface StepDiff {
  /** 对齐后的步号; 0 表示回合初始状态 */
  index: number
  field: string
  preview: string
  actual: string
}

export interface ComparisonRow {
  index: number
  actorName: string
  previewMessage: string
  actualMessage: string
  same: boolean
  diffCount: number
}

export interface RecordComparison {
  previewSteps: number
  actualSteps: number
  differingSteps: number
  diffs: StepDiff[]
  rows: ComparisonRow[]
  finalSame: boolean
  finalDiffs: StepDiff[]
}
