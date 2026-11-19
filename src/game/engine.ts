import type {
  ActorValues,
  Character,
  Command,
  CommandType,
  Plan,
  QueueMove,
  RoundState,
  SimulationResult,
  Step,
  StepKind,
  StepOutcome,
} from './types'

/** 各指令的行动点消耗 (待机不消耗) */
export const AP_COST: Record<CommandType, number> = {
  attack: 1,
  shield: 1,
  delay: 2,
}

export const COMMAND_LABEL: Record<CommandType, string> = {
  attack: '普攻',
  shield: '护盾',
  delay: '推迟',
}

export const SIDE_LABEL = { ally: '我方', enemy: '敌方' } as const

/** 同速时的阵营优先级: 我方先于敌方 */
export const SIDE_PRIORITY = { ally: 0, enemy: 1 } as const

export function cloneCommand(command: Command | null | undefined): Command | null {
  if (!command) return null
  return { type: command.type, targetId: command.targetId }
}

export function clonePlan(plan: Plan): Plan {
  const out: Plan = {}
  for (const [id, command] of Object.entries(plan)) {
    if (command) out[id] = cloneCommand(command)
  }
  return out
}

export function cloneState(state: RoundState): RoundState {
  return {
    round: state.round,
    characters: state.characters.map((c) => ({ ...c })),
    pending: [...state.pending],
    acted: [...state.acted],
  }
}

export function isAlive(character: Character): boolean {
  return character.hp > 0
}

export function findCharacter(state: RoundState, id: string): Character | undefined {
  return state.characters.find((c) => c.id === id)
}

export function actorValues(c: Character): ActorValues {
  return {
    hp: c.hp,
    maxHp: c.maxHp,
    shield: c.shield,
    maxShield: c.maxShield,
    ap: c.ap,
    maxAp: c.maxAp,
    alive: isAlive(c),
  }
}

/**
 * 回合行动次序, 完全确定:
 * 1. 速度高者先;
 * 2. 同速时我方先于敌方;
 * 3. 仍相同则部署序号 (slot) 小者先;
 * 4. 最后以 id 字典序兜底。
 */
export function compareForQueue(a: Character, b: Character): number {
  if (a.speed !== b.speed) return b.speed - a.speed
  if (a.side !== b.side) return SIDE_PRIORITY[a.side] - SIDE_PRIORITY[b.side]
  if (a.slot !== b.slot) return a.slot - b.slot
  return a.id.localeCompare(b.id)
}

/** 存活角色按稳定次序排列 */
export function buildOrder(characters: Character[]): string[] {
  return characters
    .filter(isAlive)
    .slice()
    .sort(compareForQueue)
    .map((c) => c.id)
}

/** 构造回合初始状态: 存活角色按稳定次序进入 pending, 行动点重置为上回合结束值或上限 */
export function buildRoundState(round: number, characters: Character[]): RoundState {
  const chars = characters.map((c) => ({ ...c, ap: isAlive(c) ? c.maxAp : c.ap }))
  return {
    round,
    characters: chars,
    pending: buildOrder(chars),
    acted: [],
  }
}

