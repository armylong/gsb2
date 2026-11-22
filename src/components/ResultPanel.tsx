import type { LabState } from '../state/reducer';
import type { ScenarioRound } from '../game/types';
import { describeMiss, specimenName, teamById } from '../format';

interface Props {
  state: LabState;
  round: ScenarioRound;
}

export function ResultPanel({ state, round }: Props) {
  const { game } = state;
  const result = game.history[game.history.length - 1];
  if (!result) return null;

  const assignmentByTeam = new Map(result.assignments.map((entry) => [entry.teamId, entry]));
  const missByTeam = new Map(result.misses.map((entry) => [entry.teamId, entry]));

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>裁定明细 · 第 {result.roundIndex + 1} 轮</h2>
        <span className="sub">
          {result.assignments.length} 件成交 · {result.misses.length} 队落空 ·{' '}
          {result.priority.map((teamId) => teamById(game.teams, teamId).name).join(' → ')}
        </span>
      </div>

      <div className="result-block">
        <p className="result-lede">
          裁定分两遍：先按优先顺序处理所有首选，再按同一顺序处理未得到首选者的备用。
          备用只能从仍留在桌上的标本里取。
        </p>

        <div className="section-label">成交</div>
        {result.assignments.length === 0 ? (
          <p className="empty-note">本轮没有任何球队拿到标本。</p>
        ) : (
          <ol className="assignment-list">
            {result.assignments.map((entry) => {
              const team = teamById(game.teams, entry.teamId);
              return (
                <li key={`${entry.teamId}-${entry.specimenId}`} className="assignment-row">
                  <span className="idx">#{entry.order}</span>
                  <span className="team-sigil" style={{ background: team.color, width: 22, height: 22, fontSize: 11 }}>
                    {team.sigil}
                  </span>
                  <strong>{team.name}</strong>
                  <span>获得「{specimenName(round.table, entry.specimenId)}」</span>
                  <span className={`chip ${entry.via === 'primary' ? 'warn' : 'plain'}`}>
                    {entry.via === 'primary' ? '首选命中' : '备用递补'}
                  </span>
                </li>
              );
            })}
          </ol>
        )}

        <div className="section-label">落空记录</div>
        {result.misses.length === 0 ? (
          <p className="empty-note">本轮三队各有归属，没有落空。</p>
        ) : (
          <ul className="miss-list">
            {result.misses.map((miss) => {
              const copy = describeMiss(miss, result, game.teams);
              return (
                <li key={miss.teamId} className="miss-row">
                  <div className="title">{copy.title}</div>
                  <div className="detail">{copy.detail}</div>
                </li>
              );
            })}
          </ul>
        )}

        <div className="section-label">逐队核对</div>
        <div className="item-list">
          {result.priority.map((teamId, index) => {
            const team = teamById(game.teams, teamId);
            const assignment = assignmentByTeam.get(teamId);
            const miss = missByTeam.get(teamId);
            const choice = result.choices[teamId];
            return (
              <div key={teamId} className="score-card" style={{ marginBottom: 0 }}>
                <div className="score-head" style={{ cursor: 'default' }}>
                  <div className="left">
                    <span className="idx" style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5 }}>
                      优先位 {index + 1}
                    </span>
                    <span className="team-sigil" style={{ background: team.color, width: 24, height: 24, fontSize: 12 }}>
                      {team.sigil}
                    </span>
                    <strong>{team.name}</strong>
                  </div>
                  <div className="score-meta">
                    <span className="chip plain">
                      首选 {specimenName(round.table, choice.primary)}
                    </span>
                    <span className="chip plain">
                      备用 {choice.backup ? specimenName(round.table, choice.backup) : '未选'}
                    </span>
                    {assignment ? (
                      <span className="chip good">
                        → {specimenName(round.table, assignment.specimenId)}（
                        {assignment.via === 'primary' ? '首选' : '备用'}）
                      </span>
                    ) : (
                      <span className="chip bad">
                        {miss?.reason === 'no-backup' ? '没有合适备选' : '备用已被别人拿走'}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <details className="item" style={{ marginTop: 12 }}>
          <summary>
            <span>裁定流水</span>
            <span className="item-total">{result.trace.length} 步</span>
          </summary>
          <div className="item-body">
            <div className="trace-list">
              {result.trace.map((event, index) => (
                <div key={`${event.teamId}-${event.pass}-${index}`} className="trace-row">
                  <span className={`pass${event.pass === 'backup' ? ' backup' : ''}`}>
                    {event.pass === 'primary' ? '首选' : '备用'}
                  </span>
                  <span>{teamById(game.teams, event.teamId).name}</span>
                  {event.outcome === 'no-request' && <span>未提交</span>}
                  {event.specimenId && (
                    <span>
                      「{specimenName(round.table, event.specimenId)}」
                      {event.outcome === 'granted' && <span className="chip good"> 归此队</span>}
                      {event.outcome === 'taken' && event.takenBy && (
                        <span className="chip plain"> 已被{teamById(game.teams, event.takenBy).name}取走</span>
                      )}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </details>
      </div>
    </section>
  );
}
