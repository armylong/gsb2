import { useState } from 'react';
import { useStudio, studio } from './studio/hooks';
import { buildPreviewFrame, previewTransitionStatuses } from './engine/preview';
import { Transport } from './components/Transport';
import { Stage } from './components/Stage';
import { RelationGraph, StateTimeline, EventKindLegend } from './components/Graph';
import { Inspector } from './components/Inspector';
import { LogPanel } from './components/LogPanel';
import { ConfigPanel } from './components/ConfigPanel';
import { ScenarioPanel } from './components/ScenarioPanel';

const actions = {
  toggleRun: () => studio.toggleRun(),
  step: () => studio.step(),
  reset: () => studio.reset(),
  setTimeScale: (scale: number) => studio.setTimeScale(scale),
  enterPreview: () => studio.enterPreview(),
  exitPreview: () => studio.exitPreview(),
  togglePreviewPlay: () => studio.togglePreviewPlay(),
  patchState: (id: string, patch: Parameters<typeof studio.patchState>[1]) =>
    studio.patchState(id, patch),
  patchEvent: (stateId: string, eventId: string, patch: Parameters<typeof studio.patchEvent>[2]) =>
    studio.patchEvent(stateId, eventId, patch),
  addEvent: (stateId: string) => studio.addEvent(stateId),
  removeEvent: (stateId: string, eventId: string) => studio.removeEvent(stateId, eventId),
  patchTransition: (id: string, patch: Parameters<typeof studio.patchTransition>[1]) =>
    studio.patchTransition(id, patch),
  patchConditions: (id: string, patch: Parameters<typeof studio.patchConditions>[1]) =>
    studio.patchConditions(id, patch),
  selectTransition: (id: string | null) => studio.selectTransition(id),
  addTransition: () => studio.addTransition(),
  removeTransition: (id: string) => studio.removeTransition(id),
  setSpeed: (value: number) => studio.setSpeed(value),
  setHurt: (value: boolean) => studio.setHurt(value),
  queueAttack: () => studio.queueAttack(),
  clearAttacks: () => studio.clearAttacks(),
  applyDraft: () => studio.applyDraft(),
  revertDraft: () => studio.revertDraft(),
  loadDemo: () => studio.loadDemo(),
  save: () => studio.save(),
  load: () => studio.load(),
  importText: (text: string) => studio.importText(text),
  draftText: () => studio.draftText(),
  dismissNotice: () => studio.dismissNotice(),
};