/** 预览与执行共用同一个纯函数: 不修改入参, 不读取外部状态 */
export function simulateRound(initial: RoundState, plan: Plan): SimulationResult {
  const state = cloneState(initial)
  // 从稳定的行动次序重新推导, 保证预览和执行从完全相同的队列出发
  state.pending = buildOrder(state.characters)
  state.acted = []

  const steps: Step[] = []
  const maxSteps = state.characters.length + 1
  let guard = 0

  while (state.pending.length > 0) {
    if (guard++ > maxSteps) {
      throw new Error('结算步数超过角色数, 行动队列可能已被破坏')
    }
    const actorId = state.pending[0]!
    const actor = findCharacter(state, actorId)
    if (!actor) throw new Error(`行动队列包含未知角色: ${actorId}`)

    const rawCommand = plan[actorId]
    const command = rawCommand ?? null
    const queueBefore = [...state.pending]
    const actorBefore = actorValues(actor)

    let target: Character | null = null
    if (command?.type === 'shield') {
      target = actor
    } else if (command?.type === 'attack' || command?.type === 'delay') {
      target = command.targetId ? (findCharacter(state, command.targetId) ?? null) : null
    }
    const targetBefore = target ? actorValues(target) : null

    const apRequired = command ? AP_COST[command.type] : 0
    // 所有分支都会在下面覆写这三个值; 初值只为满足类型检查
    let kind: StepKind = 'idle'
    let outcome: StepOutcome = 'idle'
    let reason: string | null = null
    let apCost = 0
    let shieldAbsorbed = 0
    let hpLost = 0
    let overkill = 0
    let shieldGained = 0
    let message = `${actor.name} 未安排指令, 待机 (不消耗行动点)`
    let move: QueueMove | null = null
    let recordedTarget: Character | null = target

    const skip = (why: string, text?: string): void => {
      kind = 'skip'
      outcome = 'skip'
      reason = why
      message = text ?? `${actor.name} 跳过行动: ${why}`
    }

    if (!isAlive(actor)) {
      skip('行动者已阵亡', `${actor.name} 已阵亡, 无法行动, 不消耗行动点`)
    } else if (!command) {
      kind = 'idle'
      outcome = 'idle'
      message = `${actor.name} 未安排指令, 待机 (不消耗行动点)`
    } else if (actor.ap < apRequired) {
      skip(
        `行动点不足: ${COMMAND_LABEL[command.type]}需 ${apRequired}, 剩余 ${actor.ap}`,
      )
    } else if (command.type === 'shield') {
      kind = 'act'
      outcome = 'shield'
      apCost = apRequired
      shieldGained = Math.max(0, Math.min(actor.shieldGain, actor.maxShield - actor.shield))
      message =
        shieldGained > 0
          ? `${actor.name} 获得 ${shieldGained} 点护盾 (${actor.shield} -> ${actor.shield + shieldGained})`
          : `${actor.name} 举盾, 但护盾已满 (${actor.shield}/${actor.maxShield})`
    } else if (command.type === 'attack') {
      if (!command.targetId) {
        skip('未指定攻击目标')
      } else if (!target) {
        skip(`目标不存在 (${command.targetId})`)
      } else if (target.side === actor.side) {
        skip(`${target.name} 不是敌方目标, 不自动改打其他目标`)
      } else if (!isAlive(target)) {
        skip(
          `目标 ${target.name} 已阵亡`,
          `${actor.name} 跳过普攻: 目标 ${target.name} 已阵亡, 不自动改打其他目标, 不扣行动点`,
        )
      } else {
        kind = 'act'
        outcome = 'damage'
        apCost = apRequired
        shieldAbsorbed = Math.min(target.shield, actor.atk)
        const rawHpLoss = actor.atk - shieldAbsorbed
        hpLost = Math.min(target.hp, rawHpLoss)
        overkill = rawHpLoss - hpLost
        message =
          shieldAbsorbed > 0
            ? `${actor.name} 攻击 ${target.name}: ${actor.atk} 伤害, 护盾吸收 ${shieldAbsorbed}, 生命 -${hpLost}`
            : `${actor.name} 攻击 ${target.name}: 生命 -${hpLost}${overkill > 0 ? ` (溢出 ${overkill})` : ''}`
      }
    } else {
      // delay
      if (!command.targetId) {
        skip('未指定推迟目标')
      } else if (command.targetId === actorId) {
        skip('不能推迟自己')
      } else if (!target) {
        skip(`目标不存在 (${command.targetId})`)
      } else if (!isAlive(target)) {
        skip(`目标 ${target.name} 已阵亡`, `${actor.name} 跳过推迟: 目标 ${target.name} 已阵亡, 不扣行动点`)
      } else {
        const remaining = state.pending.slice(1)
        const at = remaining.indexOf(target.id)
        if (at < 0) {
          skip(
            `${target.name} 本回合已经行动过`,
            `${actor.name} 跳过推迟: ${target.name} 已行动, 不会再次获得行动, 不扣行动点`,
          )
        } else if (at === remaining.length - 1) {
          kind = 'act'
          outcome = 'delay'
          apCost = apRequired
          message = `${actor.name} 推迟 ${target.name}: 目标已在队尾, 队列保持不变`
        } else {
          kind = 'act'
          outcome = 'delay'
          apCost = apRequired
          message = `${actor.name} 推迟 ${target.name}: 从第 ${at + 1} 位移至队尾`
          move = { id: target.id, from: at, to: remaining.length - 1 }
        }
      }
    }

    const executed = kind === 'act'
    if (executed && command) {
      actor.ap -= apCost
      if (command.type === 'shield') {
        actor.shield = Math.min(actor.maxShield, actor.shield + shieldGained)
      } else if (command.type === 'attack' && recordedTarget) {
        recordedTarget.shield -= shieldAbsorbed
        recordedTarget.hp = Math.max(0, recordedTarget.hp - hpLost)
      }
    }

    const nextPending = state.pending.slice(1)
    if (executed && command?.type === 'delay' && move) {
      const [moved] = nextPending.splice(move.from, 1)
      if (moved) nextPending.push(moved)
      move = { ...move, to: nextPending.length - 1 }
    }
    state.pending = nextPending
    state.acted = [...state.acted, actorId]

    if (recordedTarget === actor) recordedTarget = actor
    const targetAfterCharacter = recordedTarget ? findCharacter(state, recordedTarget.id) : null

    const step: Step = {
      index: steps.length + 1,
      round: state.round,
      actorId,
      actorName: actor.name,
      command: cloneCommand(command),
      kind,
      outcome,
      reason,
      targetId: recordedTarget?.id ?? (command?.targetId ?? null),
      targetName: recordedTarget?.name ?? null,
      apCost,
      actorBefore,
      actorAfter: actorValues(actor),
      targetBefore,
      targetAfter: targetAfterCharacter ? actorValues(targetAfterCharacter) : null,
      shieldAbsorbed,
      hpLost,
      overkill,
      shieldGained,
      queueBefore,
      queueAfter: [...state.pending],
      queueMoved: move,
      queueRemovedId: actorId,
      message,
      stateAfter: cloneState(state),
    }
    steps.push(step)
  }

  return { steps, finalState: cloneState(state) }
}

/** 默认方案: 每名存活角色普攻敌方最靠前的存活角色 */
export function defaultPlan(state: RoundState): Plan {
  const plan: Plan = {}
  for (const actor of state.characters) {
    if (!isAlive(actor)) continue
    const enemy = state.characters
      .filter((c) => c.side !== actor.side && isAlive(c))
      .sort((a, b) => a.slot - b.slot)[0]
    plan[actor.id] = enemy ? { type: 'attack', targetId: enemy.id } : { type: 'shield', targetId: null }
  }
  return plan
}

export function nextRoundState(finalState: RoundState): RoundState {
  return buildRoundState(finalState.round + 1, finalState.characters)
}
