import { useMemo, useState } from 'react';
import type {
  ChoiceView,
  DialogueConfig,
  DialogueNode,
  Effect,
  GameState,
} from '../engine/types';
import { checkChoice, describeEffects } from '../engine/choices';
import { describeCondition } from '../engine/conditions';

type ViewMode = 'player' | 'debug';

interface ChoiceListProps {
  node: DialogueNode;
  state: GameState;
  config: DialogueConfig;
  onSelect: (choiceId: string) => void;
  /** 从历史只读查看时禁止再次触发效果。 */
  readOnly?: boolean;
}

function EffectBadges({ effects, config }: { effects: Effect[]; config: DialogueConfig }) {
  const descriptions = describeEffects(effects, config.variables);
  if (descriptions.length === 0) return null;
  return (
    <span className="effect-strip" aria-label="选择后的变量变化">
      {descriptions.map((text, index) => (
        <span
          key={`${text}-${index}`}
          className={`effect-chip ${text.includes('-') ? 'effect-chip--cost' : 'effect-chip--gain'}`}
        >
          {text}
        </span>
      ))}
    </span>
  );
}

function ReasonList({ reasons }: { reasons: ChoiceView['reasons'] }) {
  return (
    <ul className="reason-list">
      {reasons.map((reason, index) => (
        <li key={`${reason.text}-${index}`} className={`reason reason--${reason.kind}`}>
          <span className="reason-kind">
            {reason.kind === 'condition' ? '条件' : reason.kind === 'item-cost' ? '消耗' : '目标'}
          </span>
          {reason.text}
        </li>
      ))}
    </ul>
  );
}

export function ChoiceList({ node, state, config, onSelect, readOnly = false }: ChoiceListProps) {
  const [view, setView] = useState<ViewMode>('player');

  const views = useMemo(
    () =>
      node.choices.map((choice) => {
        const availability = checkChoice(choice, state, config);
        return {
          choice,
          available: availability.available,
          reasons: availability.reasons,
          visible:
            view === 'debug' || availability.available || choice.lockedDisplay === 'disable',
        };
      }),
    [node, state, config, view],
  );

  const hiddenCount = views.filter((entry) => !entry.visible).length;
  const lockedCount = views.filter((entry) => entry.available === false).length;

  return (
    <div className="choice-block">
      <div className="choice-toolbar">
        <div className="segmented" role="group" aria-label="视图切换">
          <button
            type="button"
            className={view === 'player' ? 'is-active' : ''}
            aria-pressed={view === 'player'}
            onClick={() => setView('player')}
          >
            玩家视图
          </button>
          <button
            type="button"
            className={view === 'debug' ? 'is-active' : ''}
            aria-pressed={view === 'debug'}
            onClick={() => setView('debug')}
          >
            调试视图
          </button>
        </div>
        <p className="choice-meta" data-testid="choice-meta">
          {view === 'debug'
            ? `共 ${views.length} 项，${lockedCount} 项不可用${hiddenCount ? `，玩家视图将隐藏 ${hiddenCount} 项` : ''}`
            : `可选 ${views.filter((entry) => entry.visible && entry.available).length} 项`}
        </p>
      </div>

      {readOnly ? (
        <p className="notice notice--soft">正在查看历史记录：此处只读，选择不会执行效果。</p>
      ) : null}

      <ol className="choice-list" data-testid="choice-list">
        {views.map((entry) => {
          if (!entry.visible) return null;
          const disabled = !entry.available || readOnly;
          const ordinal = views.filter((other) => other.visible).indexOf(entry) + 1;
          return (
            <li
              key={entry.choice.id}
              className={`choice ${entry.available ? '' : 'choice--locked'} ${
                view === 'debug' ? 'choice--debug' : ''
              }`}
              data-choice-id={entry.choice.id}
              data-available={entry.available}
            >
              <div className="choice-row">
                <span className="choice-index">{String(ordinal).padStart(2, '0')}</span>
                <button
                  type="button"
                  className="choice-button"
                  disabled={disabled}
                  aria-disabled={disabled}
                  onClick={() => onSelect(entry.choice.id)}
                  title={entry.available ? undefined : entry.reasons.map((r) => r.text).join('；')}
                >
                  {entry.choice.label}
                </button>
                {entry.available ? null : (
                  <span
                    className={`badge ${
                      entry.choice.lockedDisplay === 'hide' ? 'badge--hide' : 'badge--disable'
                    }`}
                    title={
                      entry.choice.lockedDisplay === 'hide'
                        ? '不可用时在玩家视图中隐藏'
                        : '不可用时在玩家视图中禁用显示'
                    }
                  >
                    {entry.choice.lockedDisplay === 'hide' ? '玩家视图将隐藏' : '不可用·禁用'}
                  </span>
                )}
              </div>

              <div className="choice-detail">
                <span className="choice-target">→ {entry.choice.target}</span>
                {entry.choice.when ? (
                  <span className="choice-condition" title="选择前检查">
                    条件：{describeCondition(entry.choice.when, config.variables)}
                  </span>
                ) : (
                  <span className="choice-condition choice-condition--none">无条件</span>
                )}
                <EffectBadges effects={entry.choice.effects} config={config} />
              </div>

              {view === 'debug' && !entry.available ? <ReasonList reasons={entry.reasons} /> : null}
            </li>
          );
        })}
      </ol>
      {node.choices.length === 0 ? (
        <p className="empty-note">这个节点没有选项{node.terminal ? '，流程在此结束。' : '。'}</p>
      ) : null}
    </div>
  );
}
