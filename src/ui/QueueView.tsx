import type { RoundState, Step } from '../game/types'

interface QueueViewProps {
  state: RoundState
  /** 每个角色的预计/实际结果, 用于行尾角标 */
  outcomeByActor?: Map<string, Step>
  activeActorId?: string | null
  /** 回放时高亮的行动者 */
  highlightId?: string | null
  /** 预览/回放终点的剩余队列; 提供时在底部显示 */
  finalQueue?: string[] | null
  title?: string
  emptyLabel?: string
}

export function QueueView({
  state,
  outcomeByActor,
  activeActorId,
  highlightId,
  title = '行动队列',
  emptyLabel = '本回合没有待行动角色',
  finalQueue,
}: QueueViewProps) {
  const finalQueueNames = finalQueue?.map((id) => state.characters.find((c) => c.id === id)?.name ?? id) ?? null
  const name = (id: string) => state.characters.find((c) => c.id === id)?.name ?? id
  const items = state.pending

  return (
    <div className="queue">
      <div className="queue-head">
        <span>{title}</span>
        <span className="queue-count">{items.length} 人待行动</span>
      </div>
      {items.length === 0 ? (
        <div className="queue-empty">{emptyLabel}</div>
      ) : (
        <ol className="queue-list">
          {items.map((id, index) => {
            const character = state.characters.find((c) => c.id === id)!
            const outcome = outcomeByActor?.get(id)
            const isActive = activeActorId === id
            const isHighlight = highlightId === id
            return (
              <li
                key={id}
                className={[
                  'queue-item',
                  `side-${character.side}`,
                  isActive ? 'is-next' : '',
                  isHighlight ? 'is-highlight' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <span className="queue-index">{index + 1}</span>
                <span className="queue-dot" aria-hidden="true" />
                <span className="queue-name">{name(id)}</span>
                <span className="queue-speed">速 {character.speed}</span>
                {index > 0 && character.speed === state.characters.find((c) => c.id === state.pending[index - 1])?.speed && (
                  <span className="queue-tie" title="与上一位同速; 同速时按我方 → 敌方 → 部署序号">
                    同速
                  </span>
                )}
                {outcome && (
                  <span className={`queue-outcome tone-${outcome.outcome}`}>
                    {outcome.outcome === 'damage'
                      ? `-${outcome.hpLost} HP`
                      : outcome.outcome === 'shield'
                        ? `+${outcome.shieldGained} 盾`
                        : outcome.outcome === 'delay'
                          ? outcome.queueMoved
                            ? '推迟至队尾'
                            : '推迟(未变)'
                          : outcome.outcome === 'skip'
                            ? '跳过'
                            : '待机'}
                  </span>
                )}
                {isActive && <span className="queue-badge">下一位</span>}
              </li>
            )
          })}
        </ol>
      )}
      {finalQueueNames && (
        <div className="queue-final">
          <span className="queue-final-label">终局剩余</span>
          <span className="queue-final-value">
            {finalQueueNames.length ? finalQueueNames.join(' → ') : '(空)'}
          </span>
        </div>
      )}
      {state.acted.length > 0 && (
        <div className="queue-acted">
          <span className="queue-acted-label">已行动</span>
          <div className="queue-acted-list">
            {state.acted.map((id) => (
              <span key={id} className="queue-acted-chip">
                {name(id)}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
