import { useMemo, useState } from 'react';
import { SCENARIOS } from '../game/scenarios.ts';
import { useStore } from '../game/store.tsx';
import type { ScenarioId } from '../game/types.ts';
import { RoundView } from './RoundView.tsx';
import { ScoreBoard } from './ScoreBoard.tsx';
import type { ViewAs } from '../game/permissions.ts';

const SCENARIO_ORDER: ScenarioId[] = [
  'collisionPrimary',
  'collisionBackup',
  'tieScore',
  'sandbox',
];

export function App() {
  const { state, saved, dispatch } = useStore();
  const [viewAs, setViewAs] = useState<ViewAs>('A');
  const [seedInput, setSeedInput] = useState(String(SCENARIOS.sandbox.seed));

  const round = state?.rounds[state.currentRound] ?? null;
  const scenario = state ? SCENARIOS[state.scenarioId] : null;

  const load = (scenarioId: ScenarioId, seed?: number) =>
    dispatch({ type: 'loadScenario', scenarioId, seed });

  const seedControl = useMemo(
    () => (
      <span className="seed-row">
        种子
        <input
          value={seedInput}
          onChange={(e) => setSeedInput(e.target.value.replace(/[^0-9]/g, ''))}
          inputMode="numeric"
        />
        <button
          className="btn"
          onClick={() => load('sandbox', Number(seedInput || '0'))}
        >
          按种子重建沙盒
        </button>
      </span>
    ),
    [seedInput],
  );

  if (!state || !round || !scenario) {
    return (
      <div className="app">
        <div className="empty">
          <h1 style={{ fontSize: 22 }}>标本轮选试验台</h1>
          <p>三队每轮在同一桌标本上各提交一个首选与一个备用，全部确认后开牌。</p>
          <p style={{ fontSize: 13 }}>
            撞选按本轮优先顺序处理，优先顺序每轮轮换；结果与自动队伍的选择都由种子决定，可重复。
          </p>
          <div className="scenario-pick">
            {SCENARIO_ORDER.map((id) => (
              <button key={id} className="btn primary" onClick={() => load(id)}>
                {SCENARIOS[id].label}
              </button>
            ))}
          </div>
          {saved && (
            <p style={{ marginTop: 26, fontSize: 13 }}>
              <span className="badge saved">检测到本地存档</span>
              <button
                className="btn"
                style={{ marginLeft: 10 }}
                onClick={() => {
                  const raw = localStorage.getItem('specimen-draft:save:v1');
                  if (raw) dispatch({ type: 'hydrate', state: JSON.parse(raw) });
                }}
              >
                恢复存档
              </button>
              <button
                className="btn danger"
                style={{ marginLeft: 8 }}
                onClick={() => dispatch({ type: 'clearSave' })}
              >
                删除存档
              </button>
            </p>
          )}
        </div>
      </div>
    );
  }

  const revealed = round.log !== null;
  const gameDone = state.currentRound + 1 >= state.rounds.length;

  return (
    <div className="app">
      <div className="topbar">
        <h1>标本轮选试验台</h1>
        <span className="badge">{scenario.label}</span>
        {saved && <span className="badge saved">已本地保存</span>}
        <div className="scenario-row">
          <span className="view-switch">
            视角
            <select value={viewAs} onChange={(e) => setViewAs(e.target.value as ViewAs)}>
              <option value="A">红隼队 A（手动）</option>
              <option value="B">蓝雀队 B（自动·择高分）</option>
              <option value="C">绿蜥队 C（自动·凑成套）</option>
              <option value="public">公共信息视角</option>
            </select>
          </span>
          {state.scenarioId === 'sandbox' && seedControl}
          <select
            value={state.scenarioId}
            onChange={(e) => load(e.target.value as ScenarioId)}
          >
            {SCENARIO_ORDER.map((id) => (
              <option key={id} value={id}>
                {SCENARIOS[id].label}
              </option>
            ))}
          </select>
          <button className="btn danger" onClick={() => dispatch({ type: 'clearSave' })}>
            清空存档
          </button>
        </div>
        <div className="sub">{scenario.description}</div>
      </div>

      <div className="overview">
        <div className="card">
          <h2>
            轮次
            <span className="round-tabs">
              {state.rounds.map((r) => (
                <button
                  key={r.index}
                  className={`round-tab ${r.index === state.currentRound ? 'active' : ''}`}
                  onClick={() => dispatch({ type: 'hydrate', state: { ...state, currentRound: r.index } })}
                >
                  第 {r.index + 1} 轮{r.log ? '（已开牌）' : ''}
                </button>
              ))}
            </span>
          </h2>
          <p className="meta-line">
            种子 <span className="fingerprint">{state.seed}</span>
            {state.fingerprint && (
              <>
                {' '}· 上次开牌指纹 <span className="fingerprint">{state.fingerprint}</span>
                {' '}（同种子同选择重复开牌指纹一致）
              </>
            )}
          </p>
          <p className="meta-line">
            当前阶段：{revealed ? '已开牌——全部选择与分配来由公开' : '开选前——只能看到公共信息与本队选择'}
          </p>
          <div className="priority-strip">
            {round.priority.map((id, i) => {
              const team = state.teams.find((t) => t.id === id)!;
              return (
                <span
                  key={id}
                  className="priority-chip"
                  style={{ background: team.color }}
                  title={`第 ${i + 1} 优先`}
                >
                  <span className="ord">{i + 1}</span>
                  {team.label}
                </span>
              );
            })}
          </div>
          <p className="meta-line">
            优先顺序每轮整体左旋一位；本轮撞选按上面顺序逐队处理。
          </p>
        </div>
      </div>

      <RoundView round={round} viewAs={viewAs} />

      <div className="reveal-banner">
        {!revealed && (
          <button
            className="btn primary"
            disabled={!allTeamsConfirmed(round)}
            onClick={() => dispatch({ type: 'reveal' })}
            title={allTeamsConfirmed(round) ? '' : '三队全部确认后才能开牌'}
          >
            开牌
          </button>
        )}
        {!revealed && !allTeamsConfirmed(round) && (
          <span className="meta-line">等待三队全部确认……</span>
        )}
        {revealed && !gameDone && (
          <button className="btn primary" onClick={() => dispatch({ type: 'nextRound' })}>
            进入第 {state.currentRound + 2} 轮
          </button>
        )}
        {revealed && gameDone && <span className="badge">全部轮次结束</span>}
      </div>

      <ScoreBoard />
    </div>
  );
}

function allTeamsConfirmed(round: { choices: Record<string, { confirmed: boolean }> }): boolean {
  return Object.values(round.choices).every((c) => c.confirmed);
}
