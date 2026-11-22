import type { LabState } from '../state/reducer';
import { computeStandings, tierLabel } from '../game/scoring';
import type { TeamId } from '../game/types';
import { teamById } from '../format';

interface Props {
  state: LabState;
}

export function StandingsPanel({ state }: Props) {
  const { game } = state;
  const standings = computeStandings(game.history);
  const last = game.history[game.history.length - 1] ?? null;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>积分榜</h2>
        <span className="sub">
          {standings.roundsPlayed === 0 ? '未开局' : `已结算 ${standings.roundsPlayed} 轮`}
        </span>
      </div>

      <div className="panel-body tight">
        <table className="cat-table">
          <thead>
            <tr>
              <th>队伍</th>
              <th className="num">件数</th>
              <th className="num">本体</th>
              <th className="num">成套</th>
              <th className="num">总分</th>
            </tr>
          </thead>
          <tbody>
            {standings.scores.map((score) => {
              const team = teamById(game.teams, score.teamId);
              const leading = standings.roundsPlayed > 0 && score.total === standings.topScore;
              return (
                <tr key={score.teamId}>
                  <td>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span
                        className="team-sigil"
                        style={{ background: team.color, width: 20, height: 20, fontSize: 10 }}
                      >
                        {team.sigil}
                      </span>
                      {team.name}
                      {leading && standings.isTie && <span className="chip warn">平</span>}
                    </span>
                  </td>
                  <td className="num">{score.count}</td>
                  <td className="num">{score.baseTotal}</td>
                  <td className="num">{score.setBonusTotal > 0 ? `+${score.setBonusTotal}` : '0'}</td>
                  <td className="num">
                    <strong>{score.total}</strong>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {standings.roundsPlayed === 0 ? (
          <p className="empty-note" style={{ marginTop: 12 }}>
            开牌后这里显示累计得分。
          </p>
        ) : standings.isTie ? (
          <div className="chip warn" style={{ marginTop: 10 }}>
            当前平分：{standings.tiedTeamIds.map((id) => teamById(game.teams, id).name).join('、')}（各{' '}
            {standings.topScore} 分）
          </div>
        ) : (
          <div className="chip good" style={{ marginTop: 10 }}>
            领先：{teamById(game.teams, standings.tiedTeamIds[0] as TeamId).name} ·{' '}
            {standings.topScore} 分
          </div>
        )}

        {last && (
          <div style={{ marginTop: 14 }}>
            <div className="section-label">当前成套</div>
            <div style={{ display: 'grid', gap: 6 }}>
              {standings.scores.map((score) => {
                const sets = score.categories.filter((entry) => entry.tier !== 'none');
                const team = teamById(game.teams, score.teamId);
                return (
                  <div key={score.teamId} style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>
                    <strong style={{ color: 'var(--ink)' }}>{team.name}</strong>：
                    {sets.length === 0
                      ? '尚无成套'
                      : sets
                          .map((entry) => `${entry.category} ${entry.count} 件（${tierLabel(entry.tier)} +${entry.totalBonus}）`)
                          .join('；')}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
