import { useEffect, useMemo, useReducer, useState } from 'react';
import { createInitialState, labReducer } from './state/reducer';
import { getBrowserStorage } from './state/storageAdapter';
import { Masthead } from './components/Masthead';
import { ScenarioPanel } from './components/ScenarioPanel';
import { RoundPanel } from './components/RoundPanel';
import { TeamsPanel } from './components/TeamsPanel';
import { ResultPanel } from './components/ResultPanel';
import { ScorePanel } from './components/ScorePanel';
import { SavesPanel } from './components/SavesPanel';
import { StandingsPanel } from './components/StandingsPanel';
import { getScenario } from './game/scenarios';
import { currentRound } from './game/engine';

export default function App() {
  const storage = useMemo(() => getBrowserStorage(), []);
  const [state, dispatch] = useReducer(labReducer, storage, createInitialState);
  const [seedDraft, setSeedDraft] = useState<string>('');

  const game = state.game;
  const scenario = getScenario(game.scenarioId);
  const round = currentRound(game);
  const isLast = game.roundIndex >= game.rounds.length - 1;

  useEffect(() => {
    setSeedDraft(String(game.seed));
  }, [game.seed, game.scenarioId]);

  useEffect(() => {
    if (!state.notice) return;
    const timer = window.setTimeout(() => dispatch({ type: 'clear-notice' }), 6000);
    return () => window.clearTimeout(timer);
  }, [state.notice]);

  return (
    <div className="app">
      <Masthead
        state={state}
        seedDraft={seedDraft}
        onSeedDraft={setSeedDraft}
        dispatch={dispatch}
      />

      {state.notice && <NoticeBar notice={state.notice} dispatch={dispatch} />}

      <div className="layout">
        <div className="stack">
          <ScenarioPanel scenario={scenario} game={game} viewer={state.viewer} />
          <RoundPanel state={state} dispatch={dispatch} round={round} />
          <TeamsPanel state={state} dispatch={dispatch} />
          {game.phase === 'opened' && (
            <ResultPanel state={state} round={round} />
          )}
          <ScorePanel state={state} />
        </div>

        <div className="stack">
          <StandingsPanel state={state} />
          <SavesPanel state={state} dispatch={dispatch} storage={storage} />
          <aside className="panel">
            <div className="panel-head">
              <h2>规则速览</h2>
            </div>
            <div className="panel-body tight">
              <RulesSummary />
            </div>
          </aside>
        </div>
      </div>

      <footer className="footnote">
        本地试验页：数据仅存于当前浏览器的 localStorage。开选前各队只能看到自己的选择；
        开牌后选择、裁定与计分全部公开。所有随机都来自当前种子，同种子同选择必然复现。
        {isLast && game.phase === 'opened' ? ' 本轮为终局。' : ''}
      </footer>
    </div>
  );
}

function RulesSummary() {
  return (
    <ul className="highlights">
      <li>每队每轮提交一个首选与一个备用，全部确认后才开牌。</li>
      <li>先按本轮优先顺序裁定首选；未拿到首选的队再按同一顺序裁定备用。</li>
      <li>备用不能抢走已经分出的标本；同一件标本至多给一个队。</li>
      <li>优先顺序每轮轮换一位，三队循环。</li>
      <li>同品类满 2 / 3 / 4 件时，每件分别 +2 / +5 / +8。</li>
    </ul>
  );
}

function NoticeBar({
  notice,
  dispatch,
}: {
  notice: { kind: 'info' | 'error'; text: string };
  dispatch: (action: { type: 'clear-notice' }) => void;
}) {
  return (
    <div
      className={`notice notice-inline${notice.kind === 'error' ? ' error' : ''}`}
      role="status"
    >
      <span>{notice.text}</span>
      <button
        type="button"
        className="btn btn-ghost btn-small dismiss"
        onClick={() => dispatch({ type: 'clear-notice' })}
        aria-label="关闭提示"
      >
        关闭
      </button>
    </div>
  );
}
