import type { LabState } from '../state/reducer';
import { computeStandings, tierLabel } from '../game/scoring';
import type { TeamScore } from '../game/types';
import { teamById } from '../format';

interface Props {
  state: LabState;
}

export function ScorePanel({ state }: Props) {
  const { game } = state;
  const standings = computeStandings(game.history);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>计分</h2>
        <span className="sub">
          已结算 {standings.roundsPlayed} 轮 · 同品类满 2 / 3 / 4 件，每件 +2 / +5 / +8
        </span>
      </div>
      <div className="panel-body">
        {standings.roundsPlayed === 0 ? (
          <p className="empty-note">尚未开牌，还没有可结算的标本。</p>
        ) : (
          <>
            <div>
              {standings.scores.map((score) => (
                <ScoreCard key={score.teamId} score={score} state={state} />
              ))}
            </div>
            <p className="action-hint" style={{ marginTop: 8 }}>
              点开任一件标本可看到它的计分来由；每队的分类表列出成套如何触发。
            </p>
          </>
        )}
      </div>
    </section>
  );
}

function ScoreCard({ score, state }: { score: TeamScore; state: LabState }) {
  const team = teamById(state.game.teams, score.teamId);
  if (score.count === 0) {
    return (
      <details className="score-card">
        <summary className="score-head">
          <div className="left">
            <span className="team-sigil" style={{ background: team.color }}>
              {team.sigil}
            </span>
            <strong>{team.name}</strong>
            <span className="chip plain">尚无标本</span>
          </div>
          <span className="score-total">0</span>
        </summary>
        <div className="score-body">
          <p className="empty-note">本轮或此前数轮都没有拿到标本，计分从 0 起算。</p>
        </div>
      </details>
    );
  }

  return (
    <details className="score-card">
      <summary className="score-head">
        <div className="left">
          <span className="team-sigil" style={{ background: team.color }}>
            {team.sigil}
          </span>
          <strong>{team.name}</strong>
          <span className="chip plain">{score.count} 件</span>
          {score.categories
            .filter((entry) => entry.tier !== 'none')
            .map((entry) => (
              <span key={entry.category} className="chip good">
                {entry.category} {entry.count} 件 · {tierLabel(entry.tier)} +{entry.totalBonus}
              </span>
            ))}
        </div>
        <span className="score-total">
          {score.total}
          <span className="unit">分</span>
        </span>
      </summary>
      <div className="score-body">
        <div className="score-summary">
          <span>
            本体合计 <b>{score.baseTotal}</b>
          </span>
          <span>
            成套加成 <b>{score.setBonusTotal}</b>
          </span>
          <span>
            总分 <b>{score.total}</b>
          </span>
        </div>

        <table className="cat-table">
          <thead>
            <tr>
              <th>品类</th>
              <th>件数</th>
              <th>成套</th>
              <th className="num">每件加成</th>
              <th className="num">小计</th>
            </tr>
          </thead>
          <tbody>
            {score.categories.map((entry) => (
              <tr key={entry.category}>
                <td>{entry.category}</td>
                <td>{entry.count}</td>
                <td>
                  {entry.tier === 'none' ? (
                    <span className="chip plain">未成套</span>
                  ) : (
                    <span className="chip good">{tierLabel(entry.tier)}</span>
                  )}
                </td>
                <td className="num">{entry.perItemBonus > 0 ? `+${entry.perItemBonus}` : '—'}</td>
                <td className="num">{entry.totalBonus > 0 ? `+${entry.totalBonus}` : '0'}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="section-label">逐件计分</div>
        <div className="item-list">
          {score.items.map((item) => (
            <details key={item.specimenId} className="item">
              <summary>
                <span className="glyph" style={{ width: 24, height: 24, fontSize: 13 }}>
                  {item.glyph}
                </span>
                <span>{item.name}</span>
                <span className="chip plain">{item.category}</span>
                <span className={`chip ${item.via === 'primary' ? 'warn' : 'plain'}`}>
                  {item.via === 'primary' ? '首选' : '备用'}
                </span>
                <span className="chip plain">第 {item.acquiredRound + 1} 轮</span>
                <span className="item-total">
                  {item.base}
                  {item.setBonus > 0 && <span className="bonus"> + {item.setBonus}</span>} ={' '}
                  {item.total}
                </span>
              </summary>
              <div className="item-body">
                <ol className="reason-list">
                  {item.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ol>
              </div>
            </details>
          ))}
        </div>
      </div>
    </details>
  );
}
