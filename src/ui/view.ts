import { AP_COST } from '../game/engine'
import type { Character, Command, RoundState, Step } from '../game/types'

/** 预览/回放快照: index 0 = 回合初始, n = 第 n 步之后 */
export function stateAt(
  steps: Step[],
  initial: RoundState,
  index: number,
): RoundState {
  if (index <= 0) return initial
  const clamped = Math.min(index, steps.length)
  return steps[clamped - 1]?.stateAfter ?? initial
}

/** 目标 -> 累计承受的伤害; 与「行动者自己的结果」分开显示 */
export function impactByTarget(
  steps: Iterable<Step>,
): Map<string, { hp: number; shield: number }> {
  const map = new Map<string, { hp: number; shield: number }>()
  for (const step of steps) {
    if (!step.targetId || step.targetId === step.actorId) continue
    if (step.hpLost === 0 && step.shieldAbsorbed === 0) continue
    const current = map.get(step.targetId) ?? { hp: 0, shield: 0 }
    map.set(step.targetId, {
      hp: current.hp + step.hpLost,
      shield: current.shield + step.shieldAbsorbed,
    })
  }
  return map
}

/** 行动者 -> 本回合结果; 用于在队列和画布上打预计/实际角标 */
export function stepByActor(steps: Iterable<Step> | null | undefined): Map<string, Step> {
  const map = new Map<string, Step>()
  if (!steps) return map
  for (const step of steps) map.set(step.actorId, step)
  return map
}

export function characterOf(state: RoundState, id: string | null): Character | null {
  if (!id) return null
  return state.characters.find((c) => c.id === id) ?? null
}

/** 规划阶段的指令自查: 不依赖模拟, 提示明显会失效的指令 */
export function commandIssue(
  state: RoundState,
  actor: Character | null,
  command: Command | null,
): string | null {
  if (!actor || !command) return null
  if (actor.hp <= 0) return '角色已阵亡'
  const cost = AP_COST[command.type]
  if (actor.ap < cost) return `行动点不足 (需 ${cost}, 有 ${actor.ap})`
  if (command.type === 'shield') return null
  if (!command.targetId) return '尚未指定目标'
  const target = characterOf(state, command.targetId)
  if (!target) return '目标不存在'
  if (target.hp <= 0) return `${target.name} 已阵亡, 轮到时将跳过`
  if (command.type === 'attack' && target.side === actor.side) return '目标不是敌方'
  if (command.type === 'delay' && target.id === actor.id) return '不能推迟自己'
  return null
}
