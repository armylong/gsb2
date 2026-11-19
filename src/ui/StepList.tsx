import type { RoundState, Step } from '../game/types'
import { COMMAND_LABEL } from '../game/engine'
import { queueText } from '../game/compare'

interface StepListProps {
  steps: Step[]
  initial: RoundState
  /** 0 = 回合初始, n = 第 n 步之后 */
  activeIndex: number
  onSelect: (index: number) => void
  /** 与另一份结算存在差异的步号 */
  diffSteps?: Set<number>
  /** 是否在每一步右侧显示结算后的剩余队列 */
  showQueue?: boolean
}

const OUTCOME_LABEL: Record<Step['outcome'], string> = {
  damage: '伤害',
  shield: '护盾',
  delay: '推迟',
  skip: '跳过',
  idle: '待机',
}

function targetSummary(step: Step): string | null {
  if (!step.targetBefore || !step.targetAfter) return null
  if (step.targetId === step.actorId) return null
  return `${step.targetName} HP ${step.targetBefore.hp} → ${step.targetAfter.hp} · 盾 ${step.targetBefore.shield} → ${step.targetAfter.shield}`
}

export function StepList({
  steps,
  initial,
  activeIndex,
  onSelect,
  diffSteps,
  showQueue = true,
}: StepListProps) {
  return (
    <ol className="steplist" aria-label="结算步骤">
      <li>
        <button
          type="button"
          className={`step-row step-start ${activeIndex === 0 ? 'is-active' : ''}`}
          onClick={() => onSelect(0)}
        >
          <span className="step-index">0</span>
          <span className="step-main">
            <span className="step-title">回合开始</span>
            <span className="step-detail">全体按速度排序, 行动点重置</span>
          </span>
          <span className="step-queue">初始队列 · {queueText(initial, initial.pending)}</span>
        </button>
      </li>
      {steps.map((step) => {
        const active = activeIndex === step.index
        const hasDiff = diffSteps?.has(step.index) ?? false
        const targetLine = targetSummary(step)
        return (
          <li key={step.index}>
            <button
              type="button"
              className={[
                'step-row',
                active ? 'is-active' : '',
                hasDiff ? 'has-diff' : '',
                `tone-${step.outcome}`,
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => onSelect(step.index)}
              aria-current={active ? 'step' : undefined}
            >
              <span className="step-index">{step.index}</span>
              <span className="step-main">
                <span className="step-title">
                  <span className={`step-badge tone-${step.outcome}`}>{OUTCOME_LABEL[step.outcome]}</span>
                  <strong>{step.actorName}</strong>
                  {step.targetName && step.targetId !== step.actorId && (
                    <span className="step-arrow">→ {step.targetName}</span>
                  )}
                  {step.command && (
                    <span className="step-command">{COMMAND_LABEL[step.command.type]}</span>
                  )}
                  {hasDiff && <span className="step-diff-flag">与另一份结算不同</span>}
                </span>
                <span className="step-detail">{step.message}</span>
                {targetLine && <span className="step-target-line">{targetLine}</span>}
                <span className="step-deltas">
                  {step.outcome === 'damage' && (
                    <>
                      <span className="delta delta-hp">生命 -{step.hpLost}</span>
                      {step.shieldAbsorbed > 0 && (
                        <span className="delta delta-shield">护盾吸收 {step.shieldAbsorbed}</span>
                      )}
                      {step.overkill > 0 && <span className="delta delta-over">溢出 {step.overkill}</span>}
                    </>
                  )}
                  {step.outcome === 'shield' && (
                    <span className="delta delta-shield">护盾 +{step.shieldGained}</span>
                  )}
                  {step.outcome === 'delay' && step.queueMoved && (
                    <span className="delta delta-delay">
                      队列第 {step.queueMoved.from + 1} → {step.queueMoved.to + 1} 位
                    </span>
                  )}
                  {step.outcome === 'delay' && !step.queueMoved && (
                    <span className="delta delta-delay">已在队尾, 位置不变</span>
                  )}
                  <span className={`delta ${step.apCost > 0 ? 'delta-ap' : 'delta-none'}`}>
                    {step.apCost > 0 ? `AP -${step.apCost}` : 'AP 未消耗'}
                  </span>
                  {step.outcome === 'skip' && step.reason && (
                    <span className="delta delta-skip">{step.reason}</span>
                  )}
                </span>
              </span>
              {showQueue && (
                <span className="step-queue">
                  队列 → {step.queueAfter.length ? queueText(step.stateAfter, step.queueAfter) : '(空)'}
                </span>
              )}
            </button>
          </li>
        )
      })}
    </ol>
  )
}
