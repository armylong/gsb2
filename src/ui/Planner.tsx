import { AP_COST, COMMAND_LABEL, isAlive } from '../game/engine'
import type { Character, Command, CommandType, Plan, RoundState, Step } from '../game/types'
import { commandIssue } from './view'

interface PlannerProps {
  state: RoundState
  plan: Plan
  selectedId: string | null
  onSelect: (id: string) => void
  onCommand: (actorId: string, command: Command | null) => void
  /** 预览中该角色的结果角标 */
  outcomeByActor: Map<string, Step>
  disabled: boolean
  /** 回放历史或已结算时禁用, 并显示这个提示 */
  disabledNote?: string
}

const TYPES: CommandType[] = ['attack', 'shield', 'delay']

export function Planner({
  state,
  plan,
  selectedId,
  onSelect,
  onCommand,
  outcomeByActor,
  disabled,
  disabledNote,
}: PlannerProps) {
  const groups = (['ally', 'enemy'] as const).map((side) => ({
    side,
    label: side === 'ally' ? '我方' : '敌方',
    characters: state.characters
      .filter((c) => c.side === side)
      .sort((a, b) => a.slot - b.slot),
  }))

  const targetOptions = (actor: Character, type: CommandType): Character[] => {
    if (type === 'shield') return []
    return state.characters
      .filter((c) => c.id !== actor.id)
      .filter((c) => (type === 'attack' ? c.side !== actor.side : true))
  }

  const apply = (actor: Character, type: CommandType): void => {
    if (disabled) return
    const current = plan[actor.id]
    if (current?.type === type) {
      // 再次点击同一指令 = 撤回
      onCommand(actor.id, null)
      return
    }
    if (type === 'shield') {
      onCommand(actor.id, { type, targetId: null })
      return
    }
    const options = targetOptions(actor, type)
    const keepTarget =
      current?.targetId && options.some((c) => c.id === current.targetId) ? current.targetId : null
    const fallback = options.find((c) => isAlive(c)) ?? options[0]
    onCommand(actor.id, { type, targetId: keepTarget ?? fallback?.id ?? null })
  }

  const setTarget = (actor: Character, type: CommandType, targetId: string): void => {
    if (disabled) return
    onCommand(actor.id, { type, targetId })
  }

  return (
    <div className="planner">
      <p className="planner-note">
        {disabled ? disabledNote : '双方角色都可以安排指令。点角色 → 选指令; 再点同一指令可撤回, 修改不会消耗任何资源。'}
      </p>

      {groups.map((group) => (
        <section key={group.side} className={`planner-group side-${group.side}`} aria-label={`${group.label}行动`}>
          <h3 className="planner-group-title">
            <span className={`side-dot side-${group.side}`} aria-hidden="true" />
            {group.label}
            <span className="planner-group-count">
              {group.characters.filter((c) => c.hp > 0 && plan[c.id]).length}/
              {group.characters.filter((c) => c.hp > 0).length} 已安排
            </span>
          </h3>

          <ul className="planner-list">
            {group.characters.map((actor) => {
              const command = plan[actor.id] ?? null
              const issue = commandIssue(state, actor, command)
              const outcome = outcomeByActor.get(actor.id)
              const dead = actor.hp <= 0
              const forecast = outcome
                ? outcome.outcome === 'damage'
                  ? `预计 -${outcome.hpLost} HP`
                  : outcome.outcome === 'shield'
                    ? `预计 +${outcome.shieldGained} 盾`
                    : outcome.outcome === 'delay'
                      ? outcome.queueMoved
                        ? '预计推迟至队尾'
                        : '预计推迟 (已队尾)'
                      : outcome.outcome === 'skip'
                        ? '预计跳过'
                        : '预计待机'
                : null
              return (
                <li
                  key={actor.id}
                  className={[
                    'planner-row',
                    selectedId === actor.id ? 'is-selected' : '',
                    dead ? 'is-dead' : '',
                    command ? 'has-command' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <div className="planner-row-main">
                    <button
                      type="button"
                      className="planner-row-head"
                      onClick={() => onSelect(actor.id)}
                      aria-pressed={selectedId === actor.id}
                      title="选中后, 在战场上点目标也可以直接改目标"
                    >
                      <span className={`side-dot side-${actor.side}`} aria-hidden="true" />
                      <span className="planner-name">{actor.name}</span>
                      <span className="planner-hp">{dead ? '阵亡' : `${actor.hp} HP`}</span>
                      <span className="planner-stats">
                        速 {actor.speed} · AP {actor.ap}/{actor.maxAp}
                      </span>
                    </button>

                    <div className="planner-chips" role="group" aria-label={`${actor.name} 的指令`}>
                      {TYPES.map((type) => {
                        const active = command?.type === type
                        const cost = AP_COST[type]
                        return (
                          <button
                            key={type}
                            type="button"
                            className={[
                              'chip',
                              `chip-${type}`,
                              active ? 'is-active' : '',
                              actor.ap < cost ? 'is-unaffordable' : '',
                            ]
                              .filter(Boolean)
                              .join(' ')}
                            aria-pressed={active}
                            disabled={disabled || dead}
                            onClick={() => apply(actor, type)}
                            title={
                              type === 'shield'
                                ? `获得 ${actor.shieldGain} 护盾, 消耗 ${cost} AP`
                                : `消耗 ${cost} AP`
                            }
                          >
                            {COMMAND_LABEL[type]}
                            <span className="chip-cost">{cost}</span>
                          </button>
                        )
                      })}
                      <button
                        type="button"
                        className="chip chip-clear"
                        disabled={disabled || !command}
                        onClick={() => onCommand(actor.id, null)}
                        title="撤回该角色的指令"
                      >
                        撤回
                      </button>
                    </div>
                  </div>

                  {command && command.type !== 'shield' && (
                    <div className="planner-targets" role="group" aria-label={`${actor.name} 的目标`}>
                      <span className="planner-targets-label">目标</span>
                      {targetOptions(actor, command.type).map((target) => (
                        <button
                          key={target.id}
                          type="button"
                          className={[
                            'target-chip',
                            `side-${target.side}`,
                            command.targetId === target.id ? 'is-active' : '',
                            !isAlive(target) ? 'is-dead' : '',
                          ]
                            .filter(Boolean)
                            .join(' ')}
                          aria-pressed={command.targetId === target.id}
                          disabled={disabled}
                          onClick={() => setTarget(actor, command.type, target.id)}
                        >
                          {target.name}
                          <span className="target-hp">{target.hp <= 0 ? '阵亡' : `${target.hp} HP`}</span>
                        </button>
                      ))}
                    </div>
                  )}

                  <div className="planner-meta">
                    {forecast && <span className="planner-forecast">{forecast}</span>}
                    {issue && <span className="planner-issue">⚠ {issue}</span>}
                    {!command && !dead && <span className="planner-idle">未安排 → 轮到时待机</span>}
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}
