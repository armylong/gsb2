import { useMemo, useState } from 'react';
import type {
  AnimState,
  EventKind,
  MachineConfig,
  Transition,
  TransitionStatus,
} from '../engine/types';

import type { StudioSnapshot } from '../studio/store';
import { buildPreviewFrame, previewTransitionStatuses } from '../engine/preview';
import {
  BlockReasonTags,
  EventKindSelect,
  EventKindLegend,
  PoseKindSelect,
  StateTimeline,
} from './Graph';

interface InspectorProps {
  state: StudioSnapshot;
  ctx: Actions;
}

interface Actions {
  patchState: (id: string, patch: Partial<AnimState>) => void;
  patchEvent: (stateId: string, eventId: string, patch: Partial<AnimState['events'][number]>) => void;
  addEvent: (stateId: string) => void;
  removeEvent: (stateId: string, eventId: string) => void;
  patchTransition: (id: string, patch: Partial<Omit<Transition, 'conditions'>>) => void;
  patchConditions: (id: string, patch: Partial<Transition['conditions']>) => void;
  selectTransition: (id: string | null) => void;
  addTransition: () => void;
  removeTransition: (id: string) => void;
  setSpeed: (value: number) => void;
  setHurt: (value: boolean) => void;
  queueAttack: () => void;
  clearAttacks: () => void;
}