export function App() {
  const state = useStudio();
  const [tab, setTab] = useState<'inspector' | 'graph' | 'config' | 'scenarios'>('inspector');
  const previewFrame =
    state.mode === 'preview'
      ? buildPreviewFrame(state.config, state.preview.stateId, state.preview.timeMs)
      : null;
  const liveState = state.machine.state;
  // 预览模式下关系图也按预览时刻评估, 但状态机本身不受影响
  const graphStatuses = previewFrame
    ? previewTransitionStatuses(state.config, previewFrame.state, previewFrame.elapsedMs, {
        speed: state.machine.speed,
        hurt: state.machine.hurt,
        pendingAttacks: state.machine.pendingAttacks,
      }).statuses
    : state.machine.transitionStatuses;
  const currentDraftState =
    state.draft.states.find((s) => s.id === state.selectedStateId) ?? state.draft.states[0];

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">◈</span>
          <div>
            <h1>动画状态机工作室</h1>
            <p>几何角色 · 过渡条件 · 一次性触发 · 时间事件</p>
          </div>
        </div>
        <div className="header-meta">
          <span className={`mode-pill ${state.mode}`}>
            {state.mode === 'preview' ? '时间预览' : state.running ? '运行中' : '运行时就绪'}
          </span>
          <span className="clock">t = {formatMs(state.machine.clockMs)}</span>
          <span className="state-pill">
            {previewFrame ? `预览 ${previewFrame.state.name}` : liveState.name}
            <b>{Math.round((previewFrame?.progress ?? state.machine.progress) * 100)}%</b>
          </span>
        </div>
      </header>

      <Transport state={state} actions={actions} />

      <main className="layout">
        <section className="column stage-column">
          <Stage machine={state.machine} preview={previewFrame} mode={state.mode} />

          <div className="under-stage">
            <StateTimeline
              state={previewFrame?.state ?? liveState}
              elapsedMs={previewFrame?.elapsedMs ?? state.machine.elapsedMs}
              loopIndex={previewFrame?.loopIndex ?? state.machine.loopIndex}
              passedEventIds={previewFrame?.passedEventIds}
            />
            <EventKindLegend />
            <div className="quick-facts">
              <Fact label="当前状态" value={previewFrame ? previewFrame.state.name : liveState.name} />
              <Fact
                label="动作时间"
                value={`${Math.round(previewFrame?.elapsedMs ?? state.machine.elapsedMs)}ms / ${
                  (previewFrame?.state ?? liveState).durationMs
                }ms`}
              />
              <Fact
                label="循环圈数"
                value={`${(previewFrame?.loopIndex ?? state.machine.loopIndex) + 1}`}
              />
              <Fact
                label="攻击窗口"
                value={
                  state.mode === 'preview'
                    ? '预览不开启'
                    : state.machine.attackWindowOpen
                      ? '开启'
                      : '关闭'
                }
                tone={state.mode !== 'preview' && state.machine.attackWindowOpen ? 'hot' : undefined}
              />
              <Fact
                label="待处理攻击"
                value={`${state.machine.pendingAttacks}`}
                tone={state.machine.pendingAttacks > 0 ? 'hot' : undefined}
              />
              <Fact label="配置" value={state.config.name} />
            </div>
          </div>

          {state.mode === 'preview' ? (
            <PreviewControls
              state={state}
              onSeek={(value) => studio.seekPreview(value)}
              onPick={(id) => studio.setPreviewState(id)}
            />
          ) : null}

          <LogPanel state={state} />
        </section>

        <section className="column side-column">
          <div className="tabs main-tabs">
            <TabButton id="inspector" label="检查器" tab={tab} setTab={setTab} />
            <TabButton id="graph" label="关系图" tab={tab} setTab={setTab} />
            <TabButton id="config" label="配置" tab={tab} setTab={setTab} />
            <TabButton id="scenarios" label="示例验证" tab={tab} setTab={setTab} />
          </div>

          {tab === 'inspector' ? <Inspector state={state} ctx={actions} /> : null}
          {tab === 'graph' ? (
            <div className="panel graph-panel">
              <h2>状态关系图</h2>
              <p className="hint small">
                实线 = 当前满足条件的过渡; 虚线 = 条件未满足。金色 = 本周期首选过渡。
              </p>
              <RelationGraph
                config={state.config}
                currentStateId={state.mode === 'preview' ? state.preview.stateId : liveState.id}
                currentElapsedMs={
                  state.mode === 'preview'
                    ? (previewFrame?.elapsedMs ?? 0)
                    : state.machine.elapsedMs
                }
                currentDurationMs={
                  state.mode === 'preview'
                    ? (previewFrame?.state.durationMs ?? liveState.durationMs)
                    : liveState.durationMs
                }
                statuses={graphStatuses}
                selectedStateId={state.selectedStateId}
                selectedTransitionId={state.selectedTransitionId}
                onSelectState={(id) => studio.selectState(id)}
                onSelectTransition={(id) => studio.selectTransition(id)}
                mode={state.mode}
              />
              <div className="graph-legend">
                <span><i className="line available" />可用</span>
                <span><i className="line blocked" />不可用</span>
                <span><i className="line winner" />首选</span>
              </div>
              <div className="state-list">
                {state.config.states.map((s) => (
                  <button
                    type="button"
                    key={s.id}
                    className={`state-chip ${s.id === liveState.id ? 'current' : ''} ${
                      s.id === state.selectedStateId ? 'selected' : ''
                    }`}
                    onClick={() => studio.selectState(s.id)}
                  >
                    <b>{s.name}</b>
                    <span>{s.durationMs}ms{s.loop ? ' · 循环' : ''}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {tab === 'config' ? <ConfigPanel state={state} actions={actions} /> : null}
          {tab === 'scenarios' ? (
            <ScenarioPanel state={state} onRestoreDemo={() => studio.loadDemo()} />
          ) : null}

          {currentDraftState && tab === 'graph' ? (
            <div className="panel">
              <h2>{currentDraftState.name} · 事件</h2>
              <ul className="event-summary">
                {currentDraftState.events.map((event) => (
                  <li key={event.id}>
                    <span className={`dot kind-${event.kind}`} />
                    {event.name}
                    <code>{event.timeMs}ms</code>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      </main>

      <footer className="app-footer">
        <span>确定性时间步 · 单周期最多一次切换 · 事件按时间顺序逐条消费 · 预览零副作用</span>
        <span>状态 {state.config.states.length} · 过渡 {state.config.transitions.length}</span>
      </footer>
    </div>
  );
}

function TabButton({
  id,
  label,
  tab,
  setTab,
}: {
  id: 'inspector' | 'graph' | 'config' | 'scenarios';
  label: string;
  tab: string;
  setTab: (value: 'inspector' | 'graph' | 'config' | 'scenarios') => void;
}) {
  return (
    <button
      type="button"
      className={tab === id ? 'tab active' : 'tab'}
      onClick={() => setTab(id)}
    >
      {label}
    </button>
  );
}

function Fact({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'hot';
}) {
  return (
    <div className={`fact ${tone ?? ''}`}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function PreviewControls({
  state,
  onSeek,
  onPick,
}: {
  state: ReturnType<typeof useStudio>;
  onSeek: (value: number) => void;
  onPick: (id: string) => void;
}) {
  const frame = buildPreviewFrame(state.config, state.preview.stateId, state.preview.timeMs);
  const stateOptions = state.config.states;
  return (
    <div className="preview-controls">
      <div className="preview-row">
        <label className="field">
          <span>预览状态</span>
          <select value={state.preview.stateId} onChange={(e) => onPick(e.target.value)}>
            {stateOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field grow">
          <span>
            时间线 {Math.round(state.preview.timeMs)}ms
            {frame.state.loop ? ` (第 ${frame.loopIndex + 1} 圈, 局部 ${frame.elapsedMs}ms)` : ''}
          </span>
          <input
            type="range"
            min={0}
            max={frame.state.loop ? frame.state.durationMs * 3 : frame.state.durationMs}
            step={10}
            value={state.preview.timeMs}
            onChange={(e) => onSeek(Number(e.target.value))}
          />
        </label>
      </div>
      <div className="preview-events">
        {frame.state.events.map((event) => (
          <span
            key={event.id}
            className={`event-pill kind-${event.kind} ${
              frame.passedEventIds.includes(event.id) ? 'passed' : ''
            }`}
          >
            {event.name} <code>{event.timeMs}ms</code>
          </span>
        ))}
      </div>
      <p className="hint small">
        预览只展示形状与事件位置: 不触发攻击窗口, 不消耗待处理攻击, 不写事件记录。
      </p>
    </div>
  );
}

function formatMs(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}
