import type {
  ComparisonRow,
  Plan,
  RecordComparison,
  RoundState,
  SimulationResult,
  Step,
  StepDiff,
} from './types'

function text(value: number | null | undefined): string {
  return value == null ? '—' : String(value)
}

function characterName(state: RoundState, id: string): string {
  return state.characters.find((c) => c.id === id)?.name ?? id
}

export function queueText(state: RoundState, ids: string[]): string {
  if (ids.length === 0) return '(空)'
  return ids.map((id) => characterName(state, id)).join(' → ')
}

function stateText(state: RoundState): string {
  return state.characters
    .map((c) => {
      const hp = c.hp <= 0 ? '阵亡' : `${c.hp}/${c.maxHp}`
      return `${c.name} HP ${hp} 盾 ${c.shield}/${c.maxShield} AP ${c.ap}`
    })
    .join(' | ')
}

function stepFields(step: Step, fallbackState: RoundState): Record<string, string> {
  const state = step.stateAfter ?? fallbackState
  return {
    行动者: step.actorName,
    结果: `${step.kind}/${step.outcome}`,
    指令: step.command ? `${step.command.type}${step.command.targetId ? ` → ${characterName(state, step.command.targetId)}` : ''}` : '无',
    目标: step.targetName ?? '—',
    原因: step.reason ?? '—',
    行动点消耗: text(step.apCost),
    行动者生命: `${step.actorBefore.hp} → ${step.actorAfter.hp}`,
    行动者护盾: `${step.actorBefore.shield} → ${step.actorAfter.shield}`,
    行动者行动点: `${step.actorBefore.ap} → ${step.actorAfter.ap}`,
    目标生命: step.targetBefore ? `${step.targetBefore.hp} → ${text(step.targetAfter?.hp)}` : '—',
    目标护盾: step.targetBefore ? `${step.targetBefore.shield} → ${text(step.targetAfter?.shield)}` : '—',
    护盾吸收: text(step.shieldAbsorbed),
    生命损失: text(step.hpLost),
    溢出伤害: text(step.overkill),
    护盾获得: text(step.shieldGained),
    剩余队列: queueText(state, step.queueAfter),
    说明: step.message,
  }
}

function compareFinalStates(preview: RoundState, actual: RoundState): StepDiff[] {
  const diffs: StepDiff[] = []
  const length = Math.max(preview.characters.length, actual.characters.length)
  for (let i = 0; i < length; i++) {
    const p = preview.characters[i]
    const a = actual.characters[i]
    const pText = p ? `${p.name} HP ${p.hp}/${p.maxHp} 盾 ${p.shield}/${p.maxShield} AP ${p.ap}` : '—'
    const aText = a ? `${a.name} HP ${a.hp}/${a.maxHp} 盾 ${a.shield}/${a.maxShield} AP ${a.ap}` : '—'
    if (pText !== aText) {
      diffs.push({ index: 0, field: `终态 · ${p?.name ?? a?.name ?? i}`, preview: pText, actual: aText })
    }
  }
  const pq = queueText(preview, preview.pending)
  const aq = queueText(actual, actual.pending)
  if (pq !== aq) diffs.push({ index: 0, field: '终态 · 剩余队列', preview: pq, actual: aq })
  if (stateText(preview) !== stateText(actual) && diffs.length === 0) {
    diffs.push({ index: 0, field: '终态', preview: stateText(preview), actual: stateText(actual) })
  }
  return diffs
}

/**
 * 对齐逐步比较一份预览与一次真实结算。
 * 无随机因素时, 用同一方案生成的预览与实战应逐步一致;
 * 若比较的是一份旧方案预览, 则返回第一处差异所在步与每个字段的前后值。
 */
export function compareRuns(
  preview: SimulationResult,
  actual: SimulationResult,
  actualInitial: RoundState,
): RecordComparison {
  const rows: ComparisonRow[] = []
  const diffs: StepDiff[] = []
  const differing = new Set<number>()
  const count = Math.max(preview.steps.length, actual.steps.length)

  for (let i = 0; i < count; i++) {
    const p = preview.steps[i]
    const a = actual.steps[i]
    const index = i + 1
    if (!p || !a) {
      differing.add(index)
      diffs.push({
        index,
        field: '步骤',
        preview: p ? p.message : '(预览无此步)',
        actual: a ? a.message : '(实战无此步)',
      })
      rows.push({
        index,
        actorName: p?.actorName ?? a?.actorName ?? '—',
        previewMessage: p?.message ?? '(无)',
        actualMessage: a?.message ?? '(无)',
        same: false,
        diffCount: 1,
      })
      continue
    }
    const pf = stepFields(p, actualInitial)
    const af = stepFields(a, actualInitial)
    const changed = Object.keys(pf).filter((key) => pf[key] !== af[key])
    for (const key of changed) {
      diffs.push({ index, field: key, preview: pf[key]!, actual: af[key]! })
    }
    if (changed.length > 0) differing.add(index)
    rows.push({
      index,
      actorName: p.actorName,
      previewMessage: p.message,
      actualMessage: a.message,
      same: changed.length === 0,
      diffCount: changed.length,
    })
  }

  const finalDiffs = compareFinalStates(preview.finalState, actual.finalState)

  return {
    previewSteps: preview.steps.length,
    actualSteps: actual.steps.length,
    differingSteps: differing.size,
    diffs,
    rows,
    finalSame: finalDiffs.length === 0,
    finalDiffs,
  }
}

/** 第一处差异所在步; 完全一致时返回 null */
export function firstDifferenceStep(comparison: RecordComparison): number | null {
  const stepDiffs = comparison.diffs.filter((d) => d.index > 0)
  if (stepDiffs.length === 0) return null
  return Math.min(...stepDiffs.map((d) => d.index))
}

export function planSummary(plan: Plan, state: RoundState): string {
  const parts: string[] = []
  for (const [actorId, command] of Object.entries(plan)) {
    if (!command) continue
    const actor = characterName(state, actorId)
    if (command.type === 'shield') parts.push(`${actor} 护盾`)
    else parts.push(`${actor} ${command.type === 'attack' ? '普攻' : '推迟'} ${command.targetId ? characterName(state, command.targetId) : '?'}`)
  }
  return parts.length ? parts.join(' · ') : '(空方案)'
}