export function Inspector({ state, ctx }: InspectorProps) {
  const draftState = state.draft.states.find((s) => s.id === state.selectedStateId);
  const liveState = state.machine.state;
  const isPreview = state.mode === 'preview';
  const selectedTransition = state.draft.transitions.find(
    (t) => t.id === state.selectedTransitionId,
  );
  // 预览模式按预览时刻评估候选过渡, 只展示不采用
  const previewFrame = isPreview
    ? buildPreviewFrame(state.config, state.preview.stateId, state.preview.timeMs)
    : null;
  const evaluation = previewFrame
    ? previewTransitionStatuses(state.config, previewFrame.state, previewFrame.elapsedMs, {
        speed: state.machine.speed,
        hurt: state.machine.hurt,
        pendingAttacks: state.machine.pendingAttacks,
      })
    : { statuses: state.machine.transitionStatuses, winner: null };
  const fromStatuses = evaluation.statuses;
  const currentName = previewFrame ? previewFrame.state.name : liveState.name;
  const currentProgress = previewFrame ? previewFrame.progress : state.machine.progress;

  return (
    <aside className="inspector">
      <section className="panel">
        <h2>状态属性</h2>
        {draftState ? (
          <StateEditor state={draftState} config={state.draft} ctx={ctx} />
        ) : (
          <p className="hint">关系图中选择一个状态</p>
        )}
      </section>

      <section className="panel">
        <h2>可用过渡 · 来自当前状态</h2>
        <p className="hint small">
          {isPreview
            ? `预览: ${currentName} · 局部 ${Math.round(previewFrame?.elapsedMs ?? 0)}ms · 按此刻评估, 仅展示不采用`
            : `当前: ${currentName} · 进度 ${(currentProgress * 100).toFixed(0)}% · 满足条件者按优先级排序`}
        </p>
        {fromStatuses.length === 0 ? (
          <p className="hint">当前状态没有可用过渡</p>
        ) : (
          <ul className="transition-status-list">
            {[...fromStatuses]
              .sort((a, b) => {
                if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
                if (a.transition.priority !== b.transition.priority) {
                  return b.transition.priority - a.transition.priority;
                }
                return a.orderIndex - b.orderIndex;
              })
              .map((status) => (
                <TransitionStatusRow key={status.transition.id} status={status} />
              ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>过渡编辑</h2>
        {selectedTransition ? (
          <TransitionEditor
            transition={selectedTransition}
            config={state.draft}
            ctx={ctx}
          />
        ) : (
          <p className="hint">在关系图或列表中点选一条过渡</p>
        )}
        <button type="button" className="btn subtle block" onClick={ctx.addTransition}>
          + 从当前状态新增过渡
        </button>
      </section>

      <section className="panel">
        <h2>运行时输入</h2>
        <div className="field-row">
          <label className="field">
            <span>速度</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={state.machine.speed}
              onChange={(e) => ctx.setSpeed(Number(e.target.value))}
              disabled={isPreview}
            />
            <b>{state.machine.speed.toFixed(2)}</b>
          </label>
        </div>
        <label className="switch">
          <input
            type="checkbox"
            checked={state.machine.hurt}
            onChange={(e) => ctx.setHurt(e.target.checked)}
            disabled={isPreview}
          />
          <span>受击</span>
        </label>
        <div className="attack-queue">
          <div>
            <span className="label">待处理攻击</span>
            <span className={`counter ${state.machine.pendingAttacks > 0 ? 'hot' : ''}`}>
              {state.machine.pendingAttacks}
            </span>
          </div>
          <div className="attack-actions">
            <button type="button" className="btn" onClick={ctx.queueAttack} disabled={isPreview}>
              排队攻击
            </button>
            <button
              type="button"
              className="btn muted"
              onClick={ctx.clearAttacks}
              disabled={isPreview || state.machine.pendingAttacks === 0}
            >
              清除未用触发
            </button>
          </div>
          <p className="hint small">
            触发只在过渡被实际采用时消耗; 竞争落败的触发会保留, 可手动清除。
          </p>
        </div>
        {isPreview ? <p className="preview-lock">预览模式下输入已锁定</p> : null}
      </section>

      <section className="panel">
        <h2>当前动作时间轴</h2>
        <StateTimeline
          state={previewFrame?.state ?? liveState}
          elapsedMs={previewFrame?.elapsedMs ?? state.machine.elapsedMs}
          loopIndex={previewFrame?.loopIndex ?? state.machine.loopIndex}
          passedEventIds={previewFrame?.passedEventIds}
        />
        <EventKindLegend />
      </section>
    </aside>
  );
}

function StateEditor({
  state,
  config,
  ctx,
}: {
  state: AnimState;
  config: MachineConfig;
  ctx: Actions;
}) {
  return (
    <div className="state-editor">
      <div className="field-row">
        <label className="field">
          <span>名称</span>
          <input
            value={state.name}
            onChange={(e) => ctx.patchState(state.id, { name: e.target.value })}
          />
        </label>
        <label className="field">
          <span>动作形态</span>
          <PoseKindSelect
            value={state.visual}
            onChange={(visual) => ctx.patchState(state.id, { visual })}
          />
        </label>
      </div>
      <div className="field-row">
        <label className="field">
          <span>时长 (ms)</span>
          <input
            type="number"
            min={1}
            step={10}
            value={state.durationMs}
            onChange={(e) => ctx.patchState(state.id, { durationMs: Number(e.target.value) })}
          />
        </label>
        <label className="switch inline">
          <input
            type="checkbox"
            checked={state.loop}
            onChange={(e) => ctx.patchState(state.id, { loop: e.target.checked })}
          />
          <span>循环动作</span>
        </label>
      </div>
      <p className="hint small">
        {config.initialState === state.id ? '这是配置的初始状态' : ''}
      </p>

      <div className="events-header">
        <h3>时间事件 ({state.events.length})</h3>
        <button type="button" className="btn subtle" onClick={() => ctx.addEvent(state.id)}>
          + 事件
        </button>
      </div>
      <StateTimeline state={state} elapsedMs={0} loopIndex={0} />
      <ul className="event-list">
        {state.events.map((event) => {
          const outOfRange = event.timeMs < 0 || event.timeMs >= state.durationMs;
          return (
            <li key={event.id} className={outOfRange ? 'invalid' : ''}>
              <input
                className="event-name"
                value={event.name}
                onChange={(e) => ctx.patchEvent(state.id, event.id, { name: e.target.value })}
              />
              <EventKindSelect
                value={event.kind}
                onChange={(kind: EventKind) => ctx.patchEvent(state.id, event.id, { kind })}
              />
              <input
                type="number"
                className="event-time"
                min={0}
                max={Math.max(0, state.durationMs - 1)}
                value={event.timeMs}
                onChange={(e) =>
                  ctx.patchEvent(state.id, event.id, { timeMs: Number(e.target.value) })
                }
              />
              <button
                type="button"
                className="btn tiny danger"
                onClick={() => ctx.removeEvent(state.id, event.id)}
                aria-label={`删除事件 ${event.name}`}
              >
                ×
              </button>
              {outOfRange ? <span className="tag bad">越界</span> : null}
            </li>
          );
        })}
      </ul>
      <p className="hint small">
        事件时刻需满足 0 ≤ time &lt; 时长; 越界时「应用」会被拒绝。
      </p>
    </div>
  );
}

function TransitionStatusRow({ status }: { status: TransitionStatus }) {
  return (
    <li className={status.eligible ? 'eligible' : 'blocked'}>
      <div className="status-line">
        <span className="status-name">
          {status.transition.from} → {status.transition.to}
        </span>
        <span className="status-priority">P{status.transition.priority}</span>
        {status.selectionRank !== null ? (
          <span className="status-rank">#{status.selectionRank + 1}</span>
        ) : null}
      </div>
      <div className="status-line small">
        <code>{status.transition.id}</code>
        <BlockReasonTags status={status} />
      </div>
    </li>
  );
}

function TransitionEditor({
  transition,
  config,
  ctx,
}: {
  transition: Transition;
  config: MachineConfig;
  ctx: Actions;
}) {
  const [confirming, setConfirming] = useState(false);
  const stateOptions = useMemo(() => config.states, [config.states]);
  const conditions = transition.conditions;
  return (
    <div className="transition-editor">
      <div className="field-row">
        <label className="field">
          <span>From</span>
          <select
            value={transition.from}
            onChange={(e) => ctx.patchTransition(transition.id, { from: e.target.value })}
          >
            {stateOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>To</span>
          <select
            value={transition.to}
            onChange={(e) => ctx.patchTransition(transition.id, { to: e.target.value })}
          >
            {stateOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="field-row">
        <label className="field">
          <span>优先级 (大者先)</span>
          <input
            type="number"
            value={transition.priority}
            onChange={(e) =>
              ctx.patchTransition(transition.id, { priority: Number(e.target.value) })
            }
          />
        </label>
        <label className="switch inline">
          <input
            type="checkbox"
            checked={transition.waitForProgress}
            onChange={(e) =>
              ctx.patchTransition(transition.id, { waitForProgress: e.target.checked })
            }
          />
          <span>等待当前动作进度</span>
        </label>
      </div>

      <label className="field">
        <span>
          等待进度: {Math.round(transition.progress * 100)}%
          {transition.waitForProgress
            ? ` (${Math.round(transition.progress * 100)}% ≈ ${Math.round(
                transition.progress * (config.states.find((s) => s.id === transition.from)?.durationMs ?? 0),
              )}ms)`
            : ' — 未启用'}
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={transition.progress}
          disabled={!transition.waitForProgress}
          onChange={(e) =>
            ctx.patchTransition(transition.id, { progress: Number(e.target.value) })
          }
        />
      </label>

      <fieldset className="conditions">
        <legend>条件</legend>
        <div className="condition-row">
          <label className="switch inline">
            <input
              type="checkbox"
              checked={conditions.speed !== null}
              onChange={(e) =>
                ctx.patchConditions(transition.id, {
                  speed: e.target.checked ? { op: 'gte', value: 0.25 } : null,
                })
              }
            />
            <span>速度</span>
          </label>
          {conditions.speed ? (
            <>
              <select
                value={conditions.speed.op}
                onChange={(e) =>
                  ctx.patchConditions(transition.id, {
                    speed: {
                      ...conditions.speed!,
                      op: e.target.value as 'gte' | 'lte',
                    },
                  })
                }
              >
                <option value="gte">≥</option>
                <option value="lte">≤</option>
              </select>
              <input
                type="number"
                step={0.05}
                min={0}
                value={conditions.speed.value}
                onChange={(e) =>
                  ctx.patchConditions(transition.id, {
                    speed: {
                      ...conditions.speed!,
                      value: Number(e.target.value),
                    },
                  })
                }
              />
            </>
          ) : (
            <span className="hint small">不检查速度</span>
          )}
        </div>
        <div className="condition-row">
          <label className="switch inline">
            <input
              type="checkbox"
              checked={conditions.hurt !== null}
              onChange={(e) =>
                ctx.patchConditions(transition.id, {
                  hurt: e.target.checked ? true : null,
                })
              }
            />
            <span>受击</span>
          </label>
          {conditions.hurt !== null ? (
            <select
              value={conditions.hurt ? 'yes' : 'no'}
              onChange={(e) =>
                ctx.patchConditions(transition.id, { hurt: e.target.value === 'yes' })
              }
            >
              <option value="yes">要求受击中</option>
              <option value="no">要求非受击</option>
            </select>
          ) : (
            <span className="hint small">不检查受击</span>
          )}
        </div>
        <div className="condition-row">
          <label className="switch inline">
            <input
              type="checkbox"
              checked={conditions.attackTrigger}
              onChange={(e) =>
                ctx.patchConditions(transition.id, { attackTrigger: e.target.checked })
              }
            />
            <span>攻击触发 (被采用时消耗 1 次)</span>
          </label>
        </div>
      </fieldset>

      <div className="editor-footer">
        <button
          type="button"
          className={`btn danger ${confirming ? 'confirm' : ''}`}
          onClick={() => {
            if (!confirming) {
              setConfirming(true);
              return;
            }
            ctx.removeTransition(transition.id);
            setConfirming(false);
          }}
        >
          {confirming ? '确认删除?' : '删除过渡'}
        </button>
        <button
          type="button"
          className="btn muted"
          onClick={() => ctx.selectTransition(null)}
        >
          取消选择
        </button>
      </div>
    </div>
  );
}
